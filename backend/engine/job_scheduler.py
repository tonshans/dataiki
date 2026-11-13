"""Dataiki 5-Carriage Batch Job Executor and Human-Friendly APScheduler.

Implements the 5-Carriage batch prediction architecture:
- Gerbong 1 (Source): Pull Polars DataFrame from DB Vault, Local File, or REST API.
- Gerbong 2 (Pre-Mapper): Optional user script def pre_map(df: pl.DataFrame) -> pl.DataFrame.
- Gerbong 3 (Model Engine): Predict using selected published production model version.
- Gerbong 4 (Post-Calculator): Optional script def post_calc(pred_df, raw_df, dataiki) -> pl.DataFrame.
- Gerbong 5 (Target Sink): Output to DB Table (append/replace), External REST API, or Local File (.xlsx/.csv/.parquet).

Includes human-friendly APScheduler sync without raw cron syntax.
"""

from __future__ import annotations

import datetime
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import polars as pl
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.interval import IntervalTrigger
from sqlalchemy import create_engine, text

from backend.config import ALLOW_FREESTYLE, UPLOADS_DIR
from backend.database import get_db
from backend.engine.ingestion import _ingest_from_file, _ingest_from_rest_api
from backend.engine.runtime_sdk import DataikiRuntimeSDK
from backend.engine.sandbox import load_sandboxed_function
from backend.engine.script_runner import run_freestyle_script
from backend.engine.sink_writer import write_dataframe_to_db_sink
from backend.engine.vault import get_connection_wrapper

logger = logging.getLogger("dataiki.scheduler")

# Singleton BackgroundScheduler instance
scheduler = BackgroundScheduler(daemon=True)


def _write_dataframe_to_db_sink(
    df: pl.DataFrame,
    conn_id: str,
    table_name: str,
    mode: str = "append",
) -> None:
    """Backward-compatible wrapper around the shared sink writer."""
    write_dataframe_to_db_sink(df, conn_id, table_name, mode=mode)


def run_batch_job(batch_job_id: str) -> Dict[str, Any]:
    """Execute full 5-Carriage batch prediction pipeline.

    Args:
        batch_job_id: Unique batch job identifier in batch_jobs table.

    Returns:
        Summary dict of execution status and row counts.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM batch_jobs WHERE batch_job_id = ?",
            (batch_job_id,),
        ).fetchone()

    if not row:
        raise KeyError(f"Batch job '{batch_job_id}' not found.")

    project_key = row["project_key"]
    model_version = int(row["model_version"])
    source_cfg: Dict[str, Any] = json.loads(row["source_config_json"] or "{}")
    sink_cfg: Dict[str, Any] = json.loads(row["sink_config_json"] or "{}")
    pre_mapper_code = str(row["pre_mapper_script"] or "").strip()
    post_calc_code = str(row["post_calc_script"] or "").strip()

    run_timestamp = datetime.datetime.now(datetime.timezone.utc).isoformat()

    # Mark as running
    with get_db() as conn:
        conn.execute(
            "UPDATE batch_jobs SET last_status = 'running', last_run_at = ?, last_error = '' WHERE batch_job_id = ?",
            (run_timestamp, batch_job_id),
        )

    try:
        # =================================================================
        # GERBONG 1: Source (DB Query, Local File, or REST API)
        # =================================================================
        stype = source_cfg.get("source_type", "file").lower().strip()
        if stype in ("db", "database", "sql"):
            conn_id = source_cfg.get("conn_id") or source_cfg.get("connection_name")
            query = source_cfg.get("query") or source_cfg.get("sql") or source_cfg.get("query_or_path")
            wrapper = get_connection_wrapper(conn_id)
            raw_df = wrapper.query_df(query)
        elif stype in ("file", "local_file"):
            fpath = source_cfg.get("file_path") or source_cfg.get("query_or_path")
            raw_df = _ingest_from_file({"file_path": fpath, "separator": source_cfg.get("separator", ",")})
        elif stype in ("api", "rest_api"):
            raw_df = _ingest_from_rest_api(source_cfg)
        else:
            raise ValueError(f"Unsupported source type '{stype}' in Gerbong 1.")

        # =================================================================
        # GERBONG 2: Pre-Mapper Script
        # =================================================================
        if pre_mapper_code:
            pre_map_fn = load_sandboxed_function(pre_mapper_code, "pre_map")
            mapped_df = pre_map_fn(raw_df)
            if not isinstance(mapped_df, pl.DataFrame):
                raise TypeError("pre_map() must return a Polars DataFrame.")
        else:
            mapped_df = raw_df

        # =================================================================
        # GERBONG 3: Model Engine (Predict using Production Model)
        # =================================================================
        sdk = DataikiRuntimeSDK(project_key)
        model = sdk.get_published_model(version=model_version)
        preds = model.predict(mapped_df)

        pred_col = f"prediction_{model.target_column}"
        pred_vals = preds if isinstance(preds, list) else (preds.tolist() if hasattr(preds, "tolist") else [preds])
        pred_df = mapped_df.with_columns(pl.Series(name=pred_col, values=pred_vals))

        if hasattr(model.model, "predict_proba"):
            try:
                probas = model.predict_proba(mapped_df)
                if isinstance(probas, list) and len(probas) == len(mapped_df):
                    pred_df = pred_df.with_columns(
                        pl.Series(name=f"probability_{model.target_column}", values=probas)
                    )
            except Exception:
                pass

        # =================================================================
        # GERBONG 4: Post-Calculator Script
        # =================================================================
        if post_calc_code:
            post_calc_fn = load_sandboxed_function(
                post_calc_code,
                "post_calc",
                extra_globals={"dataiki": sdk},
            )
            final_df = post_calc_fn(pred_df, raw_df, sdk)
            if not isinstance(final_df, pl.DataFrame):
                raise TypeError("post_calc() must return a Polars DataFrame.")
        else:
            final_df = pred_df

        # =================================================================
        # GERBONG 5: Target Sink (DB Table, External API, or Local File)
        # =================================================================
        sink_type = sink_cfg.get("sink_type", "local_file").lower().strip()
        sink_target_desc = ""

        if sink_type in ("db", "db_table", "database"):
            conn_id = sink_cfg.get("conn_id") or sink_cfg.get("connection_name")
            table_name = sink_cfg.get("table_name", "batch_predictions")
            mode = sink_cfg.get("mode", "append")
            _write_dataframe_to_db_sink(final_df, conn_id, table_name, mode=mode)
            sink_target_desc = f"Database Table '{table_name}' ({mode})"

        elif sink_type in ("api", "external_api", "rest_api"):
            url = sink_cfg.get("url")
            headers = sink_cfg.get("headers", {})
            method = (sink_cfg.get("method") or "POST").upper()
            records = final_df.to_dicts()
            with httpx.Client(timeout=60.0) as client:
                res = client.request(method=method, url=url, json=records, headers=headers)
                res.raise_for_status()
            sink_target_desc = f"REST API '{url}' (HTTP {res.status_code})"

        elif sink_type in ("file", "local_file"):
            fmt = sink_cfg.get("format", "parquet").lower()
            explicit_dest = sink_cfg.get("dest_path")
            output_dir = str(sink_cfg.get("output_dir") or "storage/exports").rstrip("/\\")
            dest_file = Path(explicit_dest or f"{output_dir}/batch_{batch_job_id}.{fmt}")
            dest_file.parent.mkdir(parents=True, exist_ok=True)
            if fmt == "parquet":
                final_df.write_parquet(dest_file)
            elif fmt in ("xlsx", "excel"):
                final_df.write_excel(dest_file)
            elif fmt in ("csv", "txt"):
                final_df.write_csv(dest_file)
            else:
                final_df.write_parquet(dest_file)
            sink_target_desc = f"Local File '{dest_file.as_posix()}'"
        else:
            raise ValueError(f"Unknown sink_type: '{sink_type}'")

        # Update success state
        with get_db() as conn:
            conn.execute(
                "UPDATE batch_jobs SET last_status = 'success', last_error = '' WHERE batch_job_id = ?",
                (batch_job_id,),
            )

        return {
            "batch_job_id": batch_job_id,
            "status": "success",
            "rows_processed": final_df.height,
            "sink_destination": sink_target_desc,
            "executed_at": run_timestamp,
        }

    except Exception as exc:
        err_msg = str(exc)
        logger.error(f"Batch job {batch_job_id} failed: {err_msg}")
        with get_db() as conn:
            conn.execute(
                "UPDATE batch_jobs SET last_status = 'failed', last_error = ? WHERE batch_job_id = ?",
                (err_msg, batch_job_id),
            )
        raise exc


def _trigger_from_config(cfg: Dict[str, Any]) -> Optional[Any]:
    """Translate a human-friendly schedule config into an APScheduler trigger."""
    enabled = cfg.get("enabled", False)
    mode = cfg.get("mode", "none")
    val = cfg.get("value", "")

    if not enabled or mode == "none":
        return None

    if mode == "every_minute":
        return IntervalTrigger(minutes=1)
    if mode == "every_hour":
        return IntervalTrigger(hours=1)
    if mode == "daily_at" and ":" in val:
        parts = val.split(":")
        return CronTrigger(hour=int(parts[0]), minute=int(parts[1]))
    if mode == "specific_date" and val:
        try:
            run_dt = datetime.datetime.strptime(val, "%Y-%m-%d %H:%M")
            return DateTrigger(run_date=run_dt)
        except Exception:
            return None
    return None


def sync_apscheduler_jobs() -> None:
    """Sync registered batch jobs and freestyle scripts to APScheduler.

    Translates human-friendly modes:
    - 'every_minute' -> IntervalTrigger(minutes=1)
    - 'every_hour' -> IntervalTrigger(hours=1)
    - 'daily_at' (HH:MM) -> CronTrigger(hour=HH, minute=MM)
    - 'specific_date' (YYYY-MM-DD HH:MM) -> DateTrigger(run_date=dt)
    """
    with get_db() as conn:
        rows = conn.execute("SELECT batch_job_id, schedule_config_json FROM batch_jobs").fetchall()

    expected_ids: set[str] = set()

    for row in rows:
        jid = row["batch_job_id"]
        try:
            cfg = json.loads(row["schedule_config_json"] or "{}")
        except Exception:
            cfg = {}

        trigger = _trigger_from_config(cfg)
        if trigger:
            expected_ids.add(jid)
            scheduler.add_job(
                run_batch_job,
                trigger=trigger,
                id=jid,
                replace_existing=True,
                args=[jid],
            )

    # Script Lab schedules live in the same scheduler; ids are 'fs_...' so they never clash.
    if ALLOW_FREESTYLE:
        with get_db() as conn:
            script_rows = conn.execute(
                "SELECT script_id, schedule_config_json FROM freestyle_scripts"
            ).fetchall()

        for row in script_rows:
            sid = row["script_id"]
            try:
                cfg = json.loads(row["schedule_config_json"] or "{}")
            except Exception:
                cfg = {}

            trigger = _trigger_from_config(cfg)
            if trigger:
                expected_ids.add(sid)
                scheduler.add_job(
                    run_freestyle_script,
                    trigger=trigger,
                    id=sid,
                    replace_existing=True,
                    args=[sid],
                )

    # Flow-group jobs ('fg_...') are owned by sync_flow_group_schedules(); never prune them here.
    for job in scheduler.get_jobs():
        if job.id.startswith("fg_"):
            continue
        if job.id not in expected_ids:
            scheduler.remove_job(job.id)


def start_scheduler() -> None:
    """Start APScheduler background runner if not already active."""
    if not scheduler.running:
        scheduler.start()
        sync_apscheduler_jobs()
        sync_flow_group_schedules()


def shutdown_scheduler() -> None:
    """Shutdown APScheduler background runner."""
    if scheduler.running:
        scheduler.shutdown(wait=False)


def sync_flow_group_schedules() -> None:
    """Sync all scheduled flow groups to APScheduler.

    Flow group job IDs are prefixed with 'fg_' to avoid clashing with
    batch job IDs (prefix 'bj_') and freestyle script IDs (prefix 'fs_').
    """
    from backend.engine.flow_group_runner import run_flow_group  # local import to avoid circular

    with get_db() as conn:
        rows = conn.execute(
            "SELECT group_id, schedule_config_json FROM flow_groups"
        ).fetchall()

    expected_ids: set[str] = set()

    for row in rows:
        gid = row["group_id"]
        job_id = f"fg_{gid}"
        try:
            cfg = json.loads(row["schedule_config_json"] or "{}")
        except Exception:
            cfg = {}

        trigger = _trigger_from_config(cfg)
        if trigger:
            expected_ids.add(job_id)
            scheduler.add_job(
                run_flow_group,
                trigger=trigger,
                id=job_id,
                replace_existing=True,
                args=[gid],
                kwargs={"output_format": "summary"},
            )

    # Drop flow-group jobs whose schedule was disabled or whose group was deleted.
    for job in scheduler.get_jobs():
        if job.id.startswith("fg_") and job.id not in expected_ids:
            scheduler.remove_job(job.id)

