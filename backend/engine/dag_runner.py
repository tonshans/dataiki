"""Dataiki Topological DAG Runner and Lineage Tracer.

Executes visual DAG pipelines with support for:
- Branching (1 source connected to multiple recipes / transforms).
- DuckDB 8-bit Venn Joiner (INNER, LEFT, RIGHT, FULL OUTER) on Parquet cache.
- Stackable Data Recipes (with train-only isolation for cache preview).
- Custom Python Transformation nodes in controlled sandbox.
- Complete Lineage Tracing for model immutability freezing.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import duckdb
import numpy as np
import polars as pl

from backend.config import CACHE_DIR
from backend.database import get_db
from backend.engine.ingestion import ingest_to_parquet
from backend.engine.recipe_engine import apply_recipe_steps
from backend.schemas import EdgeConfig, NodeConfig, PipelineDAG, RecipeStep


def load_pipeline_dag(project_key: str) -> PipelineDAG:
    """Retrieve and parse the visual DAG for a project from the registry database.

    Args:
        project_key: Unique project identifier.

    Returns:
        PipelineDAG instance.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT dag_json FROM projects WHERE project_key = ?",
            (project_key,),
        ).fetchone()
        if not row:
            raise KeyError(f"Project '{project_key}' not found in registry database.")
        dag_data = row["dag_json"]
        if isinstance(dag_data, str):
            return PipelineDAG.model_validate_json(dag_data)
        return PipelineDAG.model_validate(dag_data)


def topological_sort(dag: PipelineDAG) -> List[NodeConfig]:
    """Sort DAG nodes in topological execution order using Kahn's algorithm.

    Args:
        dag: PipelineDAG object containing nodes and edges.

    Returns:
        List of NodeConfig ordered from sources to downstream consumers.

    Raises:
        ValueError: If a cyclic dependency is detected in the pipeline.
    """
    node_map: Dict[str, NodeConfig] = {n.node_id: n for n in dag.nodes}
    in_degree: Dict[str, int] = {n.node_id: 0 for n in dag.nodes}
    adjacency: Dict[str, List[str]] = {n.node_id: [] for n in dag.nodes}

    for edge in dag.edges:
        if edge.target in in_degree:
            in_degree[edge.target] += 1
        if edge.source in adjacency:
            adjacency[edge.source].append(edge.target)

    # Queue all root nodes (in-degree == 0)
    queue: List[str] = [n_id for n_id, deg in in_degree.items() if deg == 0]
    ordered_nodes: List[NodeConfig] = []

    while queue:
        curr_id = queue.pop(0)
        ordered_nodes.append(node_map[curr_id])

        for neighbor_id in adjacency.get(curr_id, []):
            in_degree[neighbor_id] -= 1
            if in_degree[neighbor_id] == 0:
                queue.append(neighbor_id)

    if len(ordered_nodes) != len(dag.nodes):
        raise ValueError("Cyclic dependency detected in pipeline DAG.")

    return ordered_nodes


def _execute_join_node(
    project_key: str,
    node: NodeConfig,
    dag: PipelineDAG,
    dest_path: Path,
) -> str:
    """Execute 8-bit Venn Diagram join over two Parquet files using DuckDB."""
    params = node.params or {}
    join_type_raw = str(params.get("join_type", "inner")).strip().lower()

    # Determine left and right parent nodes
    left_node_id = params.get("left_node_id")
    right_node_id = params.get("right_node_id")

    incoming_edges = [e for e in dag.edges if e.target == node.node_id]
    if not left_node_id or not right_node_id:
        if len(incoming_edges) < 2:
            raise ValueError(
                f"Join node '{node.node_id}' requires 2 incoming connections, found {len(incoming_edges)}."
            )
        left_node_id = left_node_id or incoming_edges[0].source
        right_node_id = right_node_id or incoming_edges[1].source

    left_path = CACHE_DIR / project_key / f"{left_node_id}.parquet"
    right_path = CACHE_DIR / project_key / f"{right_node_id}.parquet"

    if not left_path.exists():
        raise FileNotFoundError(f"Left join parent Parquet not found: {left_path}")
    if not right_path.exists():
        raise FileNotFoundError(f"Right join parent Parquet not found: {right_path}")

    # Map join type to SQL keyword
    join_sql_map = {
        "inner": "INNER JOIN",
        "left": "LEFT JOIN",
        "right": "RIGHT JOIN",
        "full": "FULL OUTER JOIN",
        "outer": "FULL OUTER JOIN",
        "full_outer": "FULL OUTER JOIN",
    }
    sql_join = join_sql_map.get(join_type_raw, "INNER JOIN")

    # Build ON condition
    left_on = params.get("left_on")
    right_on = params.get("right_on")
    if not left_on or not right_on:
        raise ValueError(f"Join node '{node.node_id}' missing 'left_on' or 'right_on' join keys.")

    if isinstance(left_on, str):
        left_on_list = [left_on]
    else:
        left_on_list = list(left_on)

    if isinstance(right_on, str):
        right_on_list = [right_on]
    else:
        right_on_list = list(right_on)

    if len(left_on_list) != len(right_on_list):
        raise ValueError("Join keys length mismatch between left_on and right_on.")

    on_clauses = [f'L."{l_k}" = R."{r_k}"' for l_k, r_k in zip(left_on_list, right_on_list)]
    on_expr = " AND ".join(on_clauses)

    query = f"""
    SELECT L.*, R.* 
    FROM read_parquet('{left_path.as_posix()}') AS L
    {sql_join} read_parquet('{right_path.as_posix()}') AS R
    ON {on_expr}
    """

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect()
    try:
        con.execute(f"COPY ({query}) TO '{dest_path.as_posix()}' (FORMAT PARQUET)")
    finally:
        con.close()

    return dest_path.as_posix()


def _execute_recipe_node(
    project_key: str,
    node: NodeConfig,
    dag: PipelineDAG,
    dest_path: Path,
) -> str:
    """Execute stackable recipe card sequence on upstream Parquet parent."""
    incoming_edges = [e for e in dag.edges if e.target == node.node_id]
    if not incoming_edges:
        raise ValueError(f"Data recipe node '{node.node_id}' has no incoming edge.")

    parent_node_id = incoming_edges[0].source
    parent_path = CACHE_DIR / project_key / f"{parent_node_id}.parquet"
    if not parent_path.exists():
        raise FileNotFoundError(f"Upstream Parquet not found for recipe node: {parent_path}")

    # Read upstream data into Polars
    df = pl.read_parquet(parent_path)

    # Parse recipe steps
    params = node.params or {}
    raw_steps = params.get("recipe_steps", [])
    steps: List[RecipeStep] = []
    for s in raw_steps:
        if isinstance(s, RecipeStep):
            steps.append(s)
        elif isinstance(s, dict):
            steps.append(RecipeStep.model_validate(s))

    # In DAG canvas preview, include_train_only=False (frozen metadata holds train-only cards)
    result_df, _ = apply_recipe_steps(
        df=df,
        steps=steps,
        include_train_only=False,
        fail_fast_mode=False,
    )

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    result_df.write_parquet(dest_path)
    return dest_path.as_posix()


def _execute_py_transform_node(
    project_key: str,
    node: NodeConfig,
    dag: PipelineDAG,
    dest_path: Path,
) -> str:
    """Execute custom Python transform script in a controlled sandbox."""
    incoming_edges = [e for e in dag.edges if e.target == node.node_id]
    if not incoming_edges:
        raise ValueError(f"Python transform node '{node.node_id}' has no incoming edge.")

    parent_node_id = incoming_edges[0].source
    parent_path = CACHE_DIR / project_key / f"{parent_node_id}.parquet"
    if not parent_path.exists():
        raise FileNotFoundError(f"Upstream Parquet not found for python node: {parent_path}")

    df = pl.read_parquet(parent_path)
    params = node.params or {}
    code_text = params.get("code", "")
    if not code_text.strip():
        raise ValueError(f"Python transform node '{node.node_id}' has empty code.")

    # Sandbox execution namespace
    sandbox_globals: Dict[str, Any] = {
        "pl": pl,
        "np": np,
        "duckdb": duckdb,
        "__builtins__": __builtins__,
    }
    sandbox_locals: Dict[str, Any] = {}

    exec(code_text, sandbox_globals, sandbox_locals)

    transform_fn = sandbox_locals.get("transform") or sandbox_globals.get("transform")
    if not callable(transform_fn):
        raise ValueError(
            f"Python transform node '{node.node_id}' must define 'def transform(df: pl.DataFrame) -> pl.DataFrame:'"
        )

    res_df = transform_fn(df)
    if not isinstance(res_df, pl.DataFrame):
        raise TypeError(
            f"transform() in node '{node.node_id}' must return a Polars DataFrame, got {type(res_df).__name__}."
        )

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    res_df.write_parquet(dest_path)
    return dest_path.as_posix()


def execute_node(
    project_key: str,
    node: NodeConfig,
    dag: PipelineDAG,
) -> str:
    """Execute a single DAG node based on its type and write result to Parquet cache."""
    dest_path = CACHE_DIR / project_key / f"{node.node_id}.parquet"

    if node.node_type == "ingestion":
        params = node.params or {}
        source_type = params.get("source_type", "local_file")
        return ingest_to_parquet(
            project_key=project_key,
            node_id=node.node_id,
            source_type=source_type,
            params=params,
        )

    elif node.node_type == "join":
        return _execute_join_node(project_key, node, dag, dest_path)

    elif node.node_type == "data_recipe":
        return _execute_recipe_node(project_key, node, dag, dest_path)

    elif node.node_type == "py_transform":
        return _execute_py_transform_node(project_key, node, dag, dest_path)

    elif node.node_type == "ml_studio":
        # Terminal node: ensures incoming upstream parquet exists
        incoming = [e for e in dag.edges if e.target == node.node_id]
        if incoming:
            parent_id = incoming[0].source
            parent_parquet = CACHE_DIR / project_key / f"{parent_id}.parquet"
            if not parent_parquet.exists():
                raise FileNotFoundError(f"ML Studio input Parquet missing: {parent_parquet}")
            return parent_parquet.as_posix()
        return dest_path.as_posix()

    else:
        raise ValueError(f"Unknown node type '{node.node_type}' for node '{node.node_id}'.")


def execute_dag(
    project_key: str,
    dag: Optional[PipelineDAG] = None,
    target_node_id: Optional[str] = None,
) -> Dict[str, str]:
    """Execute nodes in topological order up to target_node_id (or entire DAG).

    Args:
        project_key: Unique project key.
        dag: Optional PipelineDAG instance (loaded from DB if omitted).
        target_node_id: Optional target node. If provided, executes only its ancestor subgraph.

    Returns:
        Dict mapping node_id to generated Parquet cache file path.
    """
    if dag is None:
        dag = load_pipeline_dag(project_key)

    sorted_nodes = topological_sort(dag)

    # If target_node_id is specified, determine required ancestors
    nodes_to_run: List[NodeConfig] = []
    if target_node_id:
        # Build backwards adjacency
        parents_map: Dict[str, List[str]] = {n.node_id: [] for n in dag.nodes}
        for edge in dag.edges:
            parents_map[edge.target].append(edge.source)

        needed_ids: Set[str] = {target_node_id}
        queue = [target_node_id]
        while queue:
            curr = queue.pop(0)
            for p in parents_map.get(curr, []):
                if p not in needed_ids:
                    needed_ids.add(p)
                    queue.append(p)

        nodes_to_run = [n for n in sorted_nodes if n.node_id in needed_ids]
    else:
        nodes_to_run = sorted_nodes

    results: Dict[str, str] = {}
    for node in nodes_to_run:
        parquet_path = execute_node(project_key, node, dag)
        results[node.node_id] = parquet_path

    return results


def trace_node_lineage(
    project_key: str,
    target_node_id: str,
    dag: Optional[PipelineDAG] = None,
) -> Dict[str, Any]:
    """Trace the complete lineage upstream of target_node_id for model freezing.

    Collects all source ingestion configs, join operations, recipe steps (including
    is_train_only=True augmentation cards), and custom Python scripts.

    Args:
        project_key: Project identifier.
        target_node_id: Target node whose history is being traced.
        dag: Optional PipelineDAG instance (loaded from DB if omitted).

    Returns:
        Dictionary containing ordered lineage metadata ready for production promotion.
    """
    if dag is None:
        dag = load_pipeline_dag(project_key)

    node_map = {n.node_id: n for n in dag.nodes}
    if target_node_id not in node_map:
        raise KeyError(f"Target node '{target_node_id}' not found in DAG.")

    # Upstream BFS traversal
    parents_map: Dict[str, List[str]] = {n.node_id: [] for n in dag.nodes}
    for edge in dag.edges:
        parents_map[edge.target].append(edge.source)

    lineage_ids: Set[str] = {target_node_id}
    queue = [target_node_id]
    while queue:
        curr = queue.pop(0)
        for p in parents_map.get(curr, []):
            if p not in lineage_ids:
                lineage_ids.add(p)
                queue.append(p)

    # Order nodes topologically
    all_sorted = topological_sort(dag)
    ordered_lineage_nodes = [n for n in all_sorted if n.node_id in lineage_ids]

    source_nodes: List[Dict[str, Any]] = []
    joins: List[Dict[str, Any]] = []
    recipe_steps: List[Dict[str, Any]] = []
    python_scripts: List[Dict[str, Any]] = []

    for n in ordered_lineage_nodes:
        params = n.params or {}

        if n.node_type == "ingestion":
            source_nodes.append(
                {
                    "node_id": n.node_id,
                    "label": n.label,
                    "source_type": params.get("source_type", "local_file"),
                    "params": params,
                }
            )

        elif n.node_type == "join":
            joins.append(
                {
                    "node_id": n.node_id,
                    "label": n.label,
                    "join_type": params.get("join_type", "inner"),
                    "left_node_id": params.get("left_node_id"),
                    "right_node_id": params.get("right_node_id"),
                    "left_on": params.get("left_on"),
                    "right_on": params.get("right_on"),
                }
            )

        elif n.node_type == "data_recipe":
            steps_list = params.get("recipe_steps", [])
            for st in steps_list:
                if isinstance(st, RecipeStep):
                    recipe_steps.append(st.model_dump())
                elif isinstance(st, dict):
                    recipe_steps.append(st)

        elif n.node_type == "py_transform":
            python_scripts.append(
                {
                    "node_id": n.node_id,
                    "label": n.label,
                    "code": params.get("code", ""),
                }
            )

    return {
        "project_key": project_key,
        "target_node_id": target_node_id,
        "ordered_node_ids": [n.node_id for n in ordered_lineage_nodes],
        "source_nodes": source_nodes,
        "joins": joins,
        "recipe_steps": recipe_steps,
        "python_scripts": python_scripts,
        "lineage_nodes": [n.model_dump() for n in ordered_lineage_nodes],
    }

