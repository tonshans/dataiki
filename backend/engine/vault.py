"""Connection Vault and SQL Snippets management engine."""

import json
import logging
import os
import re
import sqlite3
import uuid
from typing import Any, Dict, List, Optional, Union

import httpx
import polars as pl

logger = logging.getLogger(__name__)

_MUTATION_KEYWORDS = {
    "insert",
    "update",
    "delete",
    "drop",
    "alter",
    "truncate",
    "create",
    "replace",
    "merge",
    "grant",
    "revoke",
    "call",
    "exec",
    "execute",
}


def is_modifying_query(sql: str) -> bool:
    """Detect if an SQL statement performs mutations (INSERT, UPDATE, DELETE, DDL)."""
    if not sql or not isinstance(sql, str):
        return False
    # Strip single-line comments (-- ...) and multi-line comments (/* ... */)
    cleaned = re.sub(r"--[^\n]*", " ", sql)
    cleaned = re.sub(r"/\*.*?\*/", " ", cleaned, flags=re.DOTALL)
    cleaned = cleaned.strip()

    tokens = [t.lower() for t in re.findall(r"[a-zA-Z_]+", cleaned)]
    if not tokens:
        return False

    first = tokens[0]
    if first in _MUTATION_KEYWORDS:
        return True

    # If query starts with WITH (CTE), check if mutation verbs exist in statement
    if first == "with":
        for kw in ("insert", "update", "delete", "drop", "alter", "truncate", "create", "replace"):
            if kw in tokens:
                return True

    return False


try:
    import oracledb
except ImportError:  # oracle driver optional
    oracledb = None  # type: ignore[assignment]

# Thick mode hanya jika diminta eksplisit; default thin mode (tanpa Instant Client).
if oracledb is not None and os.getenv("DATAIKI_ORACLE_THICK", "0") == "1":
    try:
        oracledb.init_oracle_client()
    except Exception as exc:
        logger.warning("Oracle thick client init failed, fallback to thin mode: %s", exc)

from sqlalchemy import create_engine, text

from backend.database import get_db
from backend.schemas import ConnectionCreate, SnippetCreate


class DatabaseConnectionWrapper:
    """Wrapper around external database connection for executing queries into Polars."""

    def __init__(self, conn_info: Dict[str, Any]) -> None:
        self.conn_id: str = conn_info.get("conn_id", "")
        self.name: str = conn_info.get("name", "")
        self.conn_type: str = conn_info.get("conn_type", "")
        self.connection_uri: str = conn_info.get("connection_uri", "")
        self.headers: Dict[str, Any] = conn_info.get("headers", {})
        self.is_read_only: bool = bool(conn_info.get("is_read_only", True))

    def query_df(self, sql: str, params: Optional[Dict[str, Any]] = None) -> pl.DataFrame:
        """Execute a query and load the result into a Polars DataFrame."""
        if self.conn_type == "rest_api":
            raise ValueError("Cannot execute SQL query on a REST API connection.")
        if self.is_read_only and is_modifying_query(sql):
            raise PermissionError(
                f"Database connection '{self.name}' is marked as Read-Only. "
                "Mutation queries (INSERT, UPDATE, DELETE, DDL) are prohibited. "
                "To allow modifications, uncheck 'Read-Only' on this connection in the Vault."
            )
        engine = create_engine(self.connection_uri)
        try:
            with engine.connect() as connection:
                # Use polars read_database via sqlalchemy connection
                return pl.read_database(query=sql, connection=connection)
        finally:
            engine.dispose()

    def execute(self, sql: str, params: Optional[Dict[str, Any]] = None) -> None:
        """Execute an SQL statement (DML/DDL) on the remote database."""
        if self.conn_type == "rest_api":
            raise ValueError("Cannot execute SQL statement on a REST API connection.")
        if self.is_read_only:
            raise PermissionError(
                f"Database connection '{self.name}' is marked as Read-Only. "
                "DML/DDL execution is prohibited. "
                "To allow modifications, uncheck 'Read-Only' on this connection in the Vault."
            )
        engine = create_engine(self.connection_uri)
        try:
            with engine.begin() as connection:
                connection.execute(text(sql), params or {})
        finally:
            engine.dispose()


# =====================================================================
# Connection Vault CRUD
# =====================================================================


def _format_conn_row(row) -> Dict[str, Any]:
    """Helper to convert a SQLite Row to a connection dict."""
    headers = {}
    raw_headers = row["headers_json"]
    if raw_headers:
        try:
            headers = json.loads(raw_headers)
        except Exception:
            headers = {}

    is_ro = True
    if "is_read_only" in row.keys():
        is_ro = bool(row["is_read_only"])

    return {
        "conn_id": row["conn_id"],
        "name": row["name"],
        "conn_type": row["conn_type"],
        "connection_uri": row["connection_uri"],
        "headers": headers,
        "headers_json": raw_headers,
        "is_read_only": is_ro,
        "created_at": row["created_at"],
    }


def create_connection(conn_data: Union[ConnectionCreate, Dict[str, Any]]) -> Dict[str, Any]:
    """Create a new external connection in the vault."""
    data = conn_data.model_dump() if isinstance(conn_data, ConnectionCreate) else conn_data
    conn_id = data.get("conn_id") or f"conn_{uuid.uuid4().hex[:12]}"
    name = data["name"]
    conn_type = data["conn_type"]
    connection_uri = data["connection_uri"]
    headers = data.get("headers", {})
    headers_json = json.dumps(headers) if isinstance(headers, dict) else str(headers)
    is_read_only = 1 if data.get("is_read_only", True) else 0

    with get_db() as db:
        try:
            db.execute(
                """
                INSERT INTO connections (conn_id, name, conn_type, connection_uri, headers_json, is_read_only)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (conn_id, name, conn_type, connection_uri, headers_json, is_read_only),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Connection name '{name}' already exists.") from exc

    saved = get_connection(conn_id)
    if not saved:
        raise RuntimeError(f"Failed to create connection with id '{conn_id}'")
    return saved


def get_connection(conn_id_or_name: str) -> Optional[Dict[str, Any]]:
    """Retrieve a connection by conn_id or unique name."""
    with get_db() as db:
        row = db.execute(
            """
            SELECT conn_id, name, conn_type, connection_uri, headers_json, is_read_only, created_at
            FROM connections
            WHERE conn_id = ? OR name = ?
            LIMIT 1
            """,
            (conn_id_or_name, conn_id_or_name),
        ).fetchone()

        if row:
            return _format_conn_row(row)
        return None


def list_connections() -> List[Dict[str, Any]]:
    """List all registered external connections."""
    with get_db() as db:
        rows = db.execute(
            """
            SELECT conn_id, name, conn_type, connection_uri, headers_json, is_read_only, created_at
            FROM connections
            ORDER BY created_at DESC
            """
        ).fetchall()
        return [_format_conn_row(row) for row in rows]


def update_connection(conn_id: str, conn_data: Union[ConnectionCreate, Dict[str, Any]]) -> Dict[str, Any]:
    """Update an existing external connection."""
    existing = get_connection(conn_id)
    if not existing:
        raise KeyError(f"Connection with id '{conn_id}' not found.")

    data = conn_data.model_dump() if isinstance(conn_data, ConnectionCreate) else conn_data
    name = data.get("name", existing["name"])
    conn_type = data.get("conn_type", existing["conn_type"])
    connection_uri = data.get("connection_uri", existing["connection_uri"])
    headers = data.get("headers", existing["headers"])
    headers_json = json.dumps(headers) if isinstance(headers, dict) else str(headers)
    is_read_only = 1 if data.get("is_read_only", existing.get("is_read_only", True)) else 0

    with get_db() as db:
        try:
            db.execute(
                """
                UPDATE connections
                SET name = ?, conn_type = ?, connection_uri = ?, headers_json = ?, is_read_only = ?
                WHERE conn_id = ?
                """,
                (name, conn_type, connection_uri, headers_json, is_read_only, conn_id),
            )
        except sqlite3.IntegrityError as exc:
            raise ValueError(f"Connection name '{name}' already exists.") from exc

    updated = get_connection(conn_id)
    if not updated:
        raise RuntimeError(f"Failed to retrieve updated connection '{conn_id}'")
    return updated


def delete_connection(conn_id: str) -> bool:
    """Delete a connection from the vault."""
    with get_db() as db:
        cursor = db.execute("DELETE FROM connections WHERE conn_id = ?", (conn_id,))
        return cursor.rowcount > 0


def test_connection(
    conn_type: str,
    connection_uri: str,
    headers: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Test connectivity for database or REST API without persisting."""
    try:
        if conn_type == "rest_api":
            with httpx.Client(timeout=10.0) as client:
                res = client.get(connection_uri, headers=headers or {})
                if res.status_code < 400:
                    return {
                        "success": True,
                        "status_code": res.status_code,
                        "message": f"REST API responded with HTTP {res.status_code}",
                    }
                else:
                    return {
                        "success": False,
                        "status_code": res.status_code,
                        "message": f"REST API returned HTTP error {res.status_code}: {res.text[:200]}",
                    }
        else:
            engine = create_engine(connection_uri)
            try:
                with engine.connect() as conn:
                    if 'oracle' in connection_uri :
                        conn.execute(text("SELECT 1 from dual"))
                    else:
                        conn.execute(text("SELECT 1"))
                return {"success": True, "message": f"Successfully connected to {conn_type} database."}
            finally:
                engine.dispose()
    except Exception as exc:
        return {"success": False, "message": str(exc)}


def get_connection_wrapper(conn_id_or_name: str) -> DatabaseConnectionWrapper:
    """Get a DatabaseConnectionWrapper object by connection id or name."""
    info = get_connection(conn_id_or_name)
    if not info:
        raise KeyError(f"Vault connection '{conn_id_or_name}' not found.")
    return DatabaseConnectionWrapper(info)


# =====================================================================
# SQL Snippets CRUD
# =====================================================================


def _format_snippet_row(row) -> Dict[str, Any]:
    """Helper to convert a SQLite Row to a snippet dict."""
    return {
        "snippet_id": row["snippet_id"],
        "title": row["title"],
        "sql_text": row["sql_text"],
        "created_at": row["created_at"],
    }


def create_snippet(snippet_data: Union[SnippetCreate, Dict[str, Any]]) -> Dict[str, Any]:
    """Create a new SQL snippet in the vault."""
    data = snippet_data.model_dump() if isinstance(snippet_data, SnippetCreate) else snippet_data
    snippet_id = data.get("snippet_id") or f"snip_{uuid.uuid4().hex[:12]}"
    title = data["title"]
    sql_text = data["sql_text"]

    with get_db() as db:
        db.execute(
            """
            INSERT INTO sql_snippets (snippet_id, title, sql_text)
            VALUES (?, ?, ?)
            """,
            (snippet_id, title, sql_text),
        )

    saved = get_snippet(snippet_id)
    if not saved:
        raise RuntimeError(f"Failed to create SQL snippet with id '{snippet_id}'")
    return saved


def get_snippet(snippet_id: str) -> Optional[Dict[str, Any]]:
    """Retrieve an SQL snippet by id."""
    with get_db() as db:
        row = db.execute(
            """
            SELECT snippet_id, title, sql_text, created_at
            FROM sql_snippets
            WHERE snippet_id = ?
            LIMIT 1
            """,
            (snippet_id,),
        ).fetchone()

        if row:
            return _format_snippet_row(row)
        return None


def list_snippets() -> List[Dict[str, Any]]:
    """List all saved SQL snippets."""
    with get_db() as db:
        rows = db.execute(
            """
            SELECT snippet_id, title, sql_text, created_at
            FROM sql_snippets
            ORDER BY created_at DESC
            """
        ).fetchall()
        return [_format_snippet_row(row) for row in rows]


def update_snippet(snippet_id: str, snippet_data: Union[SnippetCreate, Dict[str, Any]]) -> Dict[str, Any]:
    """Update an existing SQL snippet."""
    existing = get_snippet(snippet_id)
    if not existing:
        raise KeyError(f"SQL Snippet with id '{snippet_id}' not found.")

    data = snippet_data.model_dump() if isinstance(snippet_data, SnippetCreate) else snippet_data
    title = data.get("title", existing["title"])
    sql_text = data.get("sql_text", existing["sql_text"])

    with get_db() as db:
        db.execute(
            """
            UPDATE sql_snippets
            SET title = ?, sql_text = ?
            WHERE snippet_id = ?
            """,
            (title, sql_text, snippet_id),
        )

    updated = get_snippet(snippet_id)
    if not updated:
        raise RuntimeError(f"Failed to retrieve updated snippet '{snippet_id}'")
    return updated


def delete_snippet(snippet_id: str) -> bool:
    """Delete an SQL snippet from the vault."""
    with get_db() as db:
        cursor = db.execute("DELETE FROM sql_snippets WHERE snippet_id = ?", (snippet_id,))
        return cursor.rowcount > 0

