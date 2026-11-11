"""Dataiki Lab & DAG Canvas Routes.

Handles:
- Pipeline DAG retrieval and saving.
- Topological execution of DAG pipeline nodes.
- Interactive Tabular Data Preview with real-time recipe stack simulation.
- Deep Column Analysis with statistical indicators, distribution, and outliers.
"""

from __future__ import annotations

import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import polars as pl
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from backend.config import CACHE_DIR
from backend.database import get_db
from backend.engine.dag_runner import execute_dag, load_pipeline_dag
from backend.engine.eda_profiler import analyze_column_deep, get_tabular_headers_and_sample
from backend.engine.recipe_engine import _resolve_column_name, apply_recipe_steps
from backend.schemas import (
    ColumnAnalysisResponse,
    PipelineDAG,
    PreviewRequest,
    RecipeStep,
    TabularPreviewResponse,
)

router = APIRouter(prefix="/api/lab", tags=["Lab & Data Exploration"])


class PipelineRunRequest(BaseModel):
    """Payload to trigger execution of DAG canvas pipeline."""
    project_key: str
    target_node_id: Optional[str] = None


# =====================================================================
# 1. Pipeline DAG Persistence
# =====================================================================


@router.get("/dag/{project_key}")
def get_dag(project_key: str) -> Dict[str, Any]:
    """Retrieve visual pipeline DAG for canvas rendering."""
    try:
        dag = load_pipeline_dag(project_key)
        return dag.model_dump()
    except KeyError:
        # Return empty DAG if project exists without configured nodes
        with get_db() as conn:
            row = conn.execute("SELECT * FROM projects WHERE project_key = ?", (project_key,)).fetchone()
        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{project_key}' not found.")
        return {"project_key": project_key, "nodes": [], "edges": []}


@router.post("/dag/{project_key}")
def save_dag(project_key: str, dag: PipelineDAG) -> Dict[str, str]:
    """Persist updated visual DAG nodes and edges into project registry."""
    now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
    dag_json = dag.model_dump_json()

    with get_db() as conn:
        row = conn.execute(
            "SELECT name, description FROM projects WHERE project_key = ?",
            (project_key,),
        ).fetchone()
        name = row["name"] if row else project_key
        description = row["description"] if row else ""

        conn.execute(
            """
            INSERT INTO projects (project_key, name, description, dag_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_key) DO UPDATE SET
                dag_json = excluded.dag_json,
                updated_at = excluded.updated_at
            """,
            (project_key, name, description, dag_json, now_str),
        )

    return {"status": "saved", "project_key": project_key}


# =====================================================================
# 2. Pipeline Execution
# =====================================================================


@router.post("/pipeline/run")
def run_pipeline(payload: PipelineRunRequest) -> Dict[str, Any]:
    """Execute topological DAG runner up to target_node_id (or entire pipeline)."""
    try:
        results = execute_dag(
            project_key=payload.project_key,
            target_node_id=payload.target_node_id,
        )
        return {
            "status": "completed",
            "project_key": payload.project_key,
            "executed_nodes": results,
        }
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Pipeline execution failed: {exc}",
        ) from exc


# =====================================================================
# 3. Tabular Preview & Real-Time Recipe Simulation
# =====================================================================


@router.post(
    "/node/{project_key}/{node_id}/preview",
    response_model=TabularPreviewResponse,
)
def get_node_preview(
    project_key: str,
    node_id: str,
    payload: PreviewRequest,
) -> TabularPreviewResponse:
    """Generate interactive tabular preview with header fill-rates and simulated recipes."""
    try:
        dag = load_pipeline_dag(project_key)
    except Exception:
        dag = None

    target_node = next((n for n in dag.nodes if n.node_id == node_id), None) if dag else None
    incoming_edges = [e for e in dag.edges if e.target == node_id] if dag else []

    # If this is a data_recipe node (or has an incoming parent edge)
    if incoming_edges and target_node and target_node.node_type == "data_recipe":
        parent_node_id = incoming_edges[0].source
        parent_path = CACHE_DIR / project_key / f"{parent_node_id}.parquet"

        if not parent_path.exists():
            try:
                execute_dag(project_key=project_key, target_node_id=parent_node_id)
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Parent Parquet cache for node '{node_id}' not found and execution failed: {exc}",
                ) from exc

        if not parent_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Upstream Parquet cache not found for recipe node '{node_id}'.",
            )

        raw_df = pl.read_parquet(parent_path)

        # 1. View Raw Data switch is active: return upstream raw data
        if payload.view_raw:
            return get_tabular_headers_and_sample(raw_df, limit=payload.limit)

        # 2. View Processed Data: apply recipe steps on raw_df
        raw_steps = (
            payload.recipe_steps
            or getattr(target_node, "recipe_steps", None)
            or (target_node.params.get("recipe_steps") if target_node else [])
        )
        steps: List[RecipeStep] = []
        for s in raw_steps:
            if isinstance(s, RecipeStep):
                steps.append(s)
            elif isinstance(s, dict):
                steps.append(RecipeStep.model_validate(s))

        if steps:
            try:
                transformed_df, modified_cols = apply_recipe_steps(
                    df=raw_df,
                    steps=steps,
                    include_train_only=False,
                    fail_fast_mode=False,
                )
                resp = get_tabular_headers_and_sample(transformed_df, limit=payload.limit)
                resp.modified_columns = modified_cols
                dest_path = CACHE_DIR / project_key / f"{node_id}.parquet"
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                transformed_df.write_parquet(dest_path)
                return resp
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Recipe simulation failed: {exc}",
                ) from exc

        # If no steps configured on recipe, return raw_df
        return get_tabular_headers_and_sample(raw_df, limit=payload.limit)

    parquet_path = CACHE_DIR / project_key / f"{node_id}.parquet"

    # If cache Parquet is missing, trigger execution of this node's upstream lineage
    if not parquet_path.exists():
        try:
            execute_dag(project_key=project_key, target_node_id=node_id)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Parquet cache for node '{node_id}' not found and execution failed: {exc}",
            ) from exc

    if not parquet_path.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Parquet cache not found for node '{node_id}'.",
        )

    # Read base Parquet into Polars
    df = pl.read_parquet(parquet_path)

    # 1. View Raw Data switch is active
    if payload.view_raw:
        return get_tabular_headers_and_sample(df, limit=payload.limit)

    # 2. Interactive recipe steps simulation
    if payload.recipe_steps:
        try:
            transformed_df, modified_cols = apply_recipe_steps(
                df=df,
                steps=payload.recipe_steps,
                include_train_only=False,  # bypassed for preview
                fail_fast_mode=False,
            )
            resp = get_tabular_headers_and_sample(transformed_df, limit=payload.limit)
            resp.modified_columns = modified_cols
            return resp
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Recipe simulation failed: {exc}",
            ) from exc

    # Default: preview cache data as-is
    return get_tabular_headers_and_sample(df, limit=payload.limit)


# =====================================================================
# 4. Deep Column Analysis Drawer
# =====================================================================


@router.get(
    "/node/{project_key}/{node_id}/column-analysis",
    response_model=ColumnAnalysisResponse,
)
def get_column_analysis(
    project_key: str,
    node_id: str,
    column: str = Query(..., description="Target column name to profile"),
    target: Optional[str] = Query(None, description="Optional target column for correlation prioritization"),
    view_raw: bool = Query(False, description="Whether to analyze raw upstream data or processed output"),
) -> ColumnAnalysisResponse:
    """Compute deep statistical analysis (central tendency, dispersion, outliers, histograms)."""
    df: Optional[pl.DataFrame] = None

    try:
        dag = load_pipeline_dag(project_key)
        target_node = next((n for n in dag.nodes if n.node_id == node_id), None)
    except Exception:
        target_node = None

    # For data_recipe nodes: accurately source raw vs processed DataFrame
    if target_node and target_node.node_type == "data_recipe":
        incoming_edges = [e for e in dag.edges if e.target == node_id]
        if incoming_edges:
            parent_node_id = incoming_edges[0].source
            parent_path = CACHE_DIR / project_key / f"{parent_node_id}.parquet"
            if not parent_path.exists():
                try:
                    execute_dag(project_key=project_key, target_node_id=parent_node_id)
                except Exception:
                    pass

            if parent_path.exists():
                raw_df = pl.read_parquet(parent_path)
                if view_raw:
                    df = raw_df
                else:
                    raw_steps = (
                        getattr(target_node, "recipe_steps", None)
                        or (target_node.params.get("recipe_steps") if target_node else [])
                    )
                    steps: List[RecipeStep] = []
                    for s in raw_steps:
                        if isinstance(s, RecipeStep):
                            steps.append(s)
                        elif isinstance(s, dict):
                            steps.append(RecipeStep.model_validate(s))

                    if steps:
                        try:
                            df, _ = apply_recipe_steps(
                                df=raw_df,
                                steps=steps,
                                include_train_only=False,
                                fail_fast_mode=False,
                            )
                        except Exception:
                            df = raw_df
                    else:
                        df = raw_df

    if df is None:
        parquet_path = CACHE_DIR / project_key / f"{node_id}.parquet"
        if not parquet_path.exists():
            try:
                execute_dag(project_key=project_key, target_node_id=node_id)
            except Exception as exc:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Parquet cache missing for node '{node_id}': {exc}",
                ) from exc

        if not parquet_path.exists():
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Node Parquet cache missing: {parquet_path}",
            )

        df = pl.read_parquet(parquet_path)

    matched_col = _resolve_column_name(df, column)
    if not matched_col:
        view_label = "raw" if view_raw else "processed"
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Column '{column}' not found in node '{node_id}' ({view_label} view).",
        )

    matched_target = _resolve_column_name(df, target) if target else None

    try:
        return analyze_column_deep(df=df, column_name=matched_col, target_column=matched_target)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Failed to profile column '{column}': {exc}",
        ) from exc

