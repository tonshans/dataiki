"""Dataiki Flow Group Runner.

Executes a named sub-DAG snapshot (flow group) independently of the full project DAG.
Supports optional input payload injection and returns a preview of the output node.

Architecture:
- Flow groups store a frozen PipelineDAG snapshot (sub_dag_json) in the registry DB.
- The runner deserializes the snapshot, optionally seeds the input node from a payload,
  then delegates all node execution to the existing dag_runner.execute_dag() machinery.
- Results are cached under CACHE_DIR / 'group__<group_id>' / <node_id>.parquet.
- Output is read from the designated output_node_id and returned as a summary dict.
"""

from __future__ import annotations

import datetime
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import polars as pl

from backend.config import CACHE_DIR
from backend.database import get_db
from backend.engine.dag_runner import execute_dag
from backend.schemas import NodeConfig, PipelineDAG

logger = logging.getLogger("dataiki.flow_group_runner")

# Subdirectory prefix for group-scoped Parquet caches
_GROUP_CACHE_PREFIX = "group"


def _group_cache_dir(group_id: str) -> Path:
    """Return the Parquet cache directory for a specific flow group."""
    return CACHE_DIR / _GROUP_CACHE_PREFIX / group_id


def run_flow_group(
    group_id: str,
    input_payload: Optional[Dict[str, Any]] = None,
    output_format: str = "json",
) -> Dict[str, Any]:
    """Execute a named flow group sub-DAG and return the output node's data.

    Args:
        group_id: Identifier of the flow group in the registry DB.
        input_payload: Optional dict of records to inject into the input node.
            If the group has ``input_node_id`` set and this value is non-empty,
            the data is written to a temporary Parquet cache before execution.
        output_format: ``'json'`` returns up to 50 preview rows as a list of
            dicts; ``'summary'`` returns only row/column counts.

    Returns:
        Dict with keys:
            ``status`` (``'success'`` | ``'error'``),
            ``rows``, ``columns``, ``preview`` (list of dicts, format='json'),
            ``output_summary`` (str, format='summary'),
            ``error`` (str, only on failure),
            ``group_id``, ``group_name``.

    Raises:
        KeyError: When ``group_id`` is not found in the DB.
    """
    input_payload = input_payload or {}

    # ------------------------------------------------------------------
    # 1. Load group metadata from DB
    # ------------------------------------------------------------------
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM flow_groups WHERE group_id = ?",
            (group_id,),
        ).fetchone()

    if not row:
        raise KeyError(f"Flow group '{group_id}' not found.")

    group_name = row["group_name"]
    output_node_id = row["output_node_id"]
    input_node_id = row["input_node_id"] or None

    try:
        sub_dag_data = json.loads(row["sub_dag_json"] or "{}")
    except Exception:
        sub_dag_data = {}

    # Mark as running
    run_ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with get_db() as conn:
        conn.execute(
            "UPDATE flow_groups SET last_status = 'running', last_run_at = ?, last_error = '' WHERE group_id = ?",
            (run_ts, group_id),
        )

    try:
        # --------------------------------------------------------------
        # 2. Deserialize sub-DAG snapshot
        # --------------------------------------------------------------
        sub_dag = PipelineDAG.model_validate(sub_dag_data)

        # Build a virtual project key so dag_runner caches are isolated per group
        virtual_project_key = f"{_GROUP_CACHE_PREFIX}__{group_id}"
        group_dir = _group_cache_dir(group_id)
        group_dir.mkdir(parents=True, exist_ok=True)

        # --------------------------------------------------------------
        # 3. Inject input payload (if configured)
        # --------------------------------------------------------------
        if input_node_id and input_payload:
            # Convert payload to Polars DataFrame
            if isinstance(input_payload, list):
                # List of records: [{col: val, ...}, ...]
                payload_df = pl.DataFrame(input_payload)
            elif isinstance(input_payload, dict):
                # Either columnar {col: [v1, v2]} or single record {col: val}
                first_v = next(iter(input_payload.values()), None)
                if isinstance(first_v, list):
                    payload_df = pl.DataFrame(input_payload)
                else:
                    # Single record → wrap in list
                    payload_df = pl.DataFrame([input_payload])
            else:
                payload_df = pl.DataFrame()

            if not payload_df.is_empty():
                inject_path = group_dir / f"{input_node_id}.parquet"
                payload_df.write_parquet(inject_path)
                logger.info(
                    "Flow group '%s': injected %d rows into input node '%s'.",
                    group_id, payload_df.height, input_node_id,
                )

                # Patch the input node to ingest the injected Parquet cache so
                # dag_runner picks it up transparently.
                patched_nodes: List[NodeConfig] = []
                for n in sub_dag.nodes:
                    if n.node_id == input_node_id:
                        if n.node_type != "ingestion":
                            raise ValueError(
                                f"Input node '{input_node_id}' must be an ingestion node "
                                f"(got '{n.node_type}') to receive input_payload."
                            )
                        patched_params = dict(n.params or {})
                        patched_params["source_type"] = "local_file"
                        patched_params["file_path"] = inject_path.as_posix()
                        patched_nodes.append(n.model_copy(update={"params": patched_params}))
                    else:
                        patched_nodes.append(n)
                sub_dag = PipelineDAG(
                    project_key=sub_dag.project_key,
                    nodes=patched_nodes,
                    edges=sub_dag.edges,
                )

        # --------------------------------------------------------------
        # 4. Execute sub-DAG via existing dag_runner machinery
        # --------------------------------------------------------------
        results = execute_dag(
            project_key=virtual_project_key,
            dag=sub_dag,
            target_node_id=output_node_id,
            run_sinks=False,          # Groups do not write to external sinks
        )

        # --------------------------------------------------------------
        # 6. Read output node result
        # --------------------------------------------------------------
        output_parquet = CACHE_DIR / virtual_project_key / f"{output_node_id}.parquet"
        if not output_parquet.exists():
            raise FileNotFoundError(
                f"Output node '{output_node_id}' did not produce a Parquet file "
                f"after executing flow group '{group_id}'."
            )

        result_df = pl.read_parquet(output_parquet)
        n_rows = result_df.height
        n_cols = result_df.width
        col_names = result_df.columns

        summary_str = f"{n_rows} rows × {n_cols} cols — [{', '.join(col_names[:8])}{'...' if n_cols > 8 else ''}]"

        # Update DB with success
        with get_db() as conn:
            conn.execute(
                """
                UPDATE flow_groups
                SET last_status = 'success',
                    last_output_summary = ?
                WHERE group_id = ?
                """,
                (summary_str, group_id),
            )

        # Build response
        response: Dict[str, Any] = {
            "status": "success",
            "group_id": group_id,
            "group_name": group_name,
            "rows": n_rows,
            "columns": n_cols,
            "output_summary": summary_str,
        }

        if output_format == "json":
            preview_df = result_df.head(50)
            response["preview"] = preview_df.to_dicts()
        else:
            response["preview"] = []

        return response

    except Exception as exc:
        err_msg = str(exc)
        logger.exception("Flow group '%s' failed: %s", group_id, err_msg)
        with get_db() as conn:
            conn.execute(
                "UPDATE flow_groups SET last_status = 'error', last_error = ? WHERE group_id = ?",
                (err_msg[:2000], group_id),
            )
        return {
            "status": "error",
            "group_id": group_id,
            "group_name": group_name,
            "error": err_msg,
            "rows": 0,
            "columns": 0,
            "output_summary": "",
            "preview": [],
        }

