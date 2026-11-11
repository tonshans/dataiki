"""Dataiki Exploratory Data Analysis (EDA) Profiler.

Calculates tabular header fill-rate summaries, sample rows, and deep statistical
metrics (central tendency, dispersion, outliers, histograms, correlations).
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Union

import polars as pl

from backend.schemas import (
    ColumnAnalysisResponse,
    ColumnHeaderSummary,
    TabularPreviewResponse,
)


def get_tabular_headers_and_sample(
    df: pl.DataFrame, limit: Optional[int] = 100
) -> TabularPreviewResponse:
    """Generate header summaries with fill-rates, null counts, and row preview sample.

    Args:
        df: Input Polars DataFrame.
        limit: Maximum number of rows to return for preview.

    Returns:
        TabularPreviewResponse containing total row count, headers, and sampled rows.
    """
    total_rows = df.height
    headers: List[ColumnHeaderSummary] = []

    for col in df.columns:
        s = df[col]
        null_count = int(s.null_count())
        non_null_count = total_rows - null_count
        fill_rate = (
            round((non_null_count / total_rows) * 100.0, 2)
            if total_rows > 0
            else 0.0
        )
        unique_count = int(s.n_unique())

        headers.append(
            ColumnHeaderSummary(
                column_name=col,
                dtype=str(s.dtype),
                fill_rate_pct=fill_rate,
                null_count=null_count,
                unique_count=unique_count,
            )
        )

    # Convert head slice into standard list of dictionaries
    if limit is not None and limit > 0:
        sample_df = df.head(limit)
    else:
        sample_df = df
    rows: List[Dict[str, Any]] = sample_df.to_dicts()

    return TabularPreviewResponse(
        total_rows=total_rows,
        headers=headers,
        rows=rows,
        modified_columns=[],
    )


def analyze_column_deep(
    df: pl.DataFrame,
    column_name: str,
    target_column: Optional[str] = None,
) -> ColumnAnalysisResponse:
    """Compute deep statistical profile for a single column.

    Includes central tendency, dispersion & quartiles, data health (zeros, negatives),
    outlier detection (IQR & Z-score), distribution (histogram or top-frequency), and
    Pearson correlation against all numeric columns.

    Args:
        df: Input Polars DataFrame.
        column_name: Target column to analyze.
        target_column: Optional target column for correlation prioritization.

    Returns:
        ColumnAnalysisResponse object populated with all statistics.
    """
    if column_name not in df.columns:
        raise KeyError(f"Column '{column_name}' not found in DataFrame.")

    s = df[column_name]
    total_rows = df.height
    null_count = int(s.null_count())
    valid_count = total_rows - null_count
    dtype_str = str(s.dtype)
    is_numeric = s.dtype.is_numeric()

    fill_rate_pct = (
        round((valid_count / total_rows) * 100.0, 2) if total_rows > 0 else 0.0
    )

    # Zero ratio and negative count
    unique_count = int(s.drop_nulls().n_unique())
    zero_count = 0
    skewness_val: Optional[float] = None
    kurtosis_val: Optional[float] = None
    if is_numeric and valid_count > 0:
        zero_count = int((s == 0).sum())
        zero_ratio_pct = round((zero_count / total_rows) * 100.0, 2) if total_rows > 0 else 0.0
        negative_count = int((s < 0).sum())
    else:
        zero_ratio_pct = 0.0
        negative_count = 0

    # Central Tendency & Dispersion
    central_tendency: Dict[str, Optional[Union[float, str]]] = {
        "mean": None,
        "median": None,
        "mode": None,
    }
    dispersion: Dict[str, Optional[float]] = {
        "std": None,
        "variance": None,
        "min": None,
        "max": None,
        "iqr": None,
        "q25": None,
        "q50": None,
        "q75": None,
    }
    outliers: Dict[str, Union[float, int]] = {
        "iqr_count": 0,
        "iqr_pct": 0.0,
        "zscore_count": 0,
        "zscore_pct": 0.0,
    }
    distribution: List[Dict[str, Any]] = []

    s_clean = s.drop_nulls()

    if is_numeric and valid_count > 0:
        mean_val = float(s_clean.mean()) if s_clean.mean() is not None else None
        median_val = float(s_clean.median()) if s_clean.median() is not None else None

        # Mode calculation
        mode_series = s_clean.mode()
        mode_val: Optional[Union[float, str]] = None
        if len(mode_series) > 0 and mode_series[0] is not None:
            mode_val = float(mode_series[0])

        central_tendency["mean"] = round(mean_val, 4) if mean_val is not None else None
        central_tendency["median"] = round(median_val, 4) if median_val is not None else None
        central_tendency["mode"] = round(mode_val, 4) if mode_val is not None else None

        # Dispersion
        std_val = float(s_clean.std()) if s_clean.std() is not None else None
        var_val = float(s_clean.var()) if s_clean.var() is not None else None
        min_val = float(s_clean.min()) if s_clean.min() is not None else None
        max_val = float(s_clean.max()) if s_clean.max() is not None else None

        q25 = float(s_clean.quantile(0.25, interpolation="linear")) if valid_count > 0 else None
        q50 = float(s_clean.quantile(0.50, interpolation="linear")) if valid_count > 0 else None
        q75 = float(s_clean.quantile(0.75, interpolation="linear")) if valid_count > 0 else None
        iqr_val = (q75 - q25) if (q75 is not None and q25 is not None) else None

        dispersion["std"] = round(std_val, 4) if std_val is not None else None
        dispersion["variance"] = round(var_val, 4) if var_val is not None else None
        dispersion["min"] = round(min_val, 4) if min_val is not None else None
        dispersion["max"] = round(max_val, 4) if max_val is not None else None
        dispersion["iqr"] = round(iqr_val, 4) if iqr_val is not None else None
        dispersion["q25"] = round(q25, 4) if q25 is not None else None
        dispersion["q50"] = round(q50, 4) if q50 is not None else None
        dispersion["q75"] = round(q75, 4) if q75 is not None else None

        try:
            cand = float(s_clean.skew())
            if math.isfinite(cand):
                skewness_val = round(cand, 4)
        except Exception:
            skewness_val = None

        try:
            cand = float(s_clean.kurtosis())
            if math.isfinite(cand):
                kurtosis_val = round(cand, 4)
        except Exception:
            kurtosis_val = None

        # Outlier Detection
        # 1. 1.5 * IQR method
        if iqr_val is not None and q25 is not None and q75 is not None:
            lower_bound = q25 - (1.5 * iqr_val)
            upper_bound = q75 + (1.5 * iqr_val)
            iqr_outliers = int(((s_clean < lower_bound) | (s_clean > upper_bound)).sum())
            outliers["iqr_count"] = iqr_outliers
            outliers["iqr_pct"] = round((iqr_outliers / valid_count) * 100.0, 2)

        # 2. |Z-Score| > 3 method
        if std_val is not None and std_val > 0 and mean_val is not None:
            z_outliers = int(((s_clean - mean_val).abs() > 3.0 * std_val).sum())
            outliers["zscore_count"] = z_outliers
            outliers["zscore_pct"] = round((z_outliers / valid_count) * 100.0, 2)

        # 10-Bin Histogram Distribution
        if min_val is not None and max_val is not None:
            if min_val == max_val:
                distribution.append({"bucket": f"[{min_val:.2f}]", "count": valid_count})
            else:
                bin_step = (max_val - min_val) / 10.0
                edges = [min_val + (i * bin_step) for i in range(11)]
                for i in range(10):
                    b_left = edges[i]
                    b_right = edges[i + 1]
                    bucket_name = f"{b_left:.2f} - {b_right:.2f}"
                    if i == 9:
                        b_count = int(((s_clean >= b_left) & (s_clean <= b_right)).sum())
                    else:
                        b_count = int(((s_clean >= b_left) & (s_clean < b_right)).sum())
                    distribution.append({"bucket": bucket_name, "count": b_count})

    else:
        # Categorical / Non-numeric
        mode_series = s_clean.mode()
        if len(mode_series) > 0 and mode_series[0] is not None:
            central_tendency["mode"] = str(mode_series[0])

        # Top 10 frequencies
        if valid_count > 0:
            top_vc = s_clean.value_counts(sort=True).head(10)
            for row in top_vc.iter_rows():
                val_repr = str(row[0])
                count_repr = int(row[1])
                pct = round((count_repr / valid_count) * 100.0, 2)
                distribution.append(
                    {"value": val_repr, "count": count_repr, "pct": pct}
                )

    # Pearson Correlations against all other numeric columns
    correlations: Dict[str, float] = {}
    if is_numeric and valid_count > 1:
        other_num_cols = [
            c
            for c in df.columns
            if c != column_name and df[c].dtype.is_numeric()
        ]
        for other_col in other_num_cols:
            try:
                corr_res = df.select(pl.corr(column_name, other_col)).item()
                if corr_res is not None and not math.isnan(corr_res):
                    correlations[other_col] = round(float(corr_res), 4)
                else:
                    correlations[other_col] = 0.0
            except Exception:
                correlations[other_col] = 0.0

    return ColumnAnalysisResponse(
        column_name=column_name,
        dtype=dtype_str,
        row_count=total_rows,
        fill_rate_pct=fill_rate_pct,
        null_count=null_count,
        zero_ratio_pct=zero_ratio_pct,
        negative_count=negative_count,
        unique_count=unique_count,
        zero_count=zero_count,
        skewness=skewness_val,
        kurtosis=kurtosis_val,
        central_tendency=central_tendency,
        dispersion=dispersion,
        outliers=outliers,
        distribution=distribution,
        correlations=correlations,
    )

