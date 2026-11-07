"""Dataiki Command Line Interface (CLI).

Provides terminal execution utilities for:
- Running 5-Carriage batch jobs (dataiki run-job <job_id>).
- Retraining published models on fresh data (dataiki retrain <project> <version>).
- Running System Janitor garbage collection (dataiki purge-janitor).
- Exporting zero-lockin standalone microservices (dataiki export <project> <version>).
- Starting backend server (dataiki start).
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import List, Optional

from backend.config import ensure_directories
from backend.database import init_db
from backend.engine.exporter import export_standalone_zip
from backend.engine.janitor import purge_storage_janitor, scan_storage_janitor
from backend.engine.job_scheduler import run_batch_job
from backend.engine.ml_tuner import retrain_published_model


def main(args: Optional[List[str]] = None) -> None:
    """CLI Entrypoint parser."""
    ensure_directories()
    init_db()

    parser = argparse.ArgumentParser(
        prog="dataiki",
        description="Dataiki CLI - Terminal runner for batch jobs, model retraining, and exports.",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available subcommands")

    # 1. run-job
    p_job = subparsers.add_parser("run-job", help="Execute a 5-Carriage batch job by ID")
    p_job.add_argument("batch_job_id", help="Unique identifier of batch job in registry")

    # 2. retrain
    p_retrain = subparsers.add_parser("retrain", help="Retrain a published model with locked parameters")
    p_retrain.add_argument("project_key", help="Project identifier")
    p_retrain.add_argument("version", type=int, help="Base active model version integer (e.g. 1)")

    # 3. purge-janitor
    p_janitor = subparsers.add_parser("purge-janitor", help="Execute garbage collection on orphaned storage")
    p_janitor.add_argument("--no-caches", action="store_true", help="Do not purge orphaned caches")
    p_janitor.add_argument("--no-models", action="store_true", help="Do not purge unpublished model artifacts")

    # 4. export
    p_export = subparsers.add_parser("export", help="Export standalone microservice ZIP bundle")
    p_export.add_argument("project_key", help="Project identifier")
    p_export.add_argument("version", type=int, help="Model version integer")

    # 5. start
    p_start = subparsers.add_parser("start", help="Start Dataiki FastAPI backend server")
    p_start.add_argument("--host", default="0.0.0.0", help="Binding host address")
    p_start.add_argument("--port", type=int, default=8000, help="Port to listen on")
    p_start.add_argument("--reload", action="store_true", help="Enable live auto-reload")

    parsed = parser.parse_args(args)

    if not parsed.command:
        parser.print_help()
        sys.exit(0)

    try:
        if parsed.command == "run-job":
            print(f"[Dataiki CLI] Running batch job '{parsed.batch_job_id}'...")
            res = run_batch_job(parsed.batch_job_id)
            print(json.dumps(res, indent=2))

        elif parsed.command == "retrain":
            print(f"[Dataiki CLI] Retraining model v{parsed.version} for project '{parsed.project_key}'...")
            res = retrain_published_model(parsed.project_key, parsed.version)
            print(json.dumps(res, indent=2))

        elif parsed.command == "purge-janitor":
            print("[Dataiki CLI] Running storage audit before purge...")
            before = scan_storage_janitor()
            print(f"  Reclaimable space: {before['total_reclaimable_mb']} MB")
            res = purge_storage_janitor(
                purge_orphaned_caches=not parsed.no_caches,
                purge_unpublished_models=not parsed.no_models,
            )
            print(f"[Dataiki CLI] Purged {res['purged_files_count']} files, freed {res['purged_mb']} MB.")

        elif parsed.command == "export":
            print(f"[Dataiki CLI] Packaging standalone microservice for '{parsed.project_key}' v{parsed.version}...")
            zip_p = export_standalone_zip(parsed.project_key, parsed.version)
            print(f"[Dataiki CLI] Export complete: {zip_p}")

        elif parsed.command == "start":
            import uvicorn
            print(f"[Dataiki CLI] Starting backend on http://{parsed.host}:{parsed.port}...")
            uvicorn.run("backend.main:app", host=parsed.host, port=parsed.port, reload=parsed.reload)

    except Exception as exc:
        print(f"[Dataiki CLI ERROR] {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

