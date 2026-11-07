"""Dataiki System Routes.

Handles:
- Projects CRUD.
- Vault Connections CRUD and connectivity testing.
- SQL Snippets library CRUD.
- Local uploads scanning and HTTP file upload handler.
- System Janitor storage audit and purge operations.
"""

from __future__ import annotations

import datetime
import json
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from backend.config import UPLOADS_DIR
from backend.database import get_db
from backend.engine.ingestion import list_local_uploads
from backend.engine.janitor import purge_storage_janitor, scan_storage_janitor
from backend.engine.vault import (
    create_connection,
    create_snippet,
    delete_connection,
    delete_snippet,
    get_connection,
    get_snippet,
    list_connections,
    list_snippets,
    test_connection,
    update_connection,
    update_snippet,
)
from backend.schemas import (
    ConnectionCreate,
    ConnectionTestRequest,
    JanitorPurgeRequest,
    ProjectCreate,
    SnippetCreate,
)

router = APIRouter(prefix="/api/system", tags=["System & Settings"])


# =====================================================================
# 1. Projects Management
# =====================================================================


@router.post("/projects", status_code=status.HTTP_201_CREATED)
def create_or_update_project(payload: ProjectCreate) -> Dict[str, Any]:
    """Create a new project or update basic metadata."""
    now_str = datetime.datetime.now(datetime.timezone.utc).isoformat()
    dag_str = payload.dag_json or json.dumps({"project_key": payload.project_key, "nodes": [], "edges": []})

    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO projects (project_key, name, description, dag_json, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(project_key) DO UPDATE SET
                name = excluded.name,
                description = excluded.description,
                dag_json = COALESCE(NULLIF(excluded.dag_json, ''), projects.dag_json),
                updated_at = excluded.updated_at
            """,
            (payload.project_key, payload.name, payload.description, dag_str, now_str),
        )

    return {
        "project_key": payload.project_key,
        "name": payload.name,
        "description": payload.description,
        "status": "saved",
    }


@router.get("/projects")
def list_all_projects() -> List[Dict[str, Any]]:
    """List all workspace projects."""
    with get_db() as conn:
        rows = conn.execute("SELECT project_key, name, description, created_at, updated_at FROM projects ORDER BY updated_at DESC").fetchall()
    return [dict(r) for r in rows]


@router.get("/projects/{project_key}")
def get_project_by_key(project_key: str) -> Dict[str, Any]:
    """Fetch project details including serialized DAG."""
    with get_db() as conn:
        row = conn.execute("SELECT * FROM projects WHERE project_key = ?", (project_key,)).fetchone()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{project_key}' not found.")
    return dict(row)


@router.delete("/projects/{project_key}")
def delete_project_by_key(project_key: str) -> Dict[str, str]:
    """Delete a project and its associated metadata."""
    with get_db() as conn:
        cur = conn.execute("DELETE FROM projects WHERE project_key = ?", (project_key,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Project '{project_key}' not found.")
        # Cascade delete related entries
        conn.execute("DELETE FROM model_versions WHERE project_key = ?", (project_key,))
        conn.execute("DELETE FROM ml_sessions WHERE project_key = ?", (project_key,))
        conn.execute("DELETE FROM ml_jobs WHERE project_key = ?", (project_key,))
        conn.execute("DELETE FROM custom_endpoints WHERE project_key = ?", (project_key,))
        conn.execute("DELETE FROM batch_jobs WHERE project_key = ?", (project_key,))

    return {"status": "deleted", "project_key": project_key}


# =====================================================================
# 2. Vault Connections
# =====================================================================


@router.post("/connections", status_code=status.HTTP_201_CREATED)
def create_vault_connection(payload: ConnectionCreate) -> Dict[str, Any]:
    """Store external database or REST API connection credentials."""
    return create_connection(payload)


@router.get("/connections")
def list_vault_connections() -> List[Dict[str, Any]]:
    """List all registered external connections."""
    return list_connections()


@router.get("/connections/{conn_id}")
def get_vault_connection(conn_id: str) -> Dict[str, Any]:
    """Get connection details by ID."""
    conn_info = get_connection(conn_id)
    if not conn_info:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Connection '{conn_id}' not found.")
    return conn_info


@router.put("/connections/{conn_id}")
def update_vault_connection(conn_id: str, payload: ConnectionCreate) -> Dict[str, Any]:
    """Update existing vault connection."""
    try:
        return update_connection(conn_id, payload)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Connection '{conn_id}' not found.")


@router.delete("/connections/{conn_id}")
def delete_vault_connection(conn_id: str) -> Dict[str, str]:
    """Delete connection from vault."""
    ok = delete_connection(conn_id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Connection '{conn_id}' not found.")
    return {"status": "deleted", "conn_id": conn_id}


@router.post("/connections/test")
def test_vault_connection(payload: ConnectionTestRequest) -> Dict[str, Any]:
    """Test connectivity for database or REST API without persisting."""
    return test_connection(
        conn_type=payload.conn_type,
        connection_uri=payload.connection_uri,
        headers=payload.headers,
    )


# =====================================================================
# 3. SQL Snippets
# =====================================================================


@router.post("/snippets", status_code=status.HTTP_201_CREATED)
def create_sql_snippet(payload: SnippetCreate) -> Dict[str, Any]:
    """Create a new reusable SQL snippet."""
    return create_snippet(payload)


@router.get("/snippets")
def list_all_snippets() -> List[Dict[str, Any]]:
    """List all saved SQL snippets."""
    return list_snippets()


@router.get("/snippets/{snippet_id}")
def get_snippet_by_id(snippet_id: str) -> Dict[str, Any]:
    """Get SQL snippet by ID."""
    snip = get_snippet(snippet_id)
    if not snip:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Snippet '{snippet_id}' not found.")
    return snip


@router.put("/snippets/{snippet_id}")
def update_sql_snippet(snippet_id: str, payload: SnippetCreate) -> Dict[str, Any]:
    """Update SQL snippet title and SQL code."""
    try:
        return update_snippet(snippet_id, payload)
    except KeyError:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Snippet '{snippet_id}' not found.")


@router.delete("/snippets/{snippet_id}")
def delete_sql_snippet(snippet_id: str) -> Dict[str, str]:
    """Delete SQL snippet."""
    ok = delete_snippet(snippet_id)
    if not ok:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Snippet '{snippet_id}' not found.")
    return {"status": "deleted", "snippet_id": snippet_id}


# =====================================================================
# 4. Local File Uploads
# =====================================================================


@router.get("/uploads")
def list_uploads() -> List[Dict[str, Any]]:
    """Scan and list all local files available in storage/uploads/."""
    return list_local_uploads()


@router.post("/uploads", status_code=status.HTTP_201_CREATED)
async def upload_local_file(file: UploadFile = File(...)) -> Dict[str, Any]:
    """Handle multipart file upload into storage/uploads/ directory."""
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded file missing filename.")

    dest_path = UPLOADS_DIR / file.filename
    try:
        with dest_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    finally:
        await file.close()

    stat = dest_path.stat()
    return {
        "file_name": dest_path.name,
        "file_path": dest_path.as_posix(),
        "file_size_bytes": stat.st_size,
        "file_size_mb": round(stat.st_size / (1024 * 1024), 2),
        "status": "uploaded",
    }


# =====================================================================
# 5. System Janitor (Garbage Collection)
# =====================================================================


@router.get("/janitor/scan")
def janitor_scan() -> Dict[str, Any]:
    """Audit local storage and categorize into orphaned, unpublished, and protected assets."""
    return scan_storage_janitor()


@router.post("/janitor/purge")
def janitor_purge(payload: JanitorPurgeRequest) -> Dict[str, Any]:
    """Safely purge orphaned caches and unpublished models without touching protected assets."""
    return purge_storage_janitor(
        purge_orphaned_caches=payload.purge_orphaned_caches,
        purge_unpublished_models=payload.purge_unpublished_models,
    )
