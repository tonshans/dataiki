"""Dataiki ML Job Status Manager.

Tracks background ML studio execution states in the SQLite registry (ml_jobs):
- pending, running, paused_high_cardinality, completed, failed.
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, List, Optional

from backend.database import get_db, parse_json_safe, unpack_row_json


def create_job(
    project_key: str,
    job_type: str,
    job_id: Optional[str] = None,
) -> str:
    """Create a new job entry with 'pending' status.

    Args:
        project_key: Project identifier.
        job_type: Type of job ('screening', 'tuning', 'batch').
        job_id: Optional explicit job ID, generated via UUID4 if omitted.

    Returns:
        job_id: The unique identifier for the created job.
    """
    jid = job_id or f"job_{uuid.uuid4().hex[:12]}"
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO ml_jobs (job_id, project_key, job_type, status, progress, pause_context_json, result_json, error_message)
            VALUES (?, ?, ?, 'pending', 0, '{}', '{}', '')
            """,
            (jid, project_key, job_type),
        )
    return jid


def get_job(job_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve full job state by job_id.

    Args:
        job_id: Unique job identifier.

    Returns:
        Dictionary of job fields with parsed JSON payloads, or None if not found.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM ml_jobs WHERE job_id = ?",
            (job_id,),
        ).fetchone()

    if not row:
        return None

    return unpack_row_json(
        row,
        {
            "pause_context_json": ("pause_context", {}),
            "result_json": ("result", {}),
        },
        pop_source=False,
    )


def update_progress(
    job_id: str,
    progress: int,
    status: str = "running",
    message: Optional[str] = None,
) -> None:
    """Update progress percentage and optional status message.

    Args:
        job_id: Unique job identifier.
        progress: Progress integer (0 - 100).
        status: Current job status string (default 'running').
        message: Optional step message saved into pause_context_json.
    """
    with get_db() as conn:
        if message:
            row = conn.execute("SELECT pause_context_json FROM ml_jobs WHERE job_id = ?", (job_id,)).fetchone()
            ctx = parse_json_safe(row["pause_context_json"] if row else None, {})
            ctx["current_step"] = message
            conn.execute(
                """
                UPDATE ml_jobs
                SET progress = ?, status = ?, pause_context_json = ?
                WHERE job_id = ?
                """,
                (progress, status, json.dumps(ctx), job_id),
            )
        else:
            conn.execute(
                """
                UPDATE ml_jobs
                SET progress = ?, status = ?
                WHERE job_id = ?
                """,
                (progress, status, job_id),
            )


def set_paused_high_cardinality(
    job_id: str,
    triggered_columns: List[Dict[str, Any]],
    request_data: Optional[Dict[str, Any]] = None,
) -> None:
    """Pause job execution due to high cardinality detection in categorical features.

    Args:
        job_id: Unique job identifier.
        triggered_columns: List of metadata dicts for triggered columns.
        request_data: Optional serialized request configuration to resume with.
    """
    ctx: Dict[str, Any] = {
        "reason": "high_cardinality",
        "triggered_columns": triggered_columns,
    }
    if request_data:
        ctx["request_data"] = request_data

    with get_db() as conn:
        conn.execute(
            """
            UPDATE ml_jobs
            SET status = 'paused_high_cardinality', pause_context_json = ?
            WHERE job_id = ?
            """,
            (json.dumps(ctx), job_id),
        )


def resume_job(job_id: str, action: str) -> None:
    """Resume a paused job with user's chosen cardinality action.

    Args:
        job_id: Unique job identifier.
        action: Chosen action ('continue', 'drop_column', 'stop').
    """
    with get_db() as conn:
        row = conn.execute("SELECT pause_context_json FROM ml_jobs WHERE job_id = ?", (job_id,)).fetchone()
        ctx = parse_json_safe(row["pause_context_json"] if row else None, {})
        ctx["resumed_action"] = action
        conn.execute(
            """
            UPDATE ml_jobs
            SET status = 'running', pause_context_json = ?
            WHERE job_id = ?
            """,
            (json.dumps(ctx), job_id),
        )


def complete_job(job_id: str, result_data: Dict[str, Any]) -> None:
    """Mark job as completed with 100% progress and final result payload.

    Args:
        job_id: Unique job identifier.
        result_data: Output dictionary containing session details and leaderboard.
    """
    with get_db() as conn:
        conn.execute(
            """
            UPDATE ml_jobs
            SET status = 'completed', progress = 100, result_json = ?
            WHERE job_id = ?
            """,
            (json.dumps(result_data), job_id),
        )


def fail_job(job_id: str, error_message: str) -> None:
    """Mark job as failed with captured error trace.

    Args:
        job_id: Unique job identifier.
        error_message: Error description.
    """
    with get_db() as conn:
        conn.execute(
            """
            UPDATE ml_jobs
            SET status = 'failed', error_message = ?
            WHERE job_id = ?
            """,
            (str(error_message), job_id),
        )


def list_jobs(project_key: Optional[str] = None) -> List[Dict[str, Any]]:
    """List jobs filtered optionally by project_key."""
    query = "SELECT * FROM ml_jobs"
    params: List[Any] = []
    if project_key:
        query += " WHERE project_key = ?"
        params.append(project_key)
    query += " ORDER BY created_at DESC"

    with get_db() as conn:
        rows = conn.execute(query, tuple(params)).fetchall()

    return [
        unpack_row_json(
            r,
            {
                "pause_context_json": ("pause_context", {}),
                "result_json": ("result", {}),
            },
            pop_source=False,
        )
        for r in rows
    ]

