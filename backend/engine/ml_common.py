"""Dataiki Shared ML Primitives (dataset preparation, preprocessing, evaluation).

Single source of truth for the logic shared by Phase 1 Screening (ml_screening)
and Phase 2 Optuna Tuning / Retraining (ml_tuner):
- Holdout sampling + stratified split with fixed seed 42.
- Train-only augmentation isolation (SMOTE/Jitter applied ONLY on train_df).
- ColumnTransformer builder (NumPy/Polars, zero Pandas overhead).
- Regression & classification metric evaluation.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

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

from backend.engine.dag_runner import trace_node_lineage
from backend.engine.recipe_engine import apply_recipe_steps
from backend.schemas import PreprocessingConfig, RecipeStep

HIGHER_IS_BETTER_METRICS: Set[str] = {
    "accuracy",
    "f1",
    "precision",
    "recall",
    "roc_auc",
    "average_precision",
    "mcc",
    "explained_variance",
    "r2",
    "pearson_r",
    "cost_matrix_gain",
}


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


@dataclass
class PreparedMLDataset:
    """Holdout-ready dataset: split frames, fitted preprocessing, encoded targets."""

    df: pl.DataFrame
    train_df: pl.DataFrame
    test_df: pl.DataFrame
    feature_cols: List[str]
    X_train: np.ndarray
    X_test: np.ndarray
    y_train: np.ndarray
    y_test: np.ndarray
    transformer: ColumnTransformer
    label_encoder: Optional[LabelEncoder]
    is_classification: bool
    is_multiclass: bool
    lineage: Dict[str, Any] = field(default_factory=dict)


def prepare_ml_dataset(
    df: pl.DataFrame,
    target_column: str,
    feature_columns: List[str],
    task_type: str,
    preprocessing: PreprocessingConfig,
    *,
    sample_limit: int = 0,
    test_size: float = 0.2,
    project_key: Optional[str] = None,
    input_node_id: Optional[str] = None,
    frozen_lineage: Optional[Dict[str, Any]] = None,
) -> PreparedMLDataset:
    """Split a dataframe into holdout train/test and fit preprocessing.

    Lineage is either re-traced from the DAG (project_key + input_node_id) or
    taken from ``frozen_lineage`` (published model retraining). Train-only
    recipe steps (SMOTE/Jitter) are applied strictly on ``train_df``.
    """
    if target_column not in df.columns:
        raise KeyError(f"Target column '{target_column}' missing in dataset.")

    feature_cols = [c for c in feature_columns if c in df.columns and c != target_column]
    if not feature_cols:
        raise ValueError("No valid feature columns provided.")

    is_classification = task_type in ("classification", "multiclass")

    # 1. Sampling
    sample_df = df
    if sample_limit > 0 and df.height > sample_limit:
        sample_df = df.sample(n=sample_limit, seed=42)

    # 2. Train-Test Split (Holdout Test)
    sub_df = sample_df.select([target_column] + feature_cols)
    sub_df = sub_df.filter(pl.col(target_column).is_not_null())

    stratify_target = sub_df[target_column].to_list() if is_classification else None
    train_indices, test_indices = train_test_split(
        np.arange(sub_df.height),
        test_size=test_size,
        random_state=42,
        stratify=stratify_target,
    )

    train_df = sub_df[train_indices]
    test_df = sub_df[test_indices]

    # 3. Lineage: reuse frozen metadata when provided, otherwise trace the DAG
    if frozen_lineage is not None:
        lineage = frozen_lineage
    else:
        if not project_key or not input_node_id:
            raise ValueError("project_key and input_node_id are required to trace lineage.")
        lineage = trace_node_lineage(project_key, input_node_id)

    # 4. Train-only steps (SMOTE / Jitter) strictly on train_df
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

    # 5. Separate Numerical and Categorical Columns by index
    num_indices = [i for i, c in enumerate(feature_cols) if train_df[c].dtype.is_numeric()]
    cat_indices = [i for i, c in enumerate(feature_cols) if i not in num_indices]

    transformer = build_column_transformer(num_indices, cat_indices, preprocessing)

    X_train_raw = train_df.select(feature_cols).to_numpy()
    X_test_raw = test_df.select(feature_cols).to_numpy()

    y_train_raw = train_df[target_column].to_numpy()
    y_test_raw = test_df[target_column].to_numpy()

    label_encoder: Optional[LabelEncoder] = None
    is_multiclass = False
    if is_classification:
        label_encoder = LabelEncoder()
        y_train = label_encoder.fit_transform(y_train_raw)
        y_test = label_encoder.transform(y_test_raw)
        is_multiclass = len(label_encoder.classes_) > 2
    else:
        y_train = y_train_raw.astype(np.float64)
        y_test = y_test_raw.astype(np.float64)

    # 6. Fit preprocessor (target encoder needs the encoded train target)
    if preprocessing.categorical_encoder == "target" and cat_indices:
        X_train = transformer.fit_transform(X_train_raw, y_train)
    else:
        X_train = transformer.fit_transform(X_train_raw)
    X_test = transformer.transform(X_test_raw)

    return PreparedMLDataset(
        df=df,
        train_df=train_df,
        test_df=test_df,
        feature_cols=feature_cols,
        X_train=X_train,
        X_test=X_test,
        y_train=y_train,
        y_test=y_test,
        transformer=transformer,
        label_encoder=label_encoder,
        is_classification=is_classification,
        is_multiclass=is_multiclass,
        lineage=lineage,
    )


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


def evaluate_model_predictions(
    model: Any,
    X_test: np.ndarray,
    y_test: np.ndarray,
    is_classification: bool,
    is_multiclass: bool,
) -> Tuple[Dict[str, float], Optional[Dict[str, Any]]]:
    """Predict on the holdout test set and compute metrics (plus confusion matrix)."""
    y_pred = model.predict(X_test)

    if is_classification:
        y_proba = None
        if hasattr(model, "predict_proba"):
            try:
                y_proba = model.predict_proba(X_test)
            except Exception:
                pass
        return _evaluate_classification_metrics(
            y_true=y_test,
            y_pred=y_pred,
            y_proba=y_proba,
            is_multiclass=is_multiclass,
        )

    return _evaluate_regression_metrics(y_true=y_test, y_pred=y_pred), None
