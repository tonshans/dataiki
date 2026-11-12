"""Dataiki Standalone Exporter Engine.

Generates self-contained, container-ready deployment packages with:
- Zero Vendor Lock-in: Standalone FastAPI REST API and Batch Scoring scripts.
- Strict Pinned Dependencies: Operator '==' generated via importlib.metadata.version.
- Jinja2 Template rendering for Dockerfile, requirements.txt, standalone_api, standalone_batch, README.md.
- Immutable production bundle (.joblib) packaged directly inside .zip archive.
"""

from __future__ import annotations

import csv
import datetime
import importlib.metadata
import io
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

import jinja2
import joblib
import polars as pl

from backend.config import BASE_DIR, CACHE_DIR, EXPORTS_DIR
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

# Mirror RecipeStep.normalize_fields action aliases
_ACTION_MAP: Dict[str, str] = {
    "change_dtype": "cast_dtype",
    "formula_column": "add_column_formula",
    "split_extract_text": "split_text",
    "auto_generate_features": "auto_features",
    "augment_rows": "row_augment_smote",
    "smote": "row_augment_smote",
    "jitter": "row_augment_jitter",
}

_SQL_KEYWORDS: Set[str] = {
    "SELECT", "FROM", "WHERE", "CASE", "WHEN", "THEN", "ELSE", "END",
    "AND", "OR", "NOT", "IS", "NULL", "AS", "CAST", "TRY_CAST", "COALESCE",
    "IF", "NULLIF", "ROUND", "FLOOR", "CEIL", "ABS", "LOG", "LN", "LOG10",
    "EXP", "SQRT", "POWER", "POW", "MOD", "LEAST", "GREATEST", "LENGTH",
    "LEN", "LOWER", "UPPER", "TRIM", "LTRIM", "RTRIM", "CONCAT", "SUBSTR",
    "SUBSTRING", "REPLACE", "SPLIT_PART", "REGEXP_EXTRACT", "REGEXP_REPLACE",
    "DATE", "TIME", "TIMESTAMP", "INTERVAL", "EXTRACT", "YEAR", "MONTH",
    "DAY", "INT", "INTEGER", "BIGINT", "SMALLINT", "DOUBLE", "FLOAT",
    "DECIMAL", "NUMERIC", "VARCHAR", "TEXT", "CHAR", "STRING", "BOOLEAN",
    "BOOL", "TRUE", "FALSE", "IN", "LIKE", "ILIKE", "BETWEEN", "OVER",
    "PARTITION", "BY", "ORDER", "ASC", "DESC", "DISTINCT", "COUNT", "SUM",
    "AVG", "MIN", "MAX",
}

_NUMERIC_HINTS: Tuple[str, ...] = ("Int", "UInt", "Float", "Decimal")


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


def _parse_json_safe(raw: Any, default: Any) -> Any:
    """Safely parse a JSON string or pass through already-decoded values."""
    if raw is None or raw == "":
        return default
    if isinstance(raw, (dict, list)):
        return raw
    try:
        parsed = json.loads(raw)
        return parsed if parsed is not None else default
    except Exception:
        return default


def _normalize_op_type(step: Dict[str, Any]) -> str:
    """Normalize recipe step operation name consistently with RecipeStep schema."""
    raw_op = step.get("op_type") or step.get("action") or step.get("step_type") or ""
    op_str = str(raw_op).strip()
    return _ACTION_MAP.get(op_str, op_str)


def _is_train_only_step(step: Dict[str, Any], op: str) -> bool:
    """Return True if a recipe step is skipped during inference replay."""
    if op in ("row_augment_smote", "row_augment_jitter"):
        return True
    params = step.get("params") or {}
    scope = params.get("scope") or params.get("apply_scope")
    if scope == "train_only":
        return True
    if scope == "output_and_preview":
        return False
    return bool(step.get("is_train_only", step.get("train_only", False)))


def _extract_sql_identifiers(formula: str, known_cols: Set[str]) -> List[str]:
    """Extract plausible column identifiers referenced inside a DuckDB SQL formula."""
    # Remove single-quoted string literals so string constants aren't treated as columns
    cleaned = re.sub(r"'(?:''|[^'])*'", " ", formula)
    candidates: List[str] = []
    seen: Set[str] = set()

    # Quoted identifiers first ("Col Name")
    for m in re.finditer(r'"([^"]+)"', cleaned):
        ident = m.group(1).strip()
        if ident and ident not in seen:
            candidates.append(ident)
            seen.add(ident)

    # Remove quoted segments before scanning bare identifiers
    bare_text = re.sub(r'"[^"]*"', " ", cleaned)
    known_lower = {c.lower(): c for c in known_cols}

    for m in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*)\b", bare_text):
        token = m.group(1)
        if token.upper() in _SQL_KEYWORDS:
            continue
        # Skip function call names like my_func(...)
        after_pos = m.end()
        if after_pos < len(bare_text) and bare_text[after_pos:].lstrip().startswith("("):
            continue
        resolved = known_lower.get(token.lower(), token)
        if resolved not in seen:
            candidates.append(resolved)
            seen.add(resolved)

    return candidates


def _ensure_ordered_col(cols: List[str], name: Optional[str]) -> None:
    """Append a column name to an ordered list if valid and not yet present."""
    if name and isinstance(name, str):
        c = name.strip()
        if c and c not in cols:
            cols.append(c)


def _replace_ordered_col(cols: List[str], old_name: str, new_name: str) -> None:
    """Replace new_name with old_name in-place (preserving order), or append if absent."""
    if old_name == new_name:
        return
    if new_name in cols:
        idx = cols.index(new_name)
        if old_name in cols:
            cols.pop(idx)
        else:
            cols[idx] = old_name


def _add_note(notes_map: Dict[str, List[str]], col: Optional[str], note: str) -> None:
    """Record a unique human-readable note for a column."""
    if not col:
        return
    bucket = notes_map.setdefault(col, [])
    if note not in bucket:
        bucket.append(note)


def _load_upstream_source_cache(
    project_key: str,
    lineage_nodes: List[Dict[str, Any]],
) -> Tuple[Dict[str, str], Optional[pl.DataFrame]]:
    """Load schema and sample rows from cached upstream node before recipes/transforms."""
    upstream_candidates: List[str] = []
    for node in lineage_nodes:
        ntype = node.get("node_type")
        if ntype in ("data_recipe", "py_transform"):
            break
        if ntype in ("ingestion", "join") and node.get("node_id"):
            upstream_candidates.append(str(node["node_id"]))

    # Prefer the closest upstream node (e.g. join output over individual ingestion sources)
    for nid in reversed(upstream_candidates):
        cache_path = CACHE_DIR / project_key / f"{nid}.parquet"
        if cache_path.exists():
            try:
                df = pl.read_parquet(cache_path).head(5)
                schema = {c: str(df[c].dtype) for c in df.columns}
                return schema, df
            except Exception:
                continue
    return {}, None


def _default_example_for_dtype(dtype_str: str, row_idx: int = 0) -> Any:
    """Return a clean, type-matching example value when no real sample is available."""
    dt = str(dtype_str or "")
    if any(dt.startswith(h) or h.lower() in dt.lower() for h in ("Int", "UInt", "int")):
        return 10 + row_idx * 5
    if any(dt.startswith(h) or h.lower() in dt.lower() for h in ("Float", "Decimal", "float", "double")):
        return round(12.5 + row_idx * 7.25, 2)
    if "bool" in dt.lower():
        return row_idx % 2 == 0
    if "datetime" in dt.lower() or "timestamp" in dt.lower():
        return f"2026-01-{15 + row_idx:02d} 08:30:00"
    if "date" in dt.lower():
        return f"2026-01-{15 + row_idx:02d}"
    return f"sample_{row_idx + 1}"


def _sanitize_scalar(val: Any) -> Any:
    """Convert Polars/numpy/datetime scalars into JSON-safe Python primitives."""
    if val is None:
        return None
    if hasattr(val, "item") and not isinstance(val, (bytes, str)):
        try:
            val = val.item()
        except Exception:
            pass
    if isinstance(val, (datetime.datetime, datetime.date, datetime.time)):
        return val.isoformat()
    if isinstance(val, (bool, int, float, str)):
        return val
    return str(val)


def _pick_sample_values(
    col_name: str,
    dtype_str: str,
    upstream_sample_df: Optional[pl.DataFrame],
    training_sample_df: Optional[pl.DataFrame],
    alias_name: Optional[str] = None,
    hint_value: Any = None,
) -> List[Any]:
    """Extract up to 2 realistic non-null values for a column, with typed fallback."""
    picked: List[Any] = []
    search_sources: List[Tuple[Optional[pl.DataFrame], str]] = [
        (upstream_sample_df, col_name),
        (training_sample_df, col_name),
    ]
    if alias_name and alias_name != col_name:
        search_sources.append((training_sample_df, alias_name))

    for df, lookup_col in search_sources:
        if df is None or lookup_col not in df.columns:
            continue
        non_nulls = df[lookup_col].drop_nulls()
        for raw_val in non_nulls.head(2).to_list():
            clean_val = _sanitize_scalar(raw_val)
            if clean_val is not None:
                picked.append(clean_val)
        if picked:
            break

    if not picked and hint_value is not None:
        clean_hint = _sanitize_scalar(hint_value)
        if clean_hint is not None:
            return [clean_hint, clean_hint]

    if not picked:
        return [_default_example_for_dtype(dtype_str, 0), _default_example_for_dtype(dtype_str, 1)]
    if len(picked) == 1:
        # Provide a second distinct fallback if sample only had 1 row
        second = picked[0]
        if isinstance(second, bool):
            second = not second
        elif isinstance(second, int):
            second = second + 1
        elif isinstance(second, float):
            second = round(second + 1.5, 2)
        picked.append(second)
    return picked[:2]


def _infer_dtype_from_literal(val: Any) -> Optional[str]:
    """Infer a Polars-like dtype label from a literal filter value."""
    if isinstance(val, bool):
        return "Boolean"
    if isinstance(val, int):
        return "Int64"
    if isinstance(val, float):
        return "Float64"
    if isinstance(val, str) and val.strip():
        return "String"
    return None


def _extract_raw_input_spec(
    project_key: str,
    feature_columns: List[str],
    target_column: str,
    input_schema: Dict[str, str],
    frozen_lineage: Dict[str, Any],
    training_sample_df: Optional[pl.DataFrame],
) -> Dict[str, Any]:
    """Infer raw input columns, types, validation rules, and examples via lineage trace."""
    lineage_nodes: List[Dict[str, Any]] = frozen_lineage.get("lineage_nodes") or []

    # Collect active replay steps and py_transform nodes in execution order
    active_steps: List[Dict[str, Any]] = []
    py_transform_nodes: List[str] = []

    for node in lineage_nodes:
        ntype = node.get("node_type")
        params = node.get("params") or {}
        if ntype == "data_recipe":
            steps = params.get("recipe_steps") or node.get("recipe_steps") or []
            for st in steps:
                if not isinstance(st, dict):
                    continue
                op = _normalize_op_type(st)
                if not _is_train_only_step(st, op):
                    active_steps.append(st)
        elif ntype == "py_transform":
            code = str(params.get("code") or "").strip()
            if code:
                py_transform_nodes.append(str(node.get("label") or node.get("node_id") or "Python Transform"))

    # Fallback: if lineage_nodes had no recipe steps (legacy bundles), inspect top-level recipe_steps
    if not active_steps and frozen_lineage.get("recipe_steps"):
        for st in frozen_lineage.get("recipe_steps", []):
            if isinstance(st, dict):
                op = _normalize_op_type(st)
                if not _is_train_only_step(st, op):
                    active_steps.append(st)

    upstream_schema, upstream_sample_df = _load_upstream_source_cache(project_key, lineage_nodes)
    known_cols: Set[str] = set(upstream_schema.keys()) | set(input_schema.keys()) | set(feature_columns)

    # Start from final feature columns and walk recipe steps backwards
    required_cols: List[str] = list(feature_columns)
    col_notes: Dict[str, List[str]] = {}
    dtype_overrides: Dict[str, str] = {}
    rename_aliases: Dict[str, str] = {}   # raw_col -> downstream post-rename col
    filter_hints: Dict[str, Any] = {}     # col -> literal value passing filter_row

    for st in reversed(active_steps):
        op = _normalize_op_type(st)
        params = st.get("params") or {}

        if op == "rename_column":
            mapping = dict(params.get("mapping") or {})
            if not mapping and "old_name" in params and "new_name" in params:
                mapping = {params["old_name"]: params["new_name"]}
            for old_name, new_name in mapping.items():
                old_s, new_s = str(old_name), str(new_name)
                if new_s in required_cols:
                    _replace_ordered_col(required_cols, old_s, new_s)
                    _add_note(col_notes, old_s, f"Di-rename menjadi `{new_s}` oleh recipe")
                    rename_aliases[old_s] = rename_aliases.get(new_s, new_s)
                if new_s in col_notes and old_s != new_s:
                    for n in col_notes.pop(new_s):
                        _add_note(col_notes, old_s, n)
                if new_s in dtype_overrides and old_s not in dtype_overrides:
                    dtype_overrides[old_s] = dtype_overrides.pop(new_s)
                elif old_s not in dtype_overrides and new_s in input_schema:
                    dtype_overrides[old_s] = input_schema[new_s]

        elif op == "cast_dtype":
            raw_mapping = dict(params.get("mapping") or {})
            col = params.get("column")
            target_dt = params.get("target_dtype")
            if col and target_dt:
                raw_mapping[str(col)] = str(target_dt)
            for c_name, d_str in raw_mapping.items():
                c_str = str(c_name)
                if c_str != target_column:
                    _ensure_ordered_col(required_cols, c_str)
                _add_note(col_notes, c_str, f"Wajib dapat di-cast ke `{d_str}` (fail-fast)")
                dtype_overrides.setdefault(c_str, str(d_str))

        elif op == "filter_row":
            col = params.get("column")
            operator = params.get("operator", "==")
            val = params.get("value")
            if col:
                c_str = str(col)
                if c_str != target_column:
                    _ensure_ordered_col(required_cols, c_str)
                op_norm = str(operator).strip().lower()
                if op_norm in ("is_null", "is_not_null"):
                    _add_note(col_notes, c_str, f"Filter wajib (fail-fast): `{c_str} {operator}`")
                else:
                    _add_note(col_notes, c_str, f"Filter wajib (fail-fast): `{c_str} {operator} {val}`")
                    if op_norm in ("==", "eq", ">=", "gte", "<=", "lte") and val is not None:
                        filter_hints.setdefault(c_str, val)
                        inferred_dt = _infer_dtype_from_literal(val)
                        if inferred_dt:
                            dtype_overrides.setdefault(c_str, inferred_dt)

        elif op == "add_column_formula":
            new_col = str(params.get("new_column") or params.get("target_column") or "").strip()
            formula = str(params.get("formula") or "").strip()
            overwrite = bool(params.get("overwrite", False))
            if new_col and formula:
                needs_formula = new_col in required_cols
                if needs_formula and not overwrite:
                    required_cols.remove(new_col)
                if needs_formula or overwrite:
                    refs = _extract_sql_identifiers(formula, known_cols)
                    for ref in refs:
                        if ref != new_col and ref != target_column:
                            _ensure_ordered_col(required_cols, ref)
                            _add_note(col_notes, ref, f"Dipakai di formula `{new_col} = {formula}`")

        elif op == "split_text":
            col = str(params.get("column") or "").strip()
            delim = params.get("delimiter", ",")
            new_cols = [str(c) for c in (params.get("new_columns") or [])]
            if not new_cols and col:
                new_cols = [f"{col}_part1", f"{col}_part2"]
            used = [nc for nc in new_cols if nc in required_cols]
            if col and used:
                for nc in used:
                    required_cols.remove(nc)
                _ensure_ordered_col(required_cols, col)
                _add_note(col_notes, col, f"Di-split (delimiter `{delim}`) menjadi {', '.join(f'`{u}`' for u in used)}")

        elif op == "regex_extract":
            col = str(params.get("column") or "").strip()
            new_col = str(params.get("new_column") or (f"{col}_extracted" if col else "")).strip()
            if col and new_col in required_cols:
                required_cols.remove(new_col)
                _ensure_ordered_col(required_cols, col)
                _add_note(col_notes, col, f"Diekstrak via regex menjadi `{new_col}`")

        elif op == "binning":
            col = str(params.get("column") or "").strip()
            new_col = str(params.get("new_column") or (f"{col}_binned" if col else "")).strip()
            if col and new_col in required_cols:
                required_cols.remove(new_col)
                _ensure_ordered_col(required_cols, col)
                _add_note(col_notes, col, f"Di-binning menjadi `{new_col}`")

        elif op == "datetime_extract":
            col = str(params.get("column") or "").strip()
            feats = params.get("features") or ["year", "month", "day", "day_of_week", "is_weekend"]
            generated = [f"{col}_{str(f).strip().lower()}" for f in feats] if col else []
            used = [g for g in generated if g in required_cols]
            if col and used:
                for g in used:
                    required_cols.remove(g)
                _ensure_ordered_col(required_cols, col)
                dtype_overrides.setdefault(col, "Datetime / Date string")
                _add_note(col_notes, col, f"Ekstraksi waktu ({', '.join(str(f) for f in feats)})")

        elif op == "auto_features":
            num_cols = [str(c) for c in (params.get("numeric_columns") or [])]
            group_by = params.get("group_by")
            auto_suffixes = ("_sq", "_log")
            auto_infixes = ("_x_", "_div_", "_lag_", "_mean_by_", "_sum_by_", "_count_by_")
            matched_derived = [
                c for c in required_cols
                if c.endswith(auto_suffixes) or any(inf in c for inf in auto_infixes)
            ]
            if matched_derived:
                for mc in matched_derived:
                    required_cols.remove(mc)
                for nc in num_cols:
                    if nc != target_column:
                        _ensure_ordered_col(required_cols, nc)
                        _add_note(col_notes, nc, "Dipakai oleh Auto Features")
                if group_by and str(group_by) != target_column:
                    _ensure_ordered_col(required_cols, str(group_by))
                    _add_note(col_notes, str(group_by), "Kunci grup Auto Features")

        elif op in ("fill_na", "string_clean", "find_replace", "clip_outliers"):
            targets = params.get("columns") or ([params.get("column")] if params.get("column") else [])
            for t in targets:
                t_str = str(t)
                if t_str in required_cols:
                    _add_note(col_notes, t_str, f"Diproses oleh recipe `{op}`")

    # If upstream cache is available and py_transform exists, ensure upstream non-target cols are visible
    if py_transform_nodes and upstream_schema:
        for up_col in upstream_schema:
            if up_col != target_column:
                _ensure_ordered_col(required_cols, up_col)
                _add_note(col_notes, up_col, "Kolom sumber sebelum Python Transform")

    raw_columns: List[Dict[str, Any]] = []
    for col_name in required_cols:
        alias_col = rename_aliases.get(col_name)
        dtype_str = (
            upstream_schema.get(col_name)
            or input_schema.get(col_name)
            or (input_schema.get(alias_col) if alias_col else None)
            or dtype_overrides.get(col_name)
            or "String / Auto"
        )
        samples = _pick_sample_values(
            col_name=col_name,
            dtype_str=dtype_str,
            upstream_sample_df=upstream_sample_df,
            training_sample_df=training_sample_df,
            alias_name=alias_col,
            hint_value=filter_hints.get(col_name),
        )
        notes = "; ".join(col_notes.get(col_name) or ["Input langsung untuk fitur model"])
        ex0 = samples[0]
        example_repr = json.dumps(ex0, ensure_ascii=False)
        raw_columns.append(
            {
                "name": col_name,
                "dtype": dtype_str,
                "samples": samples,
                "example_repr": example_repr,
                "notes": notes,
            }
        )

    return {
        "raw_columns": raw_columns,
        "has_recipes": bool(active_steps or py_transform_nodes),
        "py_transform_nodes": py_transform_nodes,
    }


def _inspect_bundle_capabilities(artifact_path: Path, task_type: str) -> Dict[str, Any]:
    """Inspect joblib bundle for predict_proba capability and decoded class labels."""
    supports_predict_proba = False
    class_labels: List[Any] = []
    is_binary_proba = False

    try:
        bundle = joblib.load(artifact_path)
        mdl = bundle.get("model")
        le = bundle.get("label_encoder")

        supports_predict_proba = hasattr(mdl, "predict_proba")
        if le is not None and hasattr(le, "classes_"):
            class_labels = [_sanitize_scalar(c) for c in le.classes_]
        elif mdl is not None and hasattr(mdl, "classes_"):
            class_labels = [_sanitize_scalar(c) for c in mdl.classes_]

        is_binary_proba = supports_predict_proba and (
            len(class_labels) == 2 or (task_type == "classification" and len(class_labels) == 0)
        )
    except Exception:
        supports_predict_proba = task_type in ("classification", "multiclass")
        is_binary_proba = task_type == "classification"

    return {
        "supports_predict_proba": supports_predict_proba,
        "class_labels": class_labels,
        "is_binary_proba": is_binary_proba,
    }


def _format_csv_text(headers: Sequence[str], rows: Sequence[Sequence[Any]]) -> str:
    """Format tabular rows cleanly as RFC-4180 CSV text."""
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(headers)
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    return buf.getvalue().rstrip("\n")


def _to_python_literal(obj: Any) -> str:
    """Render Python dict/list cleanly with True/False/None instead of JSON booleans."""
    return json.dumps(obj, indent=2, ensure_ascii=False).replace(": true", ": True").replace(": false", ": False").replace(": null", ": None")


def _build_example_payloads(
    raw_columns: List[Dict[str, Any]],
    feature_columns: List[str],
    target_column: str,
    task_type: str,
    bundle_caps: Dict[str, Any],
    training_sample_df: Optional[pl.DataFrame] = None,
) -> Dict[str, Any]:
    """Construct concrete JSON API and CSV batch input/output examples for README.md."""
    record_0 = {c["name"]: c["samples"][0] for c in raw_columns}
    record_1 = {c["name"]: c["samples"][1] for c in raw_columns}

    single_payload = {"records": record_0}
    batch_payload = {"records": [record_0, record_1]}

    # Escape single quotes for safe single-quoted bash curl snippets
    single_curl_json = json.dumps(single_payload, ensure_ascii=False).replace("'", "'\"'\"'")
    batch_curl_json = json.dumps(batch_payload, ensure_ascii=False).replace("'", "'\"'\"'")

    # Prediction example values aligned with task_type & label classes
    class_labels = bundle_caps["class_labels"]
    if class_labels:
        pred_0 = class_labels[min(1, len(class_labels) - 1)]
        pred_1 = class_labels[0]
    elif task_type in ("regression", "timeseries"):
        pred_0, pred_1 = 125.4, 98.2
    else:
        pred_0, pred_1 = 1, 0

    single_predict_out = {"target_column": target_column, "predictions": pred_0}
    batch_predict_out = {"target_column": target_column, "predictions": [pred_0, pred_1]}

    n_classes = len(class_labels) if len(class_labels) >= 2 else (3 if task_type == "multiclass" else 2)
    if n_classes == 2:
        proba_0, proba_1 = [0.18, 0.82], [0.76, 0.24]
    else:
        base = round(1.0 / n_classes, 2)
        proba_0 = [base] * (n_classes - 1) + [round(1.0 - base * (n_classes - 1), 2)]
        proba_1 = list(reversed(proba_0))

    single_proba_out = {"probabilities": proba_0}
    batch_proba_out = {"probabilities": [proba_0, proba_1]}

    # Batch CSV input
    in_headers = [c["name"] for c in raw_columns]
    in_rows = [
        [record_0[h] for h in in_headers],
        [record_1[h] for h in in_headers],
    ]
    batch_input_csv = _format_csv_text(in_headers, in_rows) if in_headers else "(tidak ada kolom)"

    # Batch CSV output: post-recipe feature columns + prediction_<target> + optional probability_<target>
    base_out_cols = list(feature_columns) if feature_columns else list(in_headers)
    out_val_map_0 = {c["name"]: c["samples"][0] for c in raw_columns}
    out_val_map_1 = {c["name"]: c["samples"][1] for c in raw_columns}

    if training_sample_df is not None:
        for feat_col in base_out_cols:
            if feat_col in training_sample_df.columns:
                vals = [_sanitize_scalar(v) for v in training_sample_df[feat_col].drop_nulls().head(2).to_list()]
                if vals:
                    out_val_map_0[feat_col] = vals[0]
                    out_val_map_1[feat_col] = vals[1] if len(vals) > 1 else vals[0]

    out_headers = list(base_out_cols) + [f"prediction_{target_column}"]
    out_row_0 = [out_val_map_0.get(h, "...") for h in base_out_cols] + [pred_0]
    out_row_1 = [out_val_map_1.get(h, "...") for h in base_out_cols] + [pred_1]

    if bundle_caps["is_binary_proba"]:
        out_headers.append(f"probability_{target_column}")
        out_row_0.append(proba_0[1])
        out_row_1.append(proba_1[1])

    batch_output_csv = _format_csv_text(out_headers, [out_row_0, out_row_1])

    return {
        "single_payload_json": single_curl_json,
        "batch_payload_json": batch_curl_json,
        "single_payload_python": _to_python_literal(single_payload),
        "single_predict_output_json": json.dumps(single_predict_out, indent=2, ensure_ascii=False),
        "batch_predict_output_json": json.dumps(batch_predict_out, indent=2, ensure_ascii=False),
        "single_proba_output_json": json.dumps(single_proba_out, indent=2, ensure_ascii=False),
        "batch_proba_output_json": json.dumps(batch_proba_out, indent=2, ensure_ascii=False),
        "batch_input_csv": batch_input_csv,
        "batch_output_csv": batch_output_csv,
    }


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

    feature_columns: List[str] = _parse_json_safe(row["feature_columns_json"], [])
    input_schema: Dict[str, str] = _parse_json_safe(row["input_schema_json"], {})
    frozen_lineage: Dict[str, Any] = _parse_json_safe(row["frozen_lineage_json"], {})

    sample_df: Optional[pl.DataFrame] = None
    sample_path_str = row["training_sample_path"] if "training_sample_path" in row.keys() else ""
    if sample_path_str:
        sample_path = Path(sample_path_str)
        if sample_path.exists():
            try:
                sample_df = pl.read_parquet(sample_path).head(5)
            except Exception:
                sample_df = None

    raw_spec = _extract_raw_input_spec(
        project_key=project_key,
        feature_columns=feature_columns,
        target_column=row["target_column"],
        input_schema=input_schema,
        frozen_lineage=frozen_lineage,
        training_sample_df=sample_df,
    )
    bundle_caps = _inspect_bundle_capabilities(artifact_path, row["task_type"])
    examples = _build_example_payloads(
        raw_columns=raw_spec["raw_columns"],
        feature_columns=feature_columns,
        target_column=row["target_column"],
        task_type=row["task_type"],
        bundle_caps=bundle_caps,
        training_sample_df=sample_df,
    )

    model_name = (row["model_name"] if "model_name" in row.keys() else "") or project_key
    docker_tag = re.sub(r"[^a-z0-9_.-]+", "-", f"{project_key.lower()}-v{version}").strip("-")

    template_vars: Dict[str, Any] = {
        "project_key": project_key,
        "model_name": model_name,
        "version": version,
        "algorithm": row["algorithm"],
        "task_type": row["task_type"],
        "target_column": row["target_column"],
        "dependencies": pinned_deps,
        "docker_tag": docker_tag,
        "feature_columns": feature_columns,
        "feature_columns_json": json.dumps(feature_columns, ensure_ascii=False),
        "feature_columns_inline": ", ".join(f"`{c}`" for c in feature_columns),
        "raw_columns": raw_spec["raw_columns"],
        "has_recipes": raw_spec["has_recipes"],
        "py_transform_nodes": raw_spec["py_transform_nodes"],
        "supports_predict_proba": bundle_caps["supports_predict_proba"],
        "is_binary_proba": bundle_caps["is_binary_proba"],
        "class_labels": bundle_caps["class_labels"],
        "class_labels_str": json.dumps(bundle_caps["class_labels"], ensure_ascii=False),
        **examples,
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
    readme_tmpl = jinja_env.get_template("README.md.j2")

    rendered_req = req_tmpl.render(**template_vars)
    rendered_docker = docker_tmpl.render(**template_vars)
    rendered_api = api_tmpl.render(**template_vars)
    rendered_batch = batch_tmpl.render(**template_vars)
    rendered_readme = readme_tmpl.render(**template_vars)

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
        (temp_dir / "README.md").write_text(rendered_readme, encoding="utf-8")

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
