"""Dataiki Stackable Data Recipe Engine.

Executes sequential wrangling cards on Polars DataFrames with support for:
- Standard transformations (drop, rename, cast, fill_na, filter, formula, split, regex, clean, replace, binning, clip).
- Auto-Feature engineering (datetime decomposition, polynomial/ratio interactions, lags, group aggregations).
- Train-Only augmentations (SMOTE k-NN interpolation for classification, Gaussian jitter for regression).
- Fail-Fast validation mode for Live REST API inference (HTTP 422 triggers).
"""

from __future__ import annotations

import math
import os
import tempfile
from typing import Any, Dict, List, Optional, Tuple, Union

import duckdb
import numpy as np
import polars as pl

from backend.schemas import RecipeStep


class RecipeValidationError(Exception):
    """Exception raised when data fails a recipe rule in fail_fast_mode (Live API 422)."""

    def __init__(
        self,
        step_label: str,
        record_index: Optional[int] = None,
        message: Optional[str] = None,
    ):
        self.step_label = step_label
        self.record_index = record_index
        detail = message or f"Record failed validation at recipe step '{step_label}'"
        if record_index is not None:
            detail += f" (record index: {record_index})"
        self.message = detail
        super().__init__(self.message)


def _resolve_polars_dtype(dtype_name: str) -> pl.DataType:
    """Map string dtype name to Polars DataType."""
    mapping = {
        "int": pl.Int64,
        "int64": pl.Int64,
        "int32": pl.Int32,
        "int16": pl.Int16,
        "int8": pl.Int8,
        "uint64": pl.UInt64,
        "uint32": pl.UInt32,
        "float": pl.Float64,
        "float64": pl.Float64,
        "float32": pl.Float32,
        "str": pl.Utf8,
        "string": pl.Utf8,
        "utf8": pl.Utf8,
        "bool": pl.Boolean,
        "boolean": pl.Boolean,
        "date": pl.Date,
        "datetime": pl.Datetime,
    }
    target = mapping.get(dtype_name.strip().lower())
    if target is None:
        raise ValueError(f"Unsupported target dtype: '{dtype_name}'")
    return target


def _apply_smote(
    df: pl.DataFrame,
    target_column: str,
    k_neighbors: int = 5,
) -> pl.DataFrame:
    """Perform k-NN synthetic minority oversampling (SMOTE) on tabular DataFrame."""
    if target_column not in df.columns or df.height < 2:
        return df

    # Find class distributions
    vc = df[target_column].value_counts()
    if vc.height < 2:
        return df

    # Determine majority and minority classes
    sorted_vc = vc.sort(by="count", descending=True)
    majority_count = int(sorted_vc["count"][0])

    numeric_cols = [c for c in df.columns if c != target_column and df[c].dtype.is_numeric()]
    if not numeric_cols:
        return df

    synthetic_dfs: List[pl.DataFrame] = []

    for row_idx in range(1, sorted_vc.height):
        class_val = sorted_vc[target_column][row_idx]
        class_count = int(sorted_vc["count"][row_idx])
        needed = majority_count - class_count
        if needed <= 0:
            continue

        class_df = df.filter(pl.col(target_column) == class_val)
        if class_df.height < 2:
            continue

        # Extract numeric matrix for k-NN
        x_mat = class_df.select(numeric_cols).fill_null(0.0).to_numpy()
        n_samples = len(x_mat)
        eff_k = min(k_neighbors, n_samples - 1)
        if eff_k < 1:
            continue

        # Compute Euclidean distance matrix
        diff = x_mat[:, np.newaxis, :] - x_mat[np.newaxis, :, :]
        dist_mat = np.sqrt(np.sum(diff**2, axis=-1))
        np.fill_diagonal(dist_mat, np.inf)

        # Nearest neighbors indices
        nn_indices = np.argsort(dist_mat, axis=1)[:, :eff_k]

        # Generate synthetic samples
        synth_numeric = np.zeros((needed, len(numeric_cols)), dtype=np.float64)
        donor_rows: List[int] = []

        for s_i in range(needed):
            base_idx = np.random.randint(0, n_samples)
            neighbor_idx = nn_indices[base_idx, np.random.randint(0, eff_k)]
            lam = np.random.uniform(0.0, 1.0)
            synth_numeric[s_i] = x_mat[base_idx] + lam * (x_mat[neighbor_idx] - x_mat[base_idx])
            donor_rows.append(base_idx)

        # Build synthetic DataFrame
        synth_data: Dict[str, Any] = {}
        for c_i, c_name in enumerate(numeric_cols):
            synth_data[c_name] = synth_numeric[:, c_i].tolist()

        synth_data[target_column] = [class_val] * needed

        # Fill remaining non-numeric columns from donor rows
        other_cols = [c for c in df.columns if c not in numeric_cols and c != target_column]
        for oc in other_cols:
            col_series = class_df[oc]
            synth_data[oc] = [col_series[d_idx] for d_idx in donor_rows]

        synth_df = pl.DataFrame(synth_data)
        synthetic_dfs.append(synth_df)

    if synthetic_dfs:
        all_dfs = [df] + synthetic_dfs
        return pl.concat(all_dfs, how="diagonal_relaxed")
    return df


def _apply_jitter(
    df: pl.DataFrame,
    numeric_columns: Optional[List[str]] = None,
    noise_scale: float = 0.05,
    num_synthetic_rows: Optional[int] = None,
) -> pl.DataFrame:
    """Inject controlled Gaussian noise into numeric columns for regression augmentation."""
    if df.height == 0:
        return df

    num_cols = numeric_columns or [c for c in df.columns if df[c].dtype.is_numeric()]
    if not num_cols:
        return df

    needed = num_synthetic_rows if num_synthetic_rows is not None else max(10, int(df.height * 0.2))
    if needed <= 0:
        return df

    # Sample source rows
    sample_indices = np.random.randint(0, df.height, size=needed)
    sampled_df = df[sample_indices]

    synth_dict: Dict[str, Any] = {}
    for col in df.columns:
        if col in num_cols:
            col_std = float(df[col].std()) if df[col].std() is not None else 1.0
            scale = noise_scale * (col_std if col_std > 0 else 1.0)
            noise = np.random.normal(0.0, scale, size=needed)
            vals = (sampled_df[col].cast(pl.Float64) + noise).to_list()
            synth_dict[col] = vals
        else:
            synth_dict[col] = sampled_df[col].to_list()

    synth_df = pl.DataFrame(synth_dict)
    return pl.concat([df, synth_df], how="diagonal_relaxed")


def apply_recipe_steps(
    df: pl.DataFrame,
    steps: List[RecipeStep],
    include_train_only: bool = False,
    fail_fast_mode: bool = False,
) -> Tuple[pl.DataFrame, List[str]]:
    """Apply an ordered stack of recipe steps to a Polars DataFrame.

    Args:
        df: Input Polars DataFrame.
        steps: List of RecipeStep instructions.
        include_train_only: If True, execute train-only augmentations (SMOTE/Jitter).
        fail_fast_mode: If True, abort immediately with RecipeValidationError on rejected rows/casts.

    Returns:
        Tuple of (transformed_df, list_of_modified_or_created_column_names).
    """
    current_df = df
    modified_columns: List[str] = []

    for step in steps:
        # Train-only isolation check
        if step.is_train_only and not include_train_only:
            continue

        op = step.op_type
        params = step.params or {}

        # 1. drop_column
        if op == "drop_column":
            targets = params.get("columns", [])
            if not targets and "column" in params:
                targets = [params["column"]]
            to_drop = [c for c in targets if c in current_df.columns]
            if to_drop:
                current_df = current_df.drop(to_drop)
                modified_columns.extend(to_drop)

        # 2. rename_column
        elif op == "rename_column":
            mapping = params.get("mapping", {})
            if not mapping and "old_name" in params and "new_name" in params:
                mapping = {params["old_name"]: params["new_name"]}
            valid_mapping = {k: v for k, v in mapping.items() if k in current_df.columns}
            if valid_mapping:
                current_df = current_df.rename(valid_mapping)
                modified_columns.extend(list(valid_mapping.values()))

        # 3. cast_dtype
        elif op == "cast_dtype":
            col = params.get("column")
            target_dtype_str = params.get("target_dtype")
            mapping = params.get("mapping", {})
            if col and target_dtype_str:
                mapping[col] = target_dtype_str

            for c_name, d_str in mapping.items():
                if c_name not in current_df.columns:
                    if fail_fast_mode:
                        raise RecipeValidationError(step.label, message=f"Column '{c_name}' not found for casting")
                    continue

                target_pl_dtype = _resolve_polars_dtype(d_str)

                if fail_fast_mode:
                    orig_s = current_df[c_name]
                    try:
                        casted_s = orig_s.cast(target_pl_dtype, strict=False)
                    except Exception as exc:
                        raise RecipeValidationError(
                            step.label,
                            record_index=0,
                            message=f"Failed to cast '{c_name}' to '{d_str}': {exc}",
                        ) from exc

                    # Check for unparseable entries that became null from non-null values
                    failed_mask = orig_s.is_not_null() & casted_s.is_null()
                    if failed_mask.any():
                        first_bad_idx = int(
                            current_df.with_row_index("__row_idx")
                            .filter(failed_mask)["__row_idx"][0]
                        )
                        bad_val = orig_s[first_bad_idx]
                        raise RecipeValidationError(
                            step.label,
                            record_index=first_bad_idx,
                            message=f"Invalid value '{bad_val}' in column '{c_name}' cannot be cast to '{d_str}'",
                        )
                    current_df = current_df.with_columns(casted_s.alias(c_name))
                else:
                    current_df = current_df.with_columns(
                        pl.col(c_name).cast(target_pl_dtype, strict=False)
                    )
                modified_columns.append(c_name)

        # 4. fill_na
        elif op == "fill_na":
            col = params.get("column")
            strategy = params.get("strategy", "constant")
            fill_val = params.get("value")
            cols_to_fill = params.get("columns", [col] if col else [])

            for c_name in cols_to_fill:
                if c_name not in current_df.columns:
                    continue
                s = current_df[c_name]
                if strategy == "constant":
                    current_df = current_df.with_columns(pl.col(c_name).fill_null(fill_val))
                elif strategy == "mean":
                    m_val = float(s.drop_nulls().mean()) if s.drop_nulls().len() > 0 else 0.0
                    current_df = current_df.with_columns(pl.col(c_name).fill_null(m_val))
                elif strategy == "median":
                    med_val = float(s.drop_nulls().median()) if s.drop_nulls().len() > 0 else 0.0
                    current_df = current_df.with_columns(pl.col(c_name).fill_null(med_val))
                elif strategy == "mode":
                    modes = s.drop_nulls().mode()
                    mode_val = modes[0] if len(modes) > 0 else fill_val
                    current_df = current_df.with_columns(pl.col(c_name).fill_null(mode_val))
                elif strategy == "forward":
                    current_df = current_df.with_columns(pl.col(c_name).forward_fill())
                elif strategy == "backward":
                    current_df = current_df.with_columns(pl.col(c_name).backward_fill())
                modified_columns.append(c_name)

        # 5. filter_row
        elif op == "filter_row":
            col = params.get("column")
            operator = params.get("operator", "==")
            val = params.get("value")

            if col not in current_df.columns:
                if fail_fast_mode:
                    raise RecipeValidationError(step.label, message=f"Column '{col}' not found for filter")
                continue

            # Construct filter condition
            op_norm = operator.strip().lower()
            if op_norm in ("==", "eq"):
                cond = pl.col(col) == val
            elif op_norm in ("!=", "ne"):
                cond = pl.col(col) != val
            elif op_norm in (">", "gt"):
                cond = pl.col(col) > val
            elif op_norm in ("<", "lt"):
                cond = pl.col(col) < val
            elif op_norm in (">=", "gte"):
                cond = pl.col(col) >= val
            elif op_norm in ("<=", "lte"):
                cond = pl.col(col) <= val
            elif op_norm == "in":
                val_list = val if isinstance(val, list) else [val]
                cond = pl.col(col).is_in(val_list)
            elif op_norm in ("not_in", "not in"):
                val_list = val if isinstance(val, list) else [val]
                cond = ~pl.col(col).is_in(val_list)
            elif op_norm == "contains":
                cond = pl.col(col).cast(pl.Utf8).str.contains(str(val), literal=True)
            elif op_norm == "regex":
                cond = pl.col(col).cast(pl.Utf8).str.contains(str(val))
            elif op_norm == "is_null":
                cond = pl.col(col).is_null()
            elif op_norm == "is_not_null":
                cond = pl.col(col).is_not_null()
            else:
                raise ValueError(f"Unsupported filter operator: {operator}")

            if fail_fast_mode:
                # Check if any row violates the filter condition
                fail_mask = ~cond
                if current_df.filter(fail_mask).height > 0:
                    first_bad_idx = int(
                        current_df.with_row_index("__row_idx")
                        .filter(fail_mask)["__row_idx"][0]
                    )
                    raise RecipeValidationError(
                        step.label,
                        record_index=first_bad_idx,
                        message=f"Row {first_bad_idx} rejected by filter condition: {col} {operator} {val}",
                    )
            current_df = current_df.filter(cond)

        # 6. add_column_formula
        elif op == "add_column_formula":
            new_col = params.get("new_column") or params.get("target_column")
            formula = params.get("formula")
            if not new_col or not formula:
                continue

            # Execute SQL formula expression via DuckDB + temp Parquet
            # (avoids pyarrow dependency; con.close() guaranteed by try/finally)
            tmp_path = tempfile.mktemp(suffix=".parquet")
            con = duckdb.connect()
            try:
                current_df.write_parquet(tmp_path)
                rel = con.execute(
                    f'SELECT *, ({formula}) AS "{new_col}" FROM read_parquet("{tmp_path}")'
                )
                col_names = [d[0] for d in rel.description]
                rows = rel.fetchall()
                current_df = pl.DataFrame([dict(zip(col_names, r)) for r in rows])
                modified_columns.append(new_col)
            except Exception as exc:
                if fail_fast_mode:
                    raise RecipeValidationError(step.label, message=f"Formula error in '{formula}': {exc}") from exc
                raise ValueError(f"Failed to evaluate formula '{formula}': {exc}") from exc
            finally:
                con.close()
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)

        # 7. split_text
        elif op == "split_text":
            col = params.get("column")
            delimiter = params.get("delimiter", ",")
            new_cols = params.get("new_columns", [])
            if col in current_df.columns:
                split_series = pl.col(col).cast(pl.Utf8).str.split(delimiter)
                if new_cols:
                    for i, target_c in enumerate(new_cols):
                        current_df = current_df.with_columns(
                            split_series.list.get(i).alias(target_c)
                        )
                        modified_columns.append(target_c)
                else:
                    target_c1 = f"{col}_part1"
                    target_c2 = f"{col}_part2"
                    current_df = current_df.with_columns(
                        split_series.list.get(0).alias(target_c1),
                        split_series.list.get(1).alias(target_c2),
                    )
                    modified_columns.extend([target_c1, target_c2])

        # 8. regex_extract
        elif op == "regex_extract":
            col = params.get("column")
            pattern = params.get("pattern", "")
            new_col = params.get("new_column", f"{col}_extracted")
            group_idx = int(params.get("group_index", 1))
            if col in current_df.columns and pattern:
                current_df = current_df.with_columns(
                    pl.col(col).cast(pl.Utf8).str.extract(pattern, group_idx).alias(new_col)
                )
                modified_columns.append(new_col)

        # 9. string_clean
        elif op == "string_clean":
            col = params.get("column")
            operations = params.get("operations") or [params.get("clean_type", "trim")]
            if col in current_df.columns:
                expr = pl.col(col).cast(pl.Utf8)
                for clean_op in operations:
                    c_op = clean_op.strip().lower()
                    if c_op in ("trim", "strip"):
                        expr = expr.str.strip_chars()
                    elif c_op == "lower":
                        expr = expr.str.to_lowercase()
                    elif c_op == "upper":
                        expr = expr.str.to_uppercase()
                current_df = current_df.with_columns(expr.alias(col))
                modified_columns.append(col)

        # 10. find_replace
        elif op == "find_replace":
            col = params.get("column")
            mapping = params.get("mapping")
            if not mapping and "find" in params and "replace" in params:
                mapping = {params["find"]: params["replace"]}
            if col in current_df.columns and mapping:
                current_df = current_df.with_columns(
                    pl.col(col).replace(mapping).alias(col)
                )
                modified_columns.append(col)

        # 11. binning
        elif op == "binning":
            col = params.get("column")
            new_col = params.get("new_column", f"{col}_binned")
            bins = params.get("bins")
            labels = params.get("labels")

            if col in current_df.columns:
                if bins:
                    breaks = sorted([float(b) for b in bins])
                    expr = pl.when(pl.col(col) < breaks[0]).then(
                        pl.lit(labels[0] if labels and len(labels) > 0 else f"<{breaks[0]}")
                    )
                    for b_i in range(len(breaks) - 1):
                        lbl = (
                            labels[b_i + 1]
                            if labels and len(labels) > b_i + 1
                            else f"[{breaks[b_i]}, {breaks[b_i+1]})"
                        )
                        expr = expr.when(
                            (pl.col(col) >= breaks[b_i]) & (pl.col(col) < breaks[b_i + 1])
                        ).then(pl.lit(lbl))
                    last_lbl = (
                        labels[-1]
                        if labels and len(labels) == len(breaks) + 1
                        else f">={breaks[-1]}"
                    )
                    expr = expr.otherwise(pl.lit(last_lbl))
                    current_df = current_df.with_columns(expr.alias(new_col))
                    modified_columns.append(new_col)
                else:
                    # Quantile / equal frequency cut fallback
                    num_bins = int(params.get("num_bins", 5))
                    s_clean = current_df[col].drop_nulls()
                    if s_clean.len() > 0:
                        quantiles = [
                            float(s_clean.quantile(i / num_bins)) for i in range(1, num_bins)
                        ]
                        breaks = sorted(list(set(quantiles)))
                        if breaks:
                            expr = pl.when(pl.col(col) <= breaks[0]).then(pl.lit(f"Bin_0"))
                            for b_i in range(len(breaks) - 1):
                                expr = expr.when(
                                    (pl.col(col) > breaks[b_i]) & (pl.col(col) <= breaks[b_i + 1])
                                ).then(pl.lit(f"Bin_{b_i+1}"))
                            expr = expr.otherwise(pl.lit(f"Bin_{len(breaks)}"))
                            current_df = current_df.with_columns(expr.alias(new_col))
                            modified_columns.append(new_col)

        # 12. clip_outliers (Winsorize)
        elif op == "clip_outliers":
            col = params.get("column")
            if col in current_df.columns and current_df[col].dtype.is_numeric():
                s_clean = current_df[col].drop_nulls()
                if s_clean.len() > 0:
                    if "lower_bound" in params and "upper_bound" in params:
                        lower_b = float(params["lower_bound"])
                        upper_b = float(params["upper_bound"])
                    elif "iqr_multiplier" in params:
                        q25 = float(s_clean.quantile(0.25))
                        q75 = float(s_clean.quantile(0.75))
                        iqr = q75 - q25
                        mult = float(params["iqr_multiplier"])
                        lower_b = q25 - (mult * iqr)
                        upper_b = q75 + (mult * iqr)
                    else:
                        l_q = float(params.get("lower_quantile", 0.05))
                        u_q = float(params.get("upper_quantile", 0.95))
                        lower_b = float(s_clean.quantile(l_q))
                        upper_b = float(s_clean.quantile(u_q))

                    current_df = current_df.with_columns(
                        pl.col(col).clip(lower_b, upper_b).alias(col)
                    )
                    modified_columns.append(col)

        # 13. datetime_extract
        elif op == "datetime_extract":
            col = params.get("column")
            features = params.get(
                "features", ["year", "month", "day", "day_of_week", "is_weekend"]
            )
            if col in current_df.columns:
                dt_expr = pl.col(col)
                if not current_df[col].dtype.is_temporal():
                    dt_expr = dt_expr.cast(pl.Utf8).str.to_datetime(strict=False)

                new_exprs = []
                for feat in features:
                    feat_norm = feat.strip().lower()
                    if feat_norm == "year":
                        c_name = f"{col}_year"
                        new_exprs.append(dt_expr.dt.year().alias(c_name))
                        modified_columns.append(c_name)
                    elif feat_norm == "month":
                        c_name = f"{col}_month"
                        new_exprs.append(dt_expr.dt.month().alias(c_name))
                        modified_columns.append(c_name)
                    elif feat_norm == "day":
                        c_name = f"{col}_day"
                        new_exprs.append(dt_expr.dt.day().alias(c_name))
                        modified_columns.append(c_name)
                    elif feat_norm == "day_of_week":
                        c_name = f"{col}_day_of_week"
                        new_exprs.append(dt_expr.dt.weekday().alias(c_name))
                        modified_columns.append(c_name)
                    elif feat_norm == "is_weekend":
                        c_name = f"{col}_is_weekend"
                        new_exprs.append(
                            (dt_expr.dt.weekday() >= 6).cast(pl.Int32).alias(c_name)
                        )
                        modified_columns.append(c_name)

                if new_exprs:
                    current_df = current_df.with_columns(new_exprs)

        # 14. auto_features
        elif op == "auto_features":
            num_cols = params.get("numeric_columns") or [
                c for c in current_df.columns if current_df[c].dtype.is_numeric()
            ]
            operations = params.get("operations", ["interactions", "squared", "log"])

            new_exprs = []
            # Interactions & Polynomials
            if "interactions" in operations and len(num_cols) >= 2:
                for i in range(len(num_cols)):
                    for j in range(i + 1, len(num_cols)):
                        cA, cB = num_cols[i], num_cols[j]
                        mul_name = f"{cA}_x_{cB}"
                        div_name = f"{cA}_div_{cB}"
                        new_exprs.append((pl.col(cA) * pl.col(cB)).alias(mul_name))
                        new_exprs.append(
                            pl.when(pl.col(cB) != 0)
                            .then(pl.col(cA) / pl.col(cB))
                            .otherwise(None)
                            .alias(div_name)
                        )
                        modified_columns.extend([mul_name, div_name])

            if "squared" in operations:
                for cA in num_cols:
                    sq_name = f"{cA}_sq"
                    new_exprs.append((pl.col(cA) ** 2).alias(sq_name))
                    modified_columns.append(sq_name)

            if "log" in operations:
                for cA in num_cols:
                    log_name = f"{cA}_log"
                    new_exprs.append(
                        pl.when(pl.col(cA) > 0)
                        .then(pl.col(cA).log())
                        .otherwise(None)
                        .alias(log_name)
                    )
                    modified_columns.append(log_name)

            # Time-lags
            lags = params.get("lags", [])
            for cA in num_cols:
                for lag_step in lags:
                    lag_name = f"{cA}_lag_{lag_step}"
                    new_exprs.append(pl.col(cA).shift(lag_step).alias(lag_name))
                    modified_columns.append(lag_name)

            if new_exprs:
                current_df = current_df.with_columns(new_exprs)

            # Group aggregations
            group_by_col = params.get("group_by")
            group_aggs = params.get("aggregations", ["mean", "sum", "count"])
            if group_by_col and group_by_col in current_df.columns:
                group_exprs = []
                for cA in num_cols:
                    if cA == group_by_col:
                        continue
                    if "mean" in group_aggs:
                        m_name = f"{cA}_mean_by_{group_by_col}"
                        group_exprs.append(pl.col(cA).mean().over(group_by_col).alias(m_name))
                        modified_columns.append(m_name)
                    if "sum" in group_aggs:
                        s_name = f"{cA}_sum_by_{group_by_col}"
                        group_exprs.append(pl.col(cA).sum().over(group_by_col).alias(s_name))
                        modified_columns.append(s_name)
                    if "count" in group_aggs:
                        c_name = f"{cA}_count_by_{group_by_col}"
                        group_exprs.append(pl.col(cA).count().over(group_by_col).alias(c_name))
                        modified_columns.append(c_name)
                if group_exprs:
                    current_df = current_df.with_columns(group_exprs)

        # 15. row_augment_smote (TRAIN-ONLY)
        elif op == "row_augment_smote":
            if include_train_only:
                target_col = params.get("target_column")
                k_nn = int(params.get("k_neighbors", 5))
                if target_col:
                    current_df = _apply_smote(current_df, target_col, k_neighbors=k_nn)

        # 16. row_augment_jitter (TRAIN-ONLY)
        elif op == "row_augment_jitter":
            if include_train_only:
                num_cols = params.get("numeric_columns")
                noise_scale = float(params.get("noise_scale", 0.05))
                num_synth = params.get("num_synthetic_rows")
                current_df = _apply_jitter(
                    current_df,
                    numeric_columns=num_cols,
                    noise_scale=noise_scale,
                    num_synthetic_rows=int(num_synth) if num_synth is not None else None,
                )

        else:
            raise ValueError(f"Unknown recipe operation: '{op}'")

    # Deduplicate modified columns preserving order
    deduped_modified = list(dict.fromkeys(modified_columns))
    return current_df, deduped_modified

