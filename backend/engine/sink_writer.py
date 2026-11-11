"""Shared target-sink writers for batch jobs and canvas Data Output nodes."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

import polars as pl
from sqlalchemy import create_engine, text

from backend.engine.vault import get_connection


def get_writable_connection(conn_id: str) -> Dict[str, Any]:
    """Return a vault connection only if it exists and is not read-only."""
    conn_info = get_connection(conn_id)
    if not conn_info:
        raise KeyError(f"Destination connection '{conn_id}' not found in vault.")
    if conn_info.get("is_read_only", True):
        raise PermissionError(
            f"Cannot write data: connection '{conn_info.get('name', conn_id)}' is Read-Only. "
            "Uncheck 'Read-Only' on this saved connection in the Vault to allow sink writes."
        )
    return conn_info


def write_dataframe_to_db_sink(
    df: pl.DataFrame,
    conn_id: str,
    table_name: str,
    mode: str = "append",
) -> None:
    """Insert DataFrame records into a destination database table."""
    conn_info = get_writable_connection(conn_id)
    engine = create_engine(conn_info["connection_uri"])
    records = df.to_dicts()
    if not records:
        return

    cols = df.columns
    col_str = ", ".join([f'"{c}"' for c in cols])
    param_str = ", ".join([f":{c}" for c in cols])

    with engine.begin() as conn:
        if mode.lower() == "replace":
            conn.execute(text(f'DROP TABLE IF EXISTS "{table_name}"'))
            type_map = {
                pl.Int64: "BIGINT",
                pl.Int32: "INTEGER",
                pl.Float64: "FLOAT",
                pl.Float32: "FLOAT",
                pl.Boolean: "BOOLEAN",
                pl.Utf8: "TEXT",
                pl.Date: "DATE",
                pl.Datetime: "TIMESTAMP",
            }
            col_defs = [f'"{c}" {type_map.get(df[c].dtype, "TEXT")}' for c in cols]
            conn.execute(text(f'CREATE TABLE "{table_name}" ({", ".join(col_defs)})'))

        insert_stmt = text(f'INSERT INTO "{table_name}" ({col_str}) VALUES ({param_str})')
        conn.execute(insert_stmt, records)


def write_dataframe_to_file_sink(
    df: pl.DataFrame,
    dest_path: Path,
    fmt: str,
) -> Path:
    """Write DataFrame to parquet/csv/xlsx, creating parent folders as needed."""
    fmt = (fmt or "parquet").lower()
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "parquet":
        df.write_parquet(dest_path)
    elif fmt in ("xlsx", "excel"):
        df.write_excel(dest_path)
    elif fmt in ("csv", "txt"):
        df.write_csv(dest_path)
    else:
        raise ValueError(f"Unsupported file format '{fmt}'. Use parquet, csv, or xlsx.")
    return dest_path
