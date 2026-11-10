"""Dataiki Standalone Exporter Engine.

Generates self-contained, container-ready deployment packages with:
- Zero Vendor Lock-in: Standalone FastAPI REST API and Batch Scoring scripts.
- Strict Pinned Dependencies: Operator '==' generated via importlib.metadata.version.
- Jinja2 Template rendering for Dockerfile, requirements.txt, standalone_api, standalone_batch.
- Immutable production bundle (.joblib) packaged directly inside .zip archive.
"""

from __future__ import annotations

import importlib.metadata
import json
import os
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import jinja2

from backend.config import BASE_DIR, EXPORTS_DIR
from backend.database import get_db

TEMPLATES_DIR = BASE_DIR / "backend" / "templates"

# List of critical packages for standalone microservice runtime
STANDALONE_PACKAGES = [
    "fastapi",
    "uvicorn",
    "polars",
    "duckdb",
    "scikit-learn",
    "joblib",
    "numpy",
    "scipy",
    "lightgbm",
    "xgboost",
    "httpx",
    "openpyxl",
    "pydantic",
]


def _get_pinned_dependencies() -> Dict[str, str]:
    """Inspect local Python environment and return strictly pinned package versions."""
    pinned: Dict[str, str] = {}
    for pkg in STANDALONE_PACKAGES:
        try:
            ver = importlib.metadata.version(pkg)
            pinned[pkg] = ver
        except importlib.metadata.PackageNotFoundError:
            # Package not installed locally; fallback to default minimum
            pinned[pkg] = "latest"
    return pinned


def export_standalone_zip(
    project_key: str,
    version: int,
) -> str:
    """Export an immutable production model version as a zero-lockin standalone ZIP package.

    Args:
        project_key: Project identifier.
        version: Model version integer (e.g. 1).

    Returns:
        Absolute POSIX path string to the generated .zip archive in storage/exports/.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM model_versions WHERE project_key = ? AND version = ?",
            (project_key, version),
        ).fetchone()

    if not row:
        raise KeyError(f"Model version v{version} for project '{project_key}' not found.")

    artifact_path = Path(row["artifact_path"])
    if not artifact_path.exists():
        raise FileNotFoundError(f"Bundle artifact missing at {artifact_path}")

    # Pinned versions
    pinned_deps = _get_pinned_dependencies()

    template_vars: Dict[str, Any] = {
        "project_key": project_key,
        "version": version,
        "algorithm": row["algorithm"],
        "task_type": row["task_type"],
        "target_column": row["target_column"],
        "dependencies": pinned_deps,
    }

    # Setup Jinja2 Environment
    jinja_env = jinja2.Environment(
        loader=jinja2.FileSystemLoader(str(TEMPLATES_DIR)),
        autoescape=False,
    )

    req_tmpl = jinja_env.get_template("requirements.txt.j2")
    docker_tmpl = jinja_env.get_template("Dockerfile.j2")
    api_tmpl = jinja_env.get_template("standalone_api.py.j2")
    batch_tmpl = jinja_env.get_template("standalone_batch.py.j2")

    rendered_req = req_tmpl.render(**template_vars)
    rendered_docker = docker_tmpl.render(**template_vars)
    rendered_api = api_tmpl.render(**template_vars)
    rendered_batch = batch_tmpl.render(**template_vars)

    readme_content = f"""# Dataiki Standalone Production Microservice
Project: **{project_key}** | Algorithm: **{row['algorithm']}** | Version: **v{version}**

## Zero Vendor Lock-in Architecture
This package is completely standalone and runs independently of Dataiki.

### 1. Run with Docker (Recommended)
```bash
docker build -t {project_key.lower()}-v{version} .
docker run -p 8000:8000 {project_key.lower()}-v{version}
```

### 2. Run Locally with Python Virtualenv
```bash
python -m venv .venv
source .venv/bin/activate  # or .venv\\Scripts\\activate on Windows
pip install -r requirements.txt
python standalone_api.py
```

API will be live at `http://localhost:8000/docs`.

### 3. Run Standalone Batch Scoring
```bash
python standalone_batch.py --input test_data.csv --output scored_output.csv
```

> Catatan: input harus memuat kolom mentah yang dibutuhkan recipe dan python
> transform. Node ingestion/join tidak dijalankan ulang oleh package standalone.
"""

    EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    zip_dest = EXPORTS_DIR / f"{project_key}_v{version}_standalone.zip"

    # Create temporary packaging staging directory
    temp_dir = Path(tempfile.mkdtemp(prefix="dataiki_export_"))
    try:
        # Write rendered artifacts
        (temp_dir / "requirements.txt").write_text(rendered_req, encoding="utf-8")
        (temp_dir / "Dockerfile").write_text(rendered_docker, encoding="utf-8")
        (temp_dir / "standalone_api.py").write_text(rendered_api, encoding="utf-8")
        (temp_dir / "standalone_batch.py").write_text(rendered_batch, encoding="utf-8")
        shutil.copy2(
            BASE_DIR / "backend" / "engine" / "recipe_engine.py",
            temp_dir / "dataiki_recipe.py",
        )
        (temp_dir / "README.md").write_text(readme_content, encoding="utf-8")

        # Copy binary bundle.joblib
        shutil.copy2(artifact_path, temp_dir / "bundle.joblib")

        # Assemble zip archive
        with zipfile.ZipFile(zip_dest, "w", zipfile.ZIP_DEFLATED) as zipf:
            for item in sorted(temp_dir.iterdir()):
                if item.is_file():
                    zipf.write(item, arcname=item.name)

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

    return zip_dest.resolve().as_posix()

