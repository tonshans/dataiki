"""Dataiki System Janitor (Garbage Collection).

Safely audits and purges local storage assets across 3 distinct tiers:
1. Orphaned Caches: Cache Parquet files not connected to active/staged production models.
2. Unpublished Models: Archived or discarded model artifacts.
3. Protected Production Assets: Files belonging to ACTIVE or STAGED models (LOCKED from deletion).
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from backend.config import ARTIFACTS_DIR, CACHE_DIR
from backend.database import get_db


def _normalize_path_str(p: Union[str, Path]) -> str:
    """Normalize file path to POSIX string for reliable comparison."""
    return Path(p).resolve().as_posix().lower()


def scan_storage_janitor() -> Dict[str, Any]:
    """Scan local storage (cache and artifacts) and classify into 3 tiers.

    Returns:
        Structured report with counts, sizes (bytes & MB), and file details for:
        - orphaned_caches
        - unpublished_models
        - protected_production_assets
    """
    # 1. Gather all active and staged production models from database
    protected_artifact_paths: Set[str] = set()
    protected_cache_keys: Set[Tuple[str, str]] = set()  # (project_key, node_id)

    with get_db() as conn:
        rows = conn.execute(
            """
            SELECT project_key, version, status, artifact_path, training_sample_path, frozen_lineage_json
            FROM model_versions
            WHERE status IN ('active', 'staged')
            """
        ).fetchall()

    for row in rows:
        proj_key = str(row["project_key"]).strip().lower()

        art_p = row["artifact_path"]
        if art_p:
            protected_artifact_paths.add(_normalize_path_str(art_p))
            # Also protect parent folder of version bundle
            protected_artifact_paths.add(_normalize_path_str(Path(art_p).parent))

        sample_p = row["training_sample_path"]
        if sample_p:
            protected_artifact_paths.add(_normalize_path_str(sample_p))

        # Extract lineage nodes to protect intermediate cache parquets
        try:
            lineage = json.loads(row["frozen_lineage_json"] or "{}")
            node_ids = lineage.get("ordered_node_ids", [])
            for nid in node_ids:
                protected_cache_keys.add((proj_key, str(nid).strip().lower()))
            target_nid = lineage.get("target_node_id")
            if target_nid:
                protected_cache_keys.add((proj_key, str(target_nid).strip().lower()))
        except Exception:
            pass

    orphaned_caches: List[Dict[str, Any]] = []
    unpublished_models: List[Dict[str, Any]] = []
    protected_assets: List[Dict[str, Any]] = []

    # 2. Audit storage/cache/
    if CACHE_DIR.exists():
        for item in CACHE_DIR.rglob("*"):
            if item.is_file():
                size = item.stat().st_size
                rel = item.relative_to(CACHE_DIR)
                parts = rel.parts
                proj_name = parts[0].lower() if len(parts) > 1 else ""
                node_stem = item.stem.lower()

                # Check if this parquet node belongs to an active/staged lineage
                is_protected = (proj_name, node_stem) in protected_cache_keys

                info = {
                    "path": item.as_posix(),
                    "relative_path": rel.as_posix(),
                    "size_bytes": size,
                    "size_mb": round(size / (1024 * 1024), 3),
                    "file_type": "cache_parquet",
                }

                if is_protected:
                    info["category"] = "protected_production_assets"
                    info["reason"] = f"Protected DAG node for active/staged model ({proj_name})"
                    protected_assets.append(info)
                else:
                    info["category"] = "orphaned_caches"
                    info["reason"] = "Intermediate or experimental cache not linked to published model"
                    orphaned_caches.append(info)

    # 3. Audit storage/artifacts/
    if ARTIFACTS_DIR.exists():
        for item in ARTIFACTS_DIR.rglob("*"):
            if item.is_file():
                size = item.stat().st_size
                norm_p = _normalize_path_str(item)
                rel = item.relative_to(ARTIFACTS_DIR)

                is_protected = norm_p in protected_artifact_paths or _normalize_path_str(item.parent) in protected_artifact_paths

                info = {
                    "path": item.as_posix(),
                    "relative_path": rel.as_posix(),
                    "size_bytes": size,
                    "size_mb": round(size / (1024 * 1024), 3),
                    "file_type": "model_artifact",
                }

                if is_protected:
                    info["category"] = "protected_production_assets"
                    info["reason"] = "Active or staged production model artifact"
                    protected_assets.append(info)
                else:
                    info["category"] = "unpublished_models"
                    info["reason"] = "Archived, orphaned, or unpublished model file"
                    unpublished_models.append(info)

    def _summarize(items: List[Dict[str, Any]]) -> Dict[str, Any]:
        total_b = sum(i["size_bytes"] for i in items)
        return {
            "count": len(items),
            "size_bytes": total_b,
            "size_mb": round(total_b / (1024 * 1024), 2),
            "files": items,
        }

    sum_orphaned = _summarize(orphaned_caches)
    sum_unpublished = _summarize(unpublished_models)
    sum_protected = _summarize(protected_assets)

    reclaimable_bytes = sum_orphaned["size_bytes"] + sum_unpublished["size_bytes"]

    return {
        "orphaned_caches": sum_orphaned,
        "unpublished_models": sum_unpublished,
        "protected_production_assets": sum_protected,
        "total_reclaimable_bytes": reclaimable_bytes,
        "total_reclaimable_mb": round(reclaimable_bytes / (1024 * 1024), 2),
    }


def purge_storage_janitor(
    purge_orphaned_caches: bool = True,
    purge_unpublished_models: bool = True,
) -> Dict[str, Any]:
    """Safely purge reclaimable files without touching protected production assets.

    Args:
        purge_orphaned_caches: If True, delete unreferenced cache Parquet files.
        purge_unpublished_models: If True, delete archived or discarded model artifacts.

    Returns:
        Summary dictionary with counts, bytes freed, and post-purge storage state.
    """
    scan_res = scan_storage_janitor()

    purged_count = 0
    purged_bytes = 0

    # 1. Purge Orphaned Caches
    if purge_orphaned_caches:
        for file_info in scan_res["orphaned_caches"]["files"]:
            f_path = Path(file_info["path"])
            try:
                if f_path.exists() and f_path.is_file():
                    b_size = f_path.stat().st_size
                    f_path.unlink()
                    purged_count += 1
                    purged_bytes += b_size
            except Exception:
                pass

    # 2. Purge Unpublished Models
    if purge_unpublished_models:
        for file_info in scan_res["unpublished_models"]["files"]:
            f_path = Path(file_info["path"])
            try:
                if f_path.exists() and f_path.is_file():
                    b_size = f_path.stat().st_size
                    f_path.unlink()
                    purged_count += 1
                    purged_bytes += b_size
            except Exception:
                pass

    # 3. Clean up empty subdirectories in storage/cache and storage/artifacts
    for root_dir in [CACHE_DIR, ARTIFACTS_DIR]:
        if root_dir.exists():
            for folder in sorted(root_dir.glob("*/*"), reverse=True):
                if folder.is_dir() and not any(folder.iterdir()):
                    try:
                        folder.rmdir()
                    except Exception:
                        pass
            for proj_folder in sorted(root_dir.glob("*"), reverse=True):
                if proj_folder.is_dir() and not any(proj_folder.iterdir()):
                    try:
                        proj_folder.rmdir()
                    except Exception:
                        pass

    # 4. Re-scan storage to reflect updated state
    new_scan = scan_storage_janitor()

    return {
        "purged_files_count": purged_count,
        "purged_bytes": purged_bytes,
        "purged_mb": round(purged_bytes / (1024 * 1024), 2),
        "post_purge_scan": new_scan,
    }

