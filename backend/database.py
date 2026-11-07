"""SQLite registry database connection manager and table initialization."""

import sqlite3
from contextlib import contextmanager
from typing import Generator

from backend.config import DB_PATH, ensure_directories

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS projects (
    project_key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    dag_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connections (
    conn_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    conn_type TEXT NOT NULL,
    connection_uri TEXT NOT NULL,
    headers_json TEXT DEFAULT '{}',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sql_snippets (
    snippet_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    sql_text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ml_sessions (
    session_id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    session_name TEXT NOT NULL,
    source_node_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    target_column TEXT NOT NULL,
    feature_columns_json TEXT NOT NULL,
    preprocessing_json TEXT NOT NULL,
    sample_limit INTEGER NOT NULL,
    test_size REAL NOT NULL,
    primary_metric TEXT NOT NULL,
    leaderboard_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ml_jobs (
    job_id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    pause_context_json TEXT DEFAULT '{}',
    result_json TEXT DEFAULT '{}',
    error_message TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'staged',
    task_type TEXT NOT NULL,
    algorithm TEXT NOT NULL,
    target_column TEXT NOT NULL,
    feature_columns_json TEXT NOT NULL,
    input_schema_json TEXT NOT NULL,
    metrics_json TEXT NOT NULL,
    hyperparameters_json TEXT NOT NULL,
    frozen_lineage_json TEXT NOT NULL,
    artifact_path TEXT NOT NULL,
    training_sample_path TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_key, version)
);

CREATE TABLE IF NOT EXISTS custom_endpoints (
    endpoint_id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    http_method TEXT NOT NULL,
    custom_path TEXT NOT NULL,
    handler_function TEXT NOT NULL,
    inference_script TEXT NOT NULL,
    model_version INTEGER NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(project_key, http_method, custom_path)
);

CREATE TABLE IF NOT EXISTS batch_jobs (
    batch_job_id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    job_name TEXT NOT NULL,
    model_version INTEGER NOT NULL,
    source_config_json TEXT NOT NULL,
    pre_mapper_script TEXT DEFAULT '',
    post_calc_script TEXT DEFAULT '',
    sink_config_json TEXT NOT NULL,
    schedule_config_json TEXT DEFAULT '{}',
    last_run_at TIMESTAMP,
    last_status TEXT DEFAULT 'never_run',
    last_error TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


@contextmanager
def get_db() -> Generator[sqlite3.Connection, None, None]:
    """Provide a transactional SQLite database connection context."""
    ensure_directories()
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Initialize all SQLite tables defined in the schema."""
    with get_db() as conn:
        conn.executescript(SCHEMA_SQL)


# Initialize database schema on load
init_db()

