"""Dataiki Flow Group Routes.

Provides CRUD endpoints for named flow groups (sub-DAG snapshots) and a
run-once trigger endpoint. Flow groups can optionally be exposed as
Production API Gateway endpoints and scheduled via APScheduler.

Endpoints:
    GET    /api/flow-groups/{project_key}        List all groups in a project
    POST   /api/flow-groups                      Create a new flow group
    GET    /api/flow-groups/{group_id}/detail    Get single group detail
    PUT    /api/flow-groups/{group_id}           Update group configuration
    DELETE /api/flow-groups/{group_id}           Delete a flow group
    POST   /api/flow-groups/{group_id}/run       Run-once manual trigger
    GET    /api/flow-groups/{group_id}/status    Get last run status
"""

from __future__ import annotations

import json
import shutil
import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, status

from backend.config import CACHE_DIR
from backend.database import get_db, unpack_row_json
from backend.engine.flow_group_runner import run_flow_group
from backend.engine.job_scheduler import sync_flow_group_schedules
from backend.schemas import FlowGroupCreate, FlowGroupRunRequest

router = APIRouter(prefix="/api/flow-groups", tags=["Flow Groups"])


# =====================================================================
# Helpers
# =====================================================================

def _validate_group_payload(payload: FlowGroupCreate) -> None:
    """Reject payloads whose node references do not match the sub-DAG snapshot."""
    node_ids = set(payload.node_ids)
    dag_node_ids = {n.node_id for n in payload.sub_dag.nodes}

    if not node_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="node_ids must contain at least one node.",
        )
    if payload.output_node_id not in node_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="output_node_id must be one of node_ids.",
        )
    if not payload.group_slug.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="group_slug must not be empty.",
        )
    missing = node_ids - dag_node_ids
    if missing:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"node_ids missing from sub_dag.nodes: {sorted(missing)}.",
        )
    if payload.output_node_id not in dag_node_ids:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="output_node_id is missing from sub_dag.nodes.",
        )
    if payload.input_node_id:
        source = next(
            (n for n in payload.sub_dag.nodes if n.node_id == payload.input_node_id),
            None,
        )
        if source is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="input_node_id is missing from sub_dag.nodes.",
            )
        if source.node_type != "ingestion":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="input_node_id must reference an ingestion node.",
            )


def _row_to_dict(row: Any) -> Dict[str, Any]:
    """Convert a sqlite3.Row from flow_groups to a serializable dict."""
    d = unpack_row_json(
        row,
        {
            "node_ids_json": ("node_ids", []),
            "sub_dag_json": ("sub_dag", {}),
            "schedule_config_json": ("schedule_config", {}),
        },
        pop_source=True,
    )
    d["is_api_enabled"] = bool(d.get("is_api_enabled", 0))
    return d


# =====================================================================
# 1. List
# =====================================================================

@router.get("/{project_key}")
def list_flow_groups(project_key: str) -> List[Dict[str, Any]]:
    """List all flow groups belonging to a project."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM flow_groups WHERE project_key = ? ORDER BY created_at DESC",
            (project_key,),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


# =====================================================================
# 2. Create
# =====================================================================

@router.post("", status_code=status.HTTP_201_CREATED)
def create_flow_group(payload: FlowGroupCreate) -> Dict[str, Any]:
    """Create a new named flow group from a selection of canvas nodes."""
    _validate_group_payload(payload)
    group_id = f"grp_{uuid.uuid4().hex[:12]}"
    slug = payload.group_slug.strip().lower().replace(" ", "-")

    sub_dag_json = payload.sub_dag.model_dump_json()
    node_ids_json = json.dumps(payload.node_ids)
    schedule_json = payload.schedule_config.model_dump_json()

    with get_db() as conn:
        try:
            conn.execute(
                """
                INSERT INTO flow_groups (
                    group_id, project_key, group_name, group_slug, description,
                    node_ids_json, output_node_id, input_node_id,
                    sub_dag_json, schedule_config_json, is_api_enabled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    group_id,
                    payload.project_key,
                    payload.group_name,
                    slug,
                    payload.description,
                    node_ids_json,
                    payload.output_node_id,
                    payload.input_node_id,
                    sub_dag_json,
                    schedule_json,
                    1 if payload.is_api_enabled else 0,
                ),
            )
        except Exception as exc:
            if "UNIQUE" in str(exc).upper():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Flow group slug '{slug}' already exists in project '{payload.project_key}'.",
                ) from exc
            raise

    # Re-sync APScheduler when schedule is configured
    if payload.schedule_config.enabled:
        try:
            sync_flow_group_schedules()
        except Exception:
            pass  # Non-fatal; group was saved

    with get_db() as conn:
        row = conn.execute("SELECT * FROM flow_groups WHERE group_id = ?", (group_id,)).fetchone()
    return _row_to_dict(row)


# =====================================================================
# 3. Detail
# =====================================================================

@router.get("/{group_id}/detail")
def get_flow_group(group_id: str) -> Dict[str, Any]:
    """Get the full configuration of a single flow group."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM flow_groups WHERE group_id = ?", (group_id,)
        ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Flow group '{group_id}' not found.")
    return _row_to_dict(row)


# =====================================================================
# 4. Update
# =====================================================================

@router.put("/{group_id}")
def update_flow_group(group_id: str, payload: FlowGroupCreate) -> Dict[str, Any]:
    """Update configuration, schedule, or sub-DAG snapshot of an existing flow group."""
    _validate_group_payload(payload)
    with get_db() as conn:
        existing = conn.execute(
            "SELECT group_id FROM flow_groups WHERE group_id = ?", (group_id,)
        ).fetchone()
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Flow group '{group_id}' not found.")

    slug = payload.group_slug.strip().lower().replace(" ", "-")
    sub_dag_json = payload.sub_dag.model_dump_json()
    node_ids_json = json.dumps(payload.node_ids)
    schedule_json = payload.schedule_config.model_dump_json()

    with get_db() as conn:
        try:
            conn.execute(
                """
                UPDATE flow_groups SET
                    group_name = ?, group_slug = ?, description = ?,
                    node_ids_json = ?, output_node_id = ?, input_node_id = ?,
                    sub_dag_json = ?, schedule_config_json = ?, is_api_enabled = ?
                WHERE group_id = ?
                """,
                (
                    payload.group_name,
                    slug,
                    payload.description,
                    node_ids_json,
                    payload.output_node_id,
                    payload.input_node_id,
                    sub_dag_json,
                    schedule_json,
                    1 if payload.is_api_enabled else 0,
                    group_id,
                ),
            )
        except Exception as exc:
            if "UNIQUE" in str(exc).upper():
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"Flow group slug '{slug}' already exists in project '{payload.project_key}'.",
                ) from exc
            raise

    # Re-sync APScheduler
    try:
        sync_flow_group_schedules()
    except Exception:
        pass

    with get_db() as conn:
        row = conn.execute("SELECT * FROM flow_groups WHERE group_id = ?", (group_id,)).fetchone()
    return _row_to_dict(row)


# =====================================================================
# 5. Delete
# =====================================================================

@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_flow_group(group_id: str) -> None:
    """Delete a flow group and remove its APScheduler entry if present."""
    with get_db() as conn:
        existing = conn.execute(
            "SELECT group_id FROM flow_groups WHERE group_id = ?", (group_id,)
        ).fetchone()
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Flow group '{group_id}' not found.")

    with get_db() as conn:
        conn.execute("DELETE FROM flow_groups WHERE group_id = ?", (group_id,))

    # Remove from APScheduler
    try:
        from backend.engine.job_scheduler import scheduler
        job_id = f"fg_{group_id}"
        if scheduler.get_job(job_id):
            scheduler.remove_job(job_id)
    except Exception:
        pass

    # Drop cached Parquet artefacts (group input + virtual project output)
    for cache_dir in (CACHE_DIR / "group" / group_id, CACHE_DIR / f"group__{group_id}"):
        shutil.rmtree(cache_dir, ignore_errors=True)


# =====================================================================
# 6. Run-Once Trigger
# =====================================================================

@router.post("/{group_id}/run")
def run_flow_group_once(
    group_id: str,
    payload: FlowGroupRunRequest,
) -> Dict[str, Any]:
    """Manually trigger a flow group run-once execution.

    Runs synchronously and returns the result directly (no background queue).
    For large groups use the scheduler instead.
    """
    with get_db() as conn:
        existing = conn.execute(
            "SELECT group_id FROM flow_groups WHERE group_id = ?", (group_id,)
        ).fetchone()
    if not existing:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Flow group '{group_id}' not found.")

    result = run_flow_group(
        group_id=group_id,
        input_payload=payload.input_payload,
        output_format=payload.output_format,
    )

    if result.get("status") == "error":
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": result.get("error", "Unknown error"), "group_id": group_id},
        )

    return result


# =====================================================================
# 7. Status
# =====================================================================

@router.get("/{group_id}/status")
def get_flow_group_status(group_id: str) -> Dict[str, Any]:
    """Return the last run status, timestamp, error, and output summary for a flow group."""
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT group_id, group_name, last_run_at, last_status, last_error, last_output_summary
            FROM flow_groups WHERE group_id = ?
            """,
            (group_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Flow group '{group_id}' not found.")
    return dict(row)

