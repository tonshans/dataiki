"""Dataiki ML Studio Routes.

Handles:
- Multi-Algorithm Screening (Phase 1) with high cardinality pausing & resuming.
- Optuna Bayesian Deep Fine-Tuning (Phase 2).
- Asynchronous Job polling and progress tracking.
- ML Session Trophy Cabinet history inspection and deletion.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import polars as pl
from fastapi import APIRouter, BackgroundTasks, HTTPException, Response, status

from backend.config import CACHE_DIR
from backend.database import get_db
from backend.engine.ml_jobs import (
    create_job,
    fail_job,
    get_job,
    resume_job,
    set_paused_high_cardinality,
)
from backend.engine.ml_screening import run_screening_job
from backend.engine.ml_tuner import run_optuna_tuning
from backend.schemas import (
    CardinalityResolutionRequest,
    ScreeningRequest,
    TuningRequest,
)

router = APIRouter(prefix="/api/ml", tags=["ML Studio & AutoML"])


# =====================================================================
# 1. Asynchronous Multi-Algorithm Screening
# =====================================================================


@router.post("/screen", status_code=status.HTTP_202_ACCEPTED)
def start_screening(
    req: ScreeningRequest,
    background_tasks: BackgroundTasks,
    response: Response,
) -> Dict[str, Any]:
    """Initiate Phase 1 Multi-Algorithm Screening in the background.

    If One-Hot Encoding is selected and high cardinality (> threshold) is detected,
    immediately pauses with 202 Accepted and returns list of triggered columns.
    """
    job_id = create_job(req.project_key, "screening")

    # Fast-path upfront high cardinality check
    if (
        req.preprocessing.categorical_encoder == "onehot"
        and req.high_cardinality_action is None
    ):
        parquet_path = CACHE_DIR / req.project_key / f"{req.input_node_id}.parquet"
        if parquet_path.exists():
            try:
                df = pl.read_parquet(parquet_path)
                threshold = req.preprocessing.high_cardinality_threshold
                triggered: List[Dict[str, Any]] = []

                for col in req.feature_columns:
                    if col in df.columns and df[col].dtype in (pl.Utf8, pl.Categorical, pl.Boolean):
                        u_cnt = int(df[col].n_unique())
                        if u_cnt > threshold:
                            triggered.append(
                                {
                                    "column_name": col,
                                    "unique_count": u_cnt,
                                    "threshold": threshold,
                                }
                            )

                if triggered:
                    set_paused_high_cardinality(job_id, triggered, request_data=req.model_dump())
                    return {
                        "job_id": job_id,
                        "status": "paused_high_cardinality",
                        "high_cardinality_columns": triggered,
                        "message": "High cardinality detected. Waiting for user decision: continue, drop_column, or stop.",
                    }
            except Exception:
                pass

    # Launch background task
    background_tasks.add_task(run_screening_job, req, job_id)

    return {
        "job_id": job_id,
        "status": "running",
        "message": "ML Screening started in background.",
    }


@router.post("/job/{job_id}/resolve-cardinality")
def resolve_cardinality(
    job_id: str,
    payload: CardinalityResolutionRequest,
    background_tasks: BackgroundTasks,
) -> Dict[str, Any]:
    """Resume a paused screening job with user's decision ('continue', 'drop_column', 'stop')."""
    job_info = get_job(job_id)
    if not job_info:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job '{job_id}' not found.")

    if job_info.get("status") != "paused_high_cardinality":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Job '{job_id}' is not in paused_high_cardinality state (current: {job_info.get('status')}).",
        )

    act = payload.action.lower().strip()

    if act == "stop":
        fail_job(job_id, "Screening aborted by user.")
        return {"job_id": job_id, "status": "stopped", "message": "Screening stopped."}

    # Resume job
    resume_job(job_id, act)

    # Reconstruct original ScreeningRequest
    ctx = job_info.get("pause_context", {})
    req_data = ctx.get("request_data")
    if not req_data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Original screening request configuration missing in pause context.",
        )

    req_data["high_cardinality_action"] = act
    req = ScreeningRequest.model_validate(req_data)

    background_tasks.add_task(run_screening_job, req, job_id)

    return {
        "job_id": job_id,
        "status": "running",
        "action": act,
        "message": f"Screening resumed with action: {act}",
    }


# =====================================================================
# 2. Phase 2 Optuna Deep Fine-Tuning
# =====================================================================


@router.post("/tune", status_code=status.HTTP_202_ACCEPTED)
def start_tuning(
    req: TuningRequest,
    background_tasks: BackgroundTasks,
) -> Dict[str, Any]:
    """Initiate Phase 2 Optuna Deep Fine-Tuning in the background."""
    job_id = create_job(req.project_key, "tuning")
    background_tasks.add_task(run_optuna_tuning, job_id, req)

    return {
        "job_id": job_id,
        "status": "running",
        "message": f"Optuna tuning for {req.algorithm} started in background.",
    }


# =====================================================================
# 3. Asynchronous Job Polling
# =====================================================================


@router.get("/job/{job_id}/status")
def get_job_status(job_id: str) -> Dict[str, Any]:
    """Poll execution state, progress %, and final result for screening/tuning jobs."""
    job_info = get_job(job_id)
    if not job_info:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Job '{job_id}' not found.")
    return job_info


# =====================================================================
# 4. Trophy Cabinet & Session History
# =====================================================================


@router.get("/sessions/{project_key}")
def list_ml_sessions(project_key: str) -> List[Dict[str, Any]]:
    """List historical screening sessions for a project (Trophy Cabinet)."""
    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT * FROM ml_sessions
            WHERE project_key = ?
            ORDER BY created_at DESC
            """,
            (project_key,),
        ).fetchall()

    results: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        try:
            d["feature_columns"] = json.loads(d.get("feature_columns_json") or "[]")
        except Exception:
            d["feature_columns"] = []
        try:
            d["preprocessing"] = json.loads(d.get("preprocessing_json") or "{}")
        except Exception:
            d["preprocessing"] = {}
        try:
            d["leaderboard"] = json.loads(d.get("leaderboard_json") or "[]")
        except Exception:
            d["leaderboard"] = []
        results.append(d)

    return results


@router.delete("/sessions/{session_id}")
def delete_ml_session(session_id: str) -> Dict[str, str]:
    """Delete an ML screening session from the Trophy Cabinet."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM ml_sessions WHERE session_id = ?", (session_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Session '{session_id}' not found.")

    return {"status": "deleted", "session_id": session_id}

