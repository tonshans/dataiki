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
import math
import time
import uuid
from typing import Any, Dict, List, Optional, Tuple, Union

import numpy as np
import polars as pl
from scipy.stats import pearsonr
from sklearn.base import BaseEstimator, TransformerMixin
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.metrics import (
    accuracy_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
    explained_variance_score,
    f1_score,
    hamming_loss,
    log_loss,
    matthews_corrcoef,
    mean_absolute_error,
    mean_absolute_percentage_error,
    mean_squared_error,
    precision_score,
    r2_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import (
    LabelEncoder,
    MinMaxScaler,
    OneHotEncoder,
    OrdinalEncoder,
    RobustScaler,
    StandardScaler,
    TargetEncoder,
)

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
from backend.engine.dag_runner import trace_node_lineage
from backend.engine.ml_jobs import (
    complete_job,
    create_job,
    fail_job,
    set_paused_high_cardinality,
    update_progress,
)
from backend.engine.recipe_engine import apply_recipe_steps
from backend.schemas import LeaderboardEntry, PreprocessingConfig, RecipeStep, ScreeningRequest


class FrequencyEncoder(BaseEstimator, TransformerMixin):
    """Encodes categorical features by their category frequencies."""

    def __init__(self):
        self.frequencies_: Dict[int, Dict[Any, float]] = {}

    def fit(self, X, y=None):
        X_arr = np.asarray(X)
        self.frequencies_ = {}
        for col_idx in range(X_arr.shape[1]):
            col = X_arr[:, col_idx]
            vals, counts = np.unique(col, return_counts=True)
            total = float(len(col))
            self.frequencies_[col_idx] = {v: float(c) / total for v, c in zip(vals, counts)}
        return self

    def transform(self, X):
        X_arr = np.asarray(X)
        out = np.zeros(X_arr.shape, dtype=np.float64)
        for col_idx in range(X_arr.shape[1]):
            mapping = self.frequencies_.get(col_idx, {})
            col = X_arr[:, col_idx]
            out[:, col_idx] = [mapping.get(val, 0.0) for val in col]
        return out


def build_column_transformer(
    numerical_indices: List[int],
    categorical_indices: List[int],
    config: PreprocessingConfig,
) -> ColumnTransformer:
    """Build scikit-learn ColumnTransformer using integer feature indices."""
    transformers = []

    # 1. Numerical Pipeline
    if numerical_indices:
        num_steps = []
        if config.numerical_imputer in ("mean", "median"):
            num_steps.append(("imputer", SimpleImputer(strategy=config.numerical_imputer)))
        elif config.numerical_imputer == "constant":
            num_steps.append(("imputer", SimpleImputer(strategy="constant", fill_value=0.0)))
        else:
            num_steps.append(("imputer", SimpleImputer(strategy="median")))

        if config.numerical_scaler == "standard":
            num_steps.append(("scaler", StandardScaler()))
        elif config.numerical_scaler == "minmax":
            num_steps.append(("scaler", MinMaxScaler()))
        elif config.numerical_scaler == "robust":
            num_steps.append(("scaler", RobustScaler()))

        transformers.append(("num", Pipeline(num_steps), numerical_indices))

    # 2. Categorical Pipeline
    if categorical_indices:
        cat_steps = []
        if config.categorical_imputer == "mode":
            cat_steps.append(("imputer", SimpleImputer(strategy="most_frequent")))
        else:
            cat_steps.append(("imputer", SimpleImputer(strategy="constant", fill_value="missing")))

        if config.categorical_encoder == "onehot":
            cat_steps.append(("encoder", OneHotEncoder(handle_unknown="ignore", sparse_output=False)))
        elif config.categorical_encoder == "ordinal":
            cat_steps.append(("encoder", OrdinalEncoder(handle_unknown="use_encoded_value", unknown_value=-1)))
        elif config.categorical_encoder == "target":
            cat_steps.append(("encoder", TargetEncoder(smooth="auto", cv=2)))
        elif config.categorical_encoder == "frequency":
            cat_steps.append(("encoder", FrequencyEncoder()))
        else:
            cat_steps.append(("encoder", OneHotEncoder(handle_unknown="ignore", sparse_output=False)))

        transformers.append(("cat", Pipeline(cat_steps), categorical_indices))

    return ColumnTransformer(transformers=transformers, remainder="drop")


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


def _evaluate_regression_metrics(y_true: np.ndarray, y_pred: np.ndarray) -> Dict[str, float]:
    """Calculate all standard PRD regression metrics."""
    ev = float(explained_variance_score(y_true, y_pred))
    try:
        mape = float(mean_absolute_percentage_error(y_true, y_pred))
    except Exception:
        mape = 0.0

    mae = float(mean_absolute_error(y_true, y_pred))
    mse = float(mean_squared_error(y_true, y_pred))
    rmse = float(math.sqrt(mse))

    try:
        y_true_log = np.log1p(np.clip(y_true, 0, None))
        y_pred_log = np.log1p(np.clip(y_pred, 0, None))
        rmsle = float(math.sqrt(mean_squared_error(y_true_log, y_pred_log)))
    except Exception:
        rmsle = 0.0

    r2 = float(r2_score(y_true, y_pred))

    try:
        corr_val, _ = pearsonr(y_true, y_pred)
        corr = float(corr_val) if not np.isnan(corr_val) else 0.0
    except Exception:
        corr = 0.0

    return {
        "explained_variance": round(ev, 4),
        "mape": round(mape, 4),
        "mae": round(mae, 4),
        "mse": round(mse, 4),
        "rmse": round(rmse, 4),
        "rmsle": round(rmsle, 4),
        "r2": round(r2, 4),
        "pearson_r": round(corr, 4),
    }


def _evaluate_classification_metrics(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    y_proba: Optional[np.ndarray],
    is_multiclass: bool,
) -> Tuple[Dict[str, float], Optional[Dict[str, Any]]]:
    """Calculate all standard PRD classification metrics including confusion matrix."""
    avg_mode = "macro" if is_multiclass else "binary"

    acc = float(accuracy_score(y_true, y_pred))
    f1 = float(f1_score(y_true, y_pred, average=avg_mode, zero_division=0))
    prec = float(precision_score(y_true, y_pred, average=avg_mode, zero_division=0))
    rec = float(recall_score(y_true, y_pred, average=avg_mode, zero_division=0))
    mcc = float(matthews_corrcoef(y_true, y_pred))
    hl = float(hamming_loss(y_true, y_pred))

    cm = confusion_matrix(y_true, y_pred)
    cm_dict: Dict[str, Any] = {
        "matrix": cm.tolist(),
        "labels": [int(x) for x in sorted(list(set(y_true)))],
    }

    # Probability-based metrics
    roc_auc = 0.0
    loss_val = 0.0
    avg_prec = 0.0
    cal_loss = 0.0

    if y_proba is not None:
        try:
            if is_multiclass:
                roc_auc = float(roc_auc_score(y_true, y_proba, multi_class="ovr", average="macro"))
                loss_val = float(log_loss(y_true, y_proba))
            else:
                prob_pos = y_proba[:, 1] if y_proba.ndim > 1 and y_proba.shape[1] > 1 else y_proba
                roc_auc = float(roc_auc_score(y_true, prob_pos))
                avg_prec = float(average_precision_score(y_true, prob_pos))
                loss_val = float(log_loss(y_true, prob_pos))
                cal_loss = float(brier_score_loss(y_true, prob_pos))
        except Exception:
            pass

    # Cost Matrix Gain calculation
    if not is_multiclass and cm.shape == (2, 2):
        tn, fp, fn, tp = cm.ravel()
        cost_gain = float(2.0 * tp - 1.0 * fp)
    else:
        cost_gain = float(acc * 100.0)

    metrics = {
        "accuracy": round(acc, 4),
        "f1": round(f1, 4),
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "roc_auc": round(roc_auc, 4),
        "average_precision": round(avg_prec, 4),
        "log_loss": round(loss_val, 4),
        "calibration_loss": round(cal_loss, 4),
        "mcc": round(mcc, 4),
        "hamming_loss": round(hl, 4),
        "cost_matrix_gain": round(cost_gain, 4),
    }
    return metrics, cm_dict


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

        # 3. Sampling
        is_classification = request.task_type in ("classification", "multiclass")
        sample_df = df
        if request.sample_limit > 0 and df.height > request.sample_limit:
            sample_df = df.sample(n=request.sample_limit, seed=42)

        # 4. Train-Test Split (Holdout Test)
        sub_df = sample_df.select([request.target_column] + feature_cols)
        sub_df = sub_df.filter(pl.col(request.target_column).is_not_null())

        stratify_target = None
        if is_classification:
            stratify_target = sub_df[request.target_column].to_list()

        train_indices, test_indices = train_test_split(
            np.arange(sub_df.height),
            test_size=request.test_size,
            random_state=42,
            stratify=stratify_target,
        )

        train_df = sub_df[train_indices]
        test_df = sub_df[test_indices]

        # 5. Execute Lineage Train-Only Steps (SMOTE / Jitter) ONLY on train_df
        lineage = trace_node_lineage(request.project_key, request.input_node_id)
        train_only_steps_raw = [
            s for s in lineage.get("recipe_steps", []) if s.get("is_train_only") is True
        ]
        if train_only_steps_raw:
            train_only_steps = [RecipeStep.model_validate(s) for s in train_only_steps_raw]
            train_df, _ = apply_recipe_steps(
                train_df,
                train_only_steps,
                include_train_only=True,
                fail_fast_mode=False,
            )

        update_progress(jid, progress=30, message="Fitting ColumnTransformer preprocessing")

        # 6. Separate Numerical and Categorical Columns by index
        num_indices = [i for i, c in enumerate(feature_cols) if train_df[c].dtype.is_numeric()]
        cat_indices = [i for i, c in enumerate(feature_cols) if i not in num_indices]

        transformer = build_column_transformer(num_indices, cat_indices, request.preprocessing)

        X_train_raw = train_df.select(feature_cols).to_numpy()
        X_test_raw = test_df.select(feature_cols).to_numpy()

        y_train_raw = train_df[request.target_column].to_numpy()
        y_test_raw = test_df[request.target_column].to_numpy()

        is_multiclass = False
        if is_classification:
            le = LabelEncoder()
            y_train = le.fit_transform(y_train_raw)
            y_test = le.transform(y_test_raw)
            is_multiclass = len(le.classes_) > 2
        else:
            y_train = y_train_raw.astype(np.float64)
            y_test = y_test_raw.astype(np.float64)

        # Fit preprocessor
        if request.preprocessing.categorical_encoder == "target" and cat_indices:
            X_train_trans = transformer.fit_transform(X_train_raw, y_train)
        else:
            X_train_trans = transformer.fit_transform(X_train_raw)
        X_test_trans = transformer.transform(X_test_raw)

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

                y_pred = model_inst.predict(X_test_trans)
                y_proba = None
                if is_classification and hasattr(model_inst, "predict_proba"):
                    try:
                        y_proba = model_inst.predict_proba(X_test_trans)
                    except Exception:
                        pass

                if is_classification:
                    metrics, cm_dict = _evaluate_classification_metrics(
                        y_true=y_test,
                        y_pred=y_pred,
                        y_proba=y_proba,
                        is_multiclass=is_multiclass,
                    )
                else:
                    metrics = _evaluate_regression_metrics(y_true=y_test, y_pred=y_pred)
                    cm_dict = None

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
        higher_is_better = {
            "accuracy", "f1", "precision", "recall", "roc_auc",
            "average_precision", "mcc", "explained_variance", "r2",
            "pearson_r", "cost_matrix_gain",
        }
        pm = request.primary_metric.lower().strip()
        desc = pm in higher_is_better

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
