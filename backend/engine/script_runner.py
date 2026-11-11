"""Free-form Python script runner for the Production Gateway Script Lab.

Scripts run in-process with full built-ins (imports allowed) and a small
pre-seeded namespace:

- dataiki: DataikiRuntimeSDK (models(), model(name, version), predict_frame(df), vault)
- pl / np / duckdb / json / datetime / Path

Returns captured stdout, an optional JSON-safe preview of the script's
`result` variable, duration, and traceback on failure.
"""

from __future__ import annotations

import contextlib
import datetime
import json
import time
import traceback
from pathlib import Path
from typing import Any, Dict

import duckdb
import numpy as np
import polars as pl

from backend.database import get_db
from backend.engine.runtime_sdk import DataikiRuntimeSDK

MAX_OUTPUT_CHARS = 64_000
MAX_RESULT_CHARS = 2_000


class _CappedWriter:
    """stdout sink that stops growing after a hard character limit."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.parts: list[str] = []
        self.size = 0
        self.truncated = False

    def write(self, text: str) -> int:
        if not text:
            return 0
        remaining = self.limit - self.size
        if remaining > 0:
            self.parts.append(text[:remaining])
            self.size += min(len(text), remaining)
        if len(text) > remaining:
            self.truncated = True
        return len(text)

    def flush(self) -> None:
        return None

    def getvalue(self) -> str:
        value = "".join(self.parts)
        if self.truncated:
            value += "\n[output truncated at 64 KB]"
        return value


def _preview_result(value: Any) -> str:
    """Serialize a script `result` variable into a short JSON-safe preview."""
    if value is None:
        return ""
    try:
        if isinstance(value, pl.DataFrame):
            text = value.head(20).write_json()
            meta = f" (shape={value.height}x{value.width}, showing 20 rows)"
        elif isinstance(value, np.ndarray):
            text = json.dumps(value.tolist(), default=str)
            meta = f" (ndarray shape={value.shape})"
        else:
            text = json.dumps(value, default=repr)
            meta = ""
    except Exception:
        text = repr(value)
        meta = ""
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + "...[truncated]"
    return f"{text}{meta}"


def run_script_code(project_key: str, code: str) -> Dict[str, Any]:
    """Execute a free-form script and return its console output."""
    started = time.perf_counter()
    executed_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    writer = _CappedWriter(MAX_OUTPUT_CHARS)

    namespace: Dict[str, Any] = {
        "dataiki": DataikiRuntimeSDK(project_key),
        "pl": pl,
        "np": np,
        "duckdb": duckdb,
        "json": json,
        "datetime": datetime,
        "Path": Path,
        "__builtins__": __builtins__,
    }

    status = "success"
    error = ""
    with contextlib.redirect_stdout(writer):
        try:
            exec(code, namespace)
        except Exception:
            status = "error"
            error = traceback.format_exc(limit=8)

    return {
        "status": status,
        "stdout": writer.getvalue(),
        "result_preview": _preview_result(namespace.get("result")),
        "error": error,
        "duration_ms": round((time.perf_counter() - started) * 1000, 1),
        "executed_at": executed_at,
    }


def run_freestyle_script(script_id: str) -> Dict[str, Any]:
    """Scheduler entrypoint: run a saved script and persist its last run state."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM freestyle_scripts WHERE script_id = ?",
            (script_id,),
        ).fetchone()

    if not row:
        raise KeyError(f"Freestyle script '{script_id}' not found.")

    outcome = run_script_code(row["project_key"], row["code"] or "")
    last_status = "success" if outcome["status"] == "success" else "failed"
    last_output = outcome["stdout"]
    if outcome["result_preview"]:
        last_output = f"{last_output}\n[result] {outcome['result_preview']}".strip()

    with get_db() as conn:
        conn.execute(
            """
            UPDATE freestyle_scripts
            SET last_run_at = ?, last_status = ?, last_error = ?, last_output = ?
            WHERE script_id = ?
            """,
            (
                outcome["executed_at"],
                last_status,
                outcome["error"],
                last_output,
                script_id,
            ),
        )

    return {
        "script_id": script_id,
        "script_name": row["script_name"],
        "status": last_status,
        "stdout": outcome["stdout"],
        "result_preview": outcome["result_preview"],
        "error": outcome["error"],
        "duration_ms": outcome["duration_ms"],
        "executed_at": outcome["executed_at"],
    }
