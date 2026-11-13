"""Dataiki Production Routes.

Handles:
- Model Registry: list versions, promote candidate, retrain model, change status/rollback, download standalone ZIP.
- Custom API Route Builder: CRUD for custom REST endpoint handlers.
- 5-Carriage Batch Jobs & Scheduling: CRUD for batch jobs, run-once trigger, schedule synchronization.
"""

from __future__ import annotations

import datetime
import json
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, status
from fastapi.responses import FileResponse

from backend.config import ALLOW_FREESTYLE
from backend.database import get_db, unpack_row_json
from backend.engine.exporter import export_standalone_zip
from backend.engine.job_scheduler import run_batch_job, sync_apscheduler_jobs
from backend.engine.ml_tuner import promote_to_production, retrain_published_model
from backend.engine.script_runner import run_freestyle_script, run_script_code
from backend.schemas import (
    BatchJobCreate,
    CustomEndpointCreate,
    FreestyleScriptCreate,
    FreestyleScriptRunRequest,
    ModelStatusActionRequest,
    PromoteModelRequest,
    ScheduleConfig,
)

router = APIRouter(prefix="/api/production", tags=["Production Gateway & MLOps"])


# =====================================================================
# 1. Production Model Registry & Immutability
# =====================================================================


@router.get("/models/{project_key}")
def list_project_models(project_key: str) -> List[Dict[str, Any]]:
    """List all immutable production model versions for a project."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM model_versions
            WHERE project_key = ?
            ORDER BY version DESC
            """,
            (project_key,),
        ).fetchall()

    return [
        unpack_row_json(
            r,
            {
                "metrics_json": ("metrics", {}),
                "hyperparameters_json": ("hyperparameters", {}),
                "feature_columns_json": ("feature_columns", []),
                "input_schema_json": ("input_schema", {}),
            },
            pop_source=False,
        )
        for r in rows
    ]


@router.post("/models/promote", status_code=status.HTTP_201_CREATED)
def promote_candidate_model(payload: PromoteModelRequest) -> Dict[str, Any]:
    """Freeze candidate model from Optuna tuning into immutable production version."""
    try:
        return promote_to_production(
            project_key=payload.project_key,
            tuning_job_id=payload.tuning_job_id,
            trial_number=payload.trial_number,
            activate_immediately=payload.activate_immediately,
            model_name=payload.model_name,
        )
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@router.post("/models/{project_key}/{version}/retrain")
def retrain_model(project_key: str, version: int) -> Dict[str, Any]:
    """Retrain published model with locked hyperparameters on fresh data (STAGED review)."""
    try:
        return retrain_published_model(project_key=project_key, base_version=version)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@router.post("/models/{project_key}/{version}/status")
def change_model_status(
    project_key: str,
    version: int,
    payload: ModelStatusActionRequest,
) -> Dict[str, Any]:
    """Activate, unpublish, or delete a model version."""
    act = payload.action.lower().strip()

    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM model_versions WHERE project_key = ? AND version = ?",
            (project_key, version),
        ).fetchone()

        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Model version v{version} for project '{project_key}' not found.",
            )

        if act == "activate":
            # Demote current active version to staged
            conn.execute(
                "UPDATE model_versions SET status = 'staged' WHERE project_key = ? AND status = 'active'",
                (project_key,),
            )
            # Promote this version to active
            conn.execute(
                "UPDATE model_versions SET status = 'active' WHERE project_key = ? AND version = ?",
                (project_key, version),
            )
            return {"project_key": project_key, "version": version, "status": "active"}

        elif act == "unpublish":
            conn.execute(
                "UPDATE model_versions SET status = 'staged' WHERE project_key = ? AND version = ?",
                (project_key, version),
            )
            return {"project_key": project_key, "version": version, "status": "staged"}

        elif act == "delete":
            if row["status"] == "active":
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="Cannot delete an ACTIVE production model version. Unpublish or activate another version first.",
                )
            conn.execute(
                "DELETE FROM model_versions WHERE project_key = ? AND version = ?",
                (project_key, version),
            )
            return {"project_key": project_key, "version": version, "status": "deleted"}

        else:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid action '{payload.action}'.")


@router.get("/export/{project_key}/{version}")
def download_standalone_zip(project_key: str, version: int):
    """Generate and download zero-lockin standalone microservice ZIP archive."""
    try:
        zip_path = export_standalone_zip(project_key=project_key, version=version)
        p = Path(zip_path)
        return FileResponse(
            path=p.as_posix(),
            filename=p.name,
            media_type="application/zip",
        )
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


# =====================================================================
# 2. Custom REST API Routes
# =====================================================================


@router.post("/endpoints", status_code=status.HTTP_201_CREATED)
def create_custom_endpoint(payload: CustomEndpointCreate) -> Dict[str, Any]:
    """Publish a new custom REST API route mapped to Python inference script."""
    endpoint_id = f"ep_{uuid.uuid4().hex[:12]}"
    norm_path = "/" + payload.custom_path.strip("/")
    method = payload.http_method.upper().strip()

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO custom_endpoints (
                endpoint_id, project_key, http_method, custom_path,
                handler_function, inference_script, model_version, is_enabled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(project_key, http_method, custom_path) DO UPDATE SET
                handler_function = excluded.handler_function,
                inference_script = excluded.inference_script,
                model_version = excluded.model_version,
                is_enabled = excluded.is_enabled
            """,
            (
                endpoint_id,
                payload.project_key,
                method,
                norm_path,
                payload.handler_function,
                payload.inference_script,
                payload.model_version,
                1 if payload.is_enabled else 0,
            ),
        )

        row = conn.execute(
            """
            SELECT endpoint_id
            FROM custom_endpoints
            WHERE project_key = ? AND http_method = ? AND custom_path = ?
            """,
            (payload.project_key, method, norm_path),
        ).fetchone()
        if not row:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Endpoint upsert failed to return a persisted row.",
            )
        persisted_id = str(row["endpoint_id"])

    return {
        "endpoint_id": persisted_id,
        "project_key": payload.project_key,
        "http_method": method,
        "custom_path": norm_path,
        "status": "published",
    }


@router.get("/endpoints/{project_key}")
def list_custom_endpoints(project_key: str) -> List[Dict[str, Any]]:
    """List all custom REST API routes for a project."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM custom_endpoints WHERE project_key = ? ORDER BY created_at DESC",
            (project_key,),
        ).fetchall()
    return [dict(r) for r in rows]


@router.put("/endpoints/{endpoint_id}")
def update_custom_endpoint(endpoint_id: str, payload: CustomEndpointCreate) -> Dict[str, Any]:
    """Update custom REST API route definition."""
    norm_path = "/" + payload.custom_path.strip("/")
    method = payload.http_method.upper().strip()

    with get_db() as conn:
        cur = conn.execute(
            """
            UPDATE custom_endpoints
            SET http_method = ?, custom_path = ?, handler_function = ?,
                inference_script = ?, model_version = ?, is_enabled = ?
            WHERE endpoint_id = ?
            """,
            (
                method,
                norm_path,
                payload.handler_function,
                payload.inference_script,
                payload.model_version,
                1 if payload.is_enabled else 0,
                endpoint_id,
            ),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Endpoint '{endpoint_id}' not found.")

    return {"endpoint_id": endpoint_id, "status": "updated"}


@router.delete("/endpoints/{endpoint_id}")
def delete_custom_endpoint(endpoint_id: str) -> Dict[str, str]:
    """Delete a custom REST API route."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM custom_endpoints WHERE endpoint_id = ?", (endpoint_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Endpoint '{endpoint_id}' not found.")
    return {"status": "deleted", "endpoint_id": endpoint_id}


# =====================================================================
# 3. 5-Carriage Batch Jobs & APScheduler
# =====================================================================


@router.post("/jobs", status_code=status.HTTP_201_CREATED)
def create_batch_job(payload: BatchJobCreate) -> Dict[str, Any]:
    """Create a 5-carriage automated batch prediction job."""
    jid = f"bj_{uuid.uuid4().hex[:12]}"

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO batch_jobs (
                batch_job_id, project_key, job_name, model_version,
                source_config_json, pre_mapper_script, post_calc_script,
                sink_config_json, schedule_config_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                jid,
                payload.project_key,
                payload.job_name,
                payload.model_version,
                json.dumps(payload.source_config),
                payload.pre_mapper_script,
                payload.post_calc_script,
                json.dumps(payload.sink_config),
                json.dumps(payload.schedule_config.model_dump()),
            ),
        )

    # Sync schedule with APScheduler
    if payload.schedule_config.enabled:
        sync_apscheduler_jobs()

    return {"batch_job_id": jid, "job_name": payload.job_name, "status": "created"}


@router.put("/jobs/{batch_job_id}")
def update_batch_job(batch_job_id: str, payload: BatchJobCreate) -> Dict[str, Any]:
    """Update the full definition of an existing batch job."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT project_key FROM batch_jobs WHERE batch_job_id = ?",
            (batch_job_id,),
        ).fetchone()
        if not row:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Batch job '{batch_job_id}' not found.",
            )
        if payload.project_key != row["project_key"]:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="project_key cannot be changed for an existing batch job.",
            )

        conn.execute(
            """
            UPDATE batch_jobs
            SET job_name = ?, model_version = ?, source_config_json = ?,
                pre_mapper_script = ?, post_calc_script = ?,
                sink_config_json = ?, schedule_config_json = ?
            WHERE batch_job_id = ?
            """,
            (
                payload.job_name,
                payload.model_version,
                json.dumps(payload.source_config),
                payload.pre_mapper_script,
                payload.post_calc_script,
                json.dumps(payload.sink_config),
                json.dumps(payload.schedule_config.model_dump()),
                batch_job_id,
            ),
        )

    sync_apscheduler_jobs()
    return {"batch_job_id": batch_job_id, "job_name": payload.job_name, "status": "updated"}


@router.get("/jobs/{project_key}")
def list_batch_jobs(project_key: str) -> List[Dict[str, Any]]:
    """List all batch jobs configured for a project."""
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM batch_jobs WHERE project_key = ? ORDER BY created_at DESC",
            (project_key,),
        ).fetchall()

    return [
        unpack_row_json(
            r,
            {
                "source_config_json": ("source_config", {}),
                "sink_config_json": ("sink_config", {}),
                "schedule_config_json": ("schedule_config", {}),
            },
            pop_source=False,
        )
        for r in rows
    ]


@router.get("/jobs/detail/{batch_job_id}")
def get_batch_job(batch_job_id: str) -> Dict[str, Any]:
    """Get single batch job definition."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM batch_jobs WHERE batch_job_id = ?", (batch_job_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Batch job '{batch_job_id}' not found.")

    return unpack_row_json(
        row,
        {
            "source_config_json": ("source_config", {}),
            "sink_config_json": ("sink_config", {}),
            "schedule_config_json": ("schedule_config", {}),
        },
        pop_source=False,
    )


@router.delete("/jobs/{batch_job_id}")
def delete_batch_job(batch_job_id: str) -> Dict[str, str]:
    """Delete a batch job."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM batch_jobs WHERE batch_job_id = ?", (batch_job_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Batch job '{batch_job_id}' not found.")

    sync_apscheduler_jobs()
    return {"status": "deleted", "batch_job_id": batch_job_id}


@router.post("/jobs/{batch_job_id}/run")
def trigger_batch_job_run(batch_job_id: str) -> Dict[str, Any]:
    """Manually run a 5-carriage batch prediction job once immediately."""
    try:
        return run_batch_job(batch_job_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(exc)) from exc


@router.put("/jobs/{batch_job_id}/schedule")
def update_job_schedule(batch_job_id: str, schedule: ScheduleConfig) -> Dict[str, Any]:
    """Update human-friendly schedule config and sync with APScheduler."""
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE batch_jobs SET schedule_config_json = ? WHERE batch_job_id = ?",
            (json.dumps(schedule.model_dump()), batch_job_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Batch job '{batch_job_id}' not found.")

    sync_apscheduler_jobs()
    return {"batch_job_id": batch_job_id, "schedule": schedule.model_dump(), "status": "updated"}


# =====================================================================
# 4. Freestyle Script Lab (free-form Python + scheduler)
# =====================================================================


def _ensure_freestyle_enabled() -> None:
    if not ALLOW_FREESTYLE:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Freestyle script editor is disabled. Set DATAIKI_ALLOW_FREESTYLE=1 to enable it.",
        )


def _script_row_to_dict(row: Any) -> Dict[str, Any]:
    return unpack_row_json(
        row,
        {"schedule_config_json": ("schedule_config", {})},
        pop_source=False,
    )


@router.post("/scripts/run")
def run_freestyle_code(payload: FreestyleScriptRunRequest) -> Dict[str, Any]:
    """Run unsaved Script Lab code once and return captured stdout."""
    _ensure_freestyle_enabled()
    return run_script_code(project_key=payload.project_key, code=payload.code)


@router.post("/scripts", status_code=status.HTTP_201_CREATED)
def create_freestyle_script(payload: FreestyleScriptCreate) -> Dict[str, Any]:
    """Save a new free-form Python script for a project."""
    _ensure_freestyle_enabled()
    script_id = f"fs_{uuid.uuid4().hex[:12]}"

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO freestyle_scripts (
                script_id, project_key, script_name, code, schedule_config_json
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (
                script_id,
                payload.project_key,
                payload.script_name,
                payload.code,
                json.dumps(payload.schedule_config.model_dump()),
            ),
        )

    if payload.schedule_config.enabled:
        sync_apscheduler_jobs()

    return {"script_id": script_id, "script_name": payload.script_name, "status": "created"}


@router.get("/scripts/{project_key}")
def list_freestyle_scripts(project_key: str) -> List[Dict[str, Any]]:
    """List saved free-form scripts for a project."""
    _ensure_freestyle_enabled()
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM freestyle_scripts WHERE project_key = ? ORDER BY created_at DESC",
            (project_key,),
        ).fetchall()
    return [_script_row_to_dict(row) for row in rows]


@router.get("/scripts/detail/{script_id}")
def get_freestyle_script(script_id: str) -> Dict[str, Any]:
    """Fetch a single saved freestyle script."""
    _ensure_freestyle_enabled()
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM freestyle_scripts WHERE script_id = ?",
            (script_id,),
        ).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Script '{script_id}' not found.")
    return _script_row_to_dict(row)


@router.put("/scripts/{script_id}")
def update_freestyle_script(script_id: str, payload: FreestyleScriptCreate) -> Dict[str, Any]:
    """Update a saved freestyle script definition."""
    _ensure_freestyle_enabled()
    with get_db() as conn:
        cur = conn.execute(
            """
            UPDATE freestyle_scripts
            SET script_name = ?, code = ?, schedule_config_json = ?
            WHERE script_id = ?
            """,
            (
                payload.script_name,
                payload.code,
                json.dumps(payload.schedule_config.model_dump()),
                script_id,
            ),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Script '{script_id}' not found.")

    sync_apscheduler_jobs()
    return {"script_id": script_id, "script_name": payload.script_name, "status": "updated"}


@router.delete("/scripts/{script_id}")
def delete_freestyle_script(script_id: str) -> Dict[str, str]:
    """Delete a saved freestyle script."""
    _ensure_freestyle_enabled()
    with get_db() as conn:
        cur = conn.execute("DELETE FROM freestyle_scripts WHERE script_id = ?", (script_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Script '{script_id}' not found.")

    sync_apscheduler_jobs()
    return {"status": "deleted", "script_id": script_id}


@router.post("/scripts/{script_id}/run")
def trigger_freestyle_script(script_id: str) -> Dict[str, Any]:
    """Run a saved freestyle script once and persist its last output."""
    _ensure_freestyle_enabled()
    try:
        return run_freestyle_script(script_id)
    except KeyError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


@router.put("/scripts/{script_id}/schedule")
def update_freestyle_schedule(script_id: str, schedule: ScheduleConfig) -> Dict[str, Any]:
    """Update a freestyle script schedule and sync with APScheduler."""
    _ensure_freestyle_enabled()
    with get_db() as conn:
        cur = conn.execute(
            "UPDATE freestyle_scripts SET schedule_config_json = ? WHERE script_id = ?",
            (json.dumps(schedule.model_dump()), script_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Script '{script_id}' not found.")

    sync_apscheduler_jobs()
    return {"script_id": script_id, "schedule": schedule.model_dump(), "status": "updated"}

