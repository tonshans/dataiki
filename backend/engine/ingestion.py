"""Data Ingestion engine supporting Local Uploads, Database Queries, and REST APIs."""

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import polars as pl
from sqlalchemy import create_engine

from backend.config import CACHE_DIR, UPLOADS_DIR
from backend.engine.vault import get_connection


def list_local_uploads() -> List[Dict[str, Any]]:
    """Scan storage/uploads/ directory and return metadata of available files."""
    if not UPLOADS_DIR.exists():
        UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
        return []

    results: List[Dict[str, Any]] = []
    # Search all files in uploads directory
    for item in sorted(UPLOADS_DIR.iterdir()):
        if item.is_file():
            stat = item.stat()
            size_mb = round(stat.st_size / (1024 * 1024), 2)
            modified_dt = datetime.fromtimestamp(stat.st_mtime).isoformat()
            results.append(
                {
                    "file_name": item.name,
                    "file_path": item.as_posix(),
                    "file_size_bytes": stat.st_size,
                    "file_size_mb": size_mb,
                    "modified_at": modified_dt,
                    "file_extension": item.suffix.lower(),
                }
            )
    return results


def _resolve_file_path(params: Dict[str, Any]) -> Path:
    """Resolve file path from parameters, searching in UPLOADS_DIR if relative."""
    raw_path = params.get("file_path") or params.get("file_name")
    if not raw_path:
        raise ValueError("Missing 'file_path' or 'file_name' in ingestion params.")

    path_obj = Path(raw_path)
    if path_obj.is_absolute() and path_obj.exists():
        return path_obj

    candidate = UPLOADS_DIR / path_obj.name
    if candidate.exists():
        return candidate

    if path_obj.exists():
        return path_obj

    raise FileNotFoundError(f"File '{raw_path}' not found on filesystem or in {UPLOADS_DIR}.")


def _ingest_from_file(params: Dict[str, Any]) -> pl.DataFrame:
    """Read local file into Polars DataFrame without using Pandas."""
    file_path = _resolve_file_path(params)
    ext = file_path.suffix.lower()

    if ext == ".parquet":
        return pl.read_parquet(file_path)
    elif ext in [".csv", ".txt"]:
        separator = params.get("separator", ",")
        # Use scan_csv for out-of-core memory safety
        return pl.scan_csv(
            file_path,
            separator=separator,
            infer_schema_length=10000,
            ignore_errors=True,
        ).collect(engine="streaming")
    elif ext == ".tsv":
        return pl.scan_csv(
            file_path,
            separator="\t",
            infer_schema_length=10000,
            ignore_errors=True,
        ).collect(engine="streaming")
    elif ext in [".xlsx", ".xls"]:
        sheet_name = params.get("sheet_name")
        sheet_id = params.get("sheet_id", 1)
        if sheet_name:
            return pl.read_excel(file_path, sheet_name=sheet_name)
        return pl.read_excel(file_path, sheet_id=sheet_id)
    elif ext == ".json":
        return pl.read_json(file_path)
    else:
        raise ValueError(f"Unsupported file format '{ext}'. Supported: .parquet, .csv, .tsv, .xlsx, .xls, .json")


def _ingest_from_database(params: Dict[str, Any]) -> pl.DataFrame:
    """Pull query result from external database into Polars DataFrame.

    Uses DuckDB ATTACH for chunked reading to avoid OOM on large result sets.
    Falls back to SQLAlchemy pl.read_database_uri with batch_size for non-DuckDB sources.
    """
    conn_id_or_name = params.get("conn_id") or params.get("connection_name")
    if not conn_id_or_name:
        raise ValueError("Database ingestion requires 'conn_id' or 'connection_name'.")

    sql_query = params.get("query") or params.get("sql")
    if not sql_query:
        raise ValueError("Database ingestion requires 'query' or 'sql' parameter.")

    conn_info = get_connection(conn_id_or_name)
    if not conn_info:
        raise KeyError(f"Vault connection '{conn_id_or_name}' not found.")

    connection_uri: str = conn_info["connection_uri"]
    batch_size: int = int(params.get("batch_size", 100_000))

    # DuckDB-native sources: use ATTACH for zero-copy streaming (avoids full RAM load)
    if connection_uri.startswith("duckdb:///") or connection_uri.startswith("duckdb://"):
        db_path = connection_uri.replace("duckdb:///", "").replace("duckdb://", "")
        con = duckdb.connect(database=db_path, read_only=True)
        try:
            return con.execute(sql_query).pl()
        finally:
            con.close()

    # SQLAlchemy sources: batch-read via pl.read_database to prevent OOM
    # batch_size caps rows materialised in RAM at any time
    engine = create_engine(connection_uri)
    try:
        with engine.connect() as connection:
            chunks: List[pl.DataFrame] = []
            for chunk in pl.read_database(
                query=sql_query,
                connection=connection,
                iter_batches=True,
                batch_size=batch_size,
            ):
                chunks.append(chunk)
            if not chunks:
                return pl.DataFrame()
            return pl.concat(chunks, how="diagonal_relaxed")
    finally:
        engine.dispose()


def _ingest_from_rest_api(params: Dict[str, Any]) -> pl.DataFrame:
    """Fetch REST API data, flatten JSON, and convert into Polars DataFrame."""
    url = params.get("url")
    headers: Dict[str, Any] = params.get("headers", {})

    conn_id_or_name = params.get("conn_id") or params.get("connection_name")
    if conn_id_or_name:
        conn_info = get_connection(conn_id_or_name)
        if conn_info:
            if not url:
                url = conn_info.get("connection_uri")
            # Merge vault headers with call-specific headers
            vault_headers = conn_info.get("headers") or {}
            headers = {**vault_headers, **headers}

    if not url:
        raise ValueError("REST API ingestion requires 'url' or a configured connection.")

    method = (params.get("method") or "GET").upper()
    query_params = params.get("params") or params.get("query_params")
    json_payload = params.get("json_payload")
    records_path = params.get("records_path")

    with httpx.Client(timeout=30.0) as client:
        res = client.request(
            method=method,
            url=url,
            headers=headers,
            params=query_params,
            json=json_payload,
        )
        res.raise_for_status()
        raw_json = res.json()

    # Extract array of records
    records: Any = raw_json
    if records_path and isinstance(raw_json, dict):
        parts = records_path.split(".")
        current = raw_json
        for part in parts:
            if isinstance(current, dict) and part in current:
                current = current[part]
            else:
                current = None
                break
        records = current

    if isinstance(records, dict):
        # Look for standard keys like data, items, results
        for candidate_key in ["data", "items", "results", "records"]:
            if candidate_key in records and isinstance(records[candidate_key], list):
                records = records[candidate_key]
                break

    if isinstance(records, list):
        if not records:
            return pl.DataFrame()
        return pl.DataFrame(records)
    elif isinstance(records, dict):
        return pl.DataFrame([records])
    else:
        raise ValueError(f"Unable to parse API response as tabular records: {type(records).__name__}")


def ingest_to_parquet(
    project_key: str,
    node_id: str,
    source_type: str,
    params: Dict[str, Any],
) -> str:
    """Ingest data from diverse sources and persist to the single Parquet contract."""
    source_type_normalized = source_type.lower().strip()

    if source_type_normalized in ["file", "local_file", "upload"]:
        df = _ingest_from_file(params)
    elif source_type_normalized in ["db", "database", "db_query", "sql"]:
        df = _ingest_from_database(params)
    elif source_type_normalized in ["rest_api", "api", "http"]:
        df = _ingest_from_rest_api(params)
    else:
        raise ValueError(
            f"Unsupported source_type '{source_type}'. "
            "Supported types: 'local_file', 'db', 'rest_api'"
        )

    # Destination: storage/cache/{project_key}/{node_id}.parquet
    dest_path = CACHE_DIR / project_key / f"{node_id}.parquet"
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    df.write_parquet(dest_path)
    return dest_path.as_posix()

