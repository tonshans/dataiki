"""Dataiki ML Screening Engine (Phase 1 Multi-Algorithm Screening).

Executes parallel algorithm screening on Holdout Test datasets with:
- High cardinality detection & pausing mechanism.
- Automated ColumnTransformer pipeline builder (NumPy/Polars, zero Pandas overhead).
- Stratified holdout sampling and train-only augmentation isolation (SMOTE/Jitter).
- Comprehensive evaluation metric calculation for Regression and Classification.
- Session persistence into the Trophy Cabinet (ml_sessions).
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, List, Optional

import polars as pl

# Model Imports
from sklearn.ensemble import (
    ExtraTreesClassifier,
    ExtraTreesRegressor,
    GradientBoostingClassifier,
    GradientBoostingRegressor,
    RandomForestClassifier,
    RandomForestRegressor,
)
from sklearn.linear_model import (
    ElasticNet,
    Lasso,
    LinearRegression,
    LogisticRegression,
    Ridge,
    SGDClassifier,
    SGDRegressor,
)
from sklearn.neighbors import KNeighborsClassifier, KNeighborsRegressor
from sklearn.tree import DecisionTreeClassifier, DecisionTreeRegressor

import lightgbm as lgb
import xgboost as xgb

from backend.config import CACHE_DIR
from backend.database import get_db
from backend.engine.ml_common import (
    HIGHER_IS_BETTER_METRICS,
    FrequencyEncoder,
    PreparedMLDataset,
    _evaluate_classification_metrics,
    _evaluate_regression_metrics,
    build_column_transformer,
    evaluate_model_predictions,
    prepare_ml_dataset,
)
from backend.engine.ml_jobs import (
    complete_job,
    create_job,
    fail_job,
    set_paused_high_cardinality,
    update_progress,
)
from backend.schemas import LeaderboardEntry, ScreeningRequest

__all__ = [
    "HIGHER_IS_BETTER_METRICS",
    "FrequencyEncoder",
    "PreparedMLDataset",
    "build_column_transformer",
    "evaluate_model_predictions",
    "prepare_ml_dataset",
    "run_screening_job",
    "_evaluate_classification_metrics",
    "_evaluate_regression_metrics",
]


def _get_regression_models(use_gpu: bool = False) -> Dict[str, Any]:
    """Get candidate model dictionary for regression tasks."""
    return {
        "LightGBM": lgb.LGBMRegressor(
            random_state=42,
            verbose=-1,
            n_estimators=100,
            device_type="cuda" if use_gpu else "cpu",
        ),
        "XGBoost": xgb.XGBRegressor(
            random_state=42,
            verbosity=0,
            n_estimators=100,
            tree_method="hist",
            device="cuda" if use_gpu else "cpu",
        ),
        "Random Forest": RandomForestRegressor(n_estimators=100, random_state=42, n_jobs=-1),
        "Extra Trees": ExtraTreesRegressor(n_estimators=100, random_state=42, n_jobs=-1),
        "Gradient Boosting": GradientBoostingRegressor(random_state=42),
        "Ridge": Ridge(),
        "Lasso Path": Lasso(alpha=0.1, random_state=42),
        "ElasticNet": ElasticNet(random_state=42),
        "Decision Tree": DecisionTreeRegressor(random_state=42),
        "KNN": KNeighborsRegressor(),
        "Linear Regression": LinearRegression(),
        "SGD Regressor": SGDRegressor(random_state=42),
    }


def _get_classification_models(use_gpu: bool = False) -> Dict[str, Any]:
    """Get candidate model dictionary for classification tasks."""
    return {
        "LightGBM": lgb.LGBMClassifier(
            random_state=42,
            verbose=-1,
            n_estimators=100,
            device_type="cuda" if use_gpu else "cpu",
        ),
        "XGBoost": xgb.XGBClassifier(
            random_state=42,
            verbosity=0,
            n_estimators=100,
            eval_metric="logloss",
            tree_method="hist",
            device="cuda" if use_gpu else "cpu",
        ),
        "Random Forest": RandomForestClassifier(n_estimators=100, random_state=42, n_jobs=-1),
        "Extra Trees": ExtraTreesClassifier(n_estimators=100, random_state=42, n_jobs=-1),
        "Gradient Boosting": GradientBoostingClassifier(random_state=42),
        "Logistic Regression": LogisticRegression(max_iter=1000, random_state=42),
        "Decision Tree": DecisionTreeClassifier(random_state=42),
        "KNN": KNeighborsClassifier(),
        "SGD Classifier": SGDClassifier(random_state=42, loss="log_loss"),
    }


def run_screening_job(
    request: ScreeningRequest,
    job_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Execute asynchronous or synchronous Phase 1 Multi-Algorithm Screening.

    Args:
        request: ScreeningRequest configuration.
        job_id: Optional existing job ID.

    Returns:
        Dictionary containing job status, session_id, and leaderboard.
    """
    jid = job_id or create_job(request.project_key, "screening")
    update_progress(jid, progress=5, status="running", message="Loading parquet cache")

    try:
        # 1. Load input dataset from Parquet cache
        parquet_file = CACHE_DIR / request.project_key / f"{request.input_node_id}.parquet"
        if not parquet_file.exists():
            raise FileNotFoundError(f"Input Parquet not found: {parquet_file}")

        df = pl.read_parquet(parquet_file)
        if request.target_column not in df.columns:
            raise KeyError(f"Target column '{request.target_column}' missing in dataset.")

        feature_cols = [c for c in request.feature_columns if c in df.columns and c != request.target_column]
        if not feature_cols:
            raise ValueError("No valid feature columns provided for screening.")

        # 2. Check for High Cardinality in Categorical Columns
        if request.preprocessing.categorical_encoder == "onehot":
            threshold = request.preprocessing.high_cardinality_threshold
            triggered_columns: List[Dict[str, Any]] = []

            for col in feature_cols:
                if df[col].dtype in (pl.Utf8, pl.Categorical, pl.Boolean):
                    unique_cnt = int(df[col].n_unique())
                    if unique_cnt > threshold:
                        triggered_columns.append(
                            {
                                "column": col,
                                "unique_count": unique_cnt,
                                "threshold": threshold,
                            }
                        )

            if triggered_columns:
                action = request.high_cardinality_action
                if action is None:
                    set_paused_high_cardinality(jid, triggered_columns, request_data=request.model_dump())
                    return {
                        "status": "paused_high_cardinality",
                        "job_id": jid,
                        "triggered_columns": triggered_columns,
                    }
                elif action in ("drop_column", "drop"):
                    bad_cols = {tc["column"] for tc in triggered_columns}
                    feature_cols = [c for c in feature_cols if c not in bad_cols]
                elif action == "stop":
                    fail_job(jid, "Screening aborted by user due to high cardinality columns.")
                    return {"status": "failed", "job_id": jid, "error": "Stopped by user"}

        update_progress(jid, progress=15, message="Sampling and splitting Holdout dataset")

        prepared = prepare_ml_dataset(
            df=df,
            target_column=request.target_column,
            feature_columns=feature_cols,
            task_type=request.task_type,
            preprocessing=request.preprocessing,
            sample_limit=request.sample_limit,
            test_size=request.test_size,
            project_key=request.project_key,
            input_node_id=request.input_node_id,
        )

        update_progress(jid, progress=30, message="Fitting ColumnTransformer preprocessing")

        feature_cols = prepared.feature_cols
        is_classification = prepared.is_classification
        is_multiclass = prepared.is_multiclass
        X_train_trans = prepared.X_train
        X_test_trans = prepared.X_test
        y_train = prepared.y_train
        y_test = prepared.y_test

        # 7. Model Selection & Parallel Screening
        if is_classification:
            all_models = _get_classification_models(use_gpu=request.use_gpu)
        else:
            all_models = _get_regression_models(use_gpu=request.use_gpu)

        selected = request.selected_algorithms
        if selected:
            models_to_run = {k: v for k, v in all_models.items() if k in selected}
        else:
            models_to_run = all_models

        if not models_to_run:
            models_to_run = all_models

        leaderboard_entries: List[LeaderboardEntry] = []
        total_models = len(models_to_run)

        for idx, (algo_name, model_inst) in enumerate(models_to_run.items()):
            progress_val = 35 + int((idx / total_models) * 55)
            update_progress(jid, progress=progress_val, message=f"Evaluating {algo_name}")

            t0 = time.perf_counter()
            try:
                model_inst.fit(X_train_trans, y_train)
                fit_time = round(time.perf_counter() - t0, 3)

                # Inference latency test (ms per 100 samples)
                sample_slice = X_test_trans[: min(100, len(X_test_trans))]
                lat_t0 = time.perf_counter()
                model_inst.predict(sample_slice)
                lat_ms = round((time.perf_counter() - lat_t0) * 1000.0, 2)

                metrics, cm_dict = evaluate_model_predictions(
                    model_inst, X_test_trans, y_test, is_classification, is_multiclass
                )

                leaderboard_entries.append(
                    LeaderboardEntry(
                        rank=1,
                        algorithm=algo_name,
                        source_node_id=request.input_node_id,
                        source_recipe_label="Main Recipe",
                        metrics=metrics,
                        confusion_matrix=cm_dict,
                        fit_time_sec=fit_time,
                        latency_ms=lat_ms,
                    )
                )

            except Exception:
                leaderboard_entries.append(
                    LeaderboardEntry(
                        rank=999,
                        algorithm=algo_name,
                        source_node_id=request.input_node_id,
                        source_recipe_label="Failed",
                        metrics={request.primary_metric: -999999.0},
                        confusion_matrix=None,
                        fit_time_sec=0.0,
                        latency_ms=0.0,
                    )
                )

        # 8. Sort Leaderboard by Primary Metric
        pm = request.primary_metric.lower().strip()
        desc = pm in HIGHER_IS_BETTER_METRICS

        def get_score(entry: LeaderboardEntry) -> float:
            return entry.metrics.get(pm, entry.metrics.get(request.primary_metric, -1e9 if desc else 1e9))

        successful = [e for e in leaderboard_entries if e.rank != 999]
        failed = [e for e in leaderboard_entries if e.rank == 999]

        successful.sort(key=get_score, reverse=desc)
        for r_i, entry in enumerate(successful):
            entry.rank = r_i + 1
        for f_i, entry in enumerate(failed):
            entry.rank = 1000 + f_i

        leaderboard_entries = successful + failed

        # 9. Save Session to Trophy Cabinet (ml_sessions)
        session_id = f"sess_{uuid.uuid4().hex[:12]}"
        lb_dicts = [e.model_dump() for e in leaderboard_entries]

        with get_db() as conn:
            conn.execute(
                """
                INSERT INTO ml_sessions (
                    session_id, project_key, session_name, source_node_id,
                    task_type, target_column, feature_columns_json,
                    preprocessing_json, sample_limit, test_size,
                    primary_metric, leaderboard_json
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    request.project_key,
                    request.session_name,
                    request.input_node_id,
                    request.task_type,
                    request.target_column,
                    json.dumps(feature_cols),
                    json.dumps(request.preprocessing.model_dump()),
                    request.sample_limit,
                    request.test_size,
                    request.primary_metric,
                    json.dumps(lb_dicts),
                ),
            )

        final_res = {
            "session_id": session_id,
            "project_key": request.project_key,
            "session_name": request.session_name,
            "leaderboard": lb_dicts,
        }
        complete_job(jid, final_res)
        return {"status": "completed", "job_id": jid, **final_res}

    except Exception as exc:
        fail_job(jid, str(exc))
        raise exc
