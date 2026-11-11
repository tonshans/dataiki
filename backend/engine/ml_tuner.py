"""Dataiki Phase 2 Optuna Deep Tuner and Immutable Bundle Freezer.

Executes Bayesian Optimization (Optuna) for hyperparameter tuning with:
- Holdout Baseline vs Tuned comparison.
- K-Fold cross validation on training partition.
- 3 Visual Insights (hyperparameter importance, optimization history, baseline vs tuned).
- Immutable Model Promotion to Production Gateway (v1, v2, ...).
- One-Click Retraining of published models on fresh data with locked hyperparameters (STAGED review).
"""

from __future__ import annotations

import json
import math
import os
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

import joblib
import numpy as np
import optuna
import polars as pl
from sklearn.compose import ColumnTransformer
from sklearn.model_selection import KFold, StratifiedKFold, train_test_split
from sklearn.preprocessing import LabelEncoder

# Candidate Model Imports
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

from backend.config import ARTIFACTS_DIR, CACHE_DIR
from backend.database import get_db
from backend.engine.dag_runner import execute_dag, trace_node_lineage
from backend.engine.ml_jobs import (
    complete_job,
    create_job,
    fail_job,
    get_job,
    update_progress,
)
from backend.engine.ml_screening import (
    _evaluate_classification_metrics,
    _evaluate_regression_metrics,
    build_column_transformer,
)
from backend.engine.recipe_engine import apply_recipe_steps
from backend.schemas import PreprocessingConfig, RecipeStep, TuningRequest

# Suppress Optuna verbose logs
optuna.logging.set_verbosity(optuna.logging.WARNING)


def _sample_hyperparameters(
    trial: optuna.Trial,
    algorithm: str,
    task_type: str,
) -> Dict[str, Any]:
    """Define Optuna parameter search space per algorithm."""
    algo = algorithm.strip().lower()

    if algo in ("lightgbm", "lgbm"):
        return {
            "n_estimators": trial.suggest_int("n_estimators", 50, 300, step=50),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "max_depth": trial.suggest_int("max_depth", 3, 10),
            "num_leaves": trial.suggest_int("num_leaves", 15, 127),
            "subsample": trial.suggest_float("subsample", 0.5, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
            "reg_alpha": trial.suggest_float("reg_alpha", 1e-8, 10.0, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-8, 10.0, log=True),
        }
    elif algo in ("xgboost", "xgb"):
        return {
            "n_estimators": trial.suggest_int("n_estimators", 50, 300, step=50),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "max_depth": trial.suggest_int("max_depth", 3, 10),
            "subsample": trial.suggest_float("subsample", 0.5, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.5, 1.0),
            "reg_alpha": trial.suggest_float("reg_alpha", 1e-8, 10.0, log=True),
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-8, 10.0, log=True),
        }
    elif algo in ("random forest", "randomforest"):
        return {
            "n_estimators": trial.suggest_int("n_estimators", 50, 200, step=50),
            "max_depth": trial.suggest_int("max_depth", 3, 16),
            "min_samples_split": trial.suggest_int("min_samples_split", 2, 10),
            "min_samples_leaf": trial.suggest_int("min_samples_leaf", 1, 4),
        }
    elif algo in ("extra trees", "extratrees"):
        return {
            "n_estimators": trial.suggest_int("n_estimators", 50, 200, step=50),
            "max_depth": trial.suggest_int("max_depth", 3, 16),
            "min_samples_split": trial.suggest_int("min_samples_split", 2, 10),
            "min_samples_leaf": trial.suggest_int("min_samples_leaf", 1, 4),
        }
    elif algo in ("gradient boosting", "gradientboosting"):
        return {
            "n_estimators": trial.suggest_int("n_estimators", 50, 200, step=50),
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "max_depth": trial.suggest_int("max_depth", 3, 8),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
        }
    elif algo == "ridge":
        return {
            "alpha": trial.suggest_float("alpha", 1e-3, 100.0, log=True),
        }
    elif algo in ("lasso", "lasso path"):
        return {
            "alpha": trial.suggest_float("alpha", 1e-4, 10.0, log=True),
        }
    elif algo == "elasticnet":
        return {
            "alpha": trial.suggest_float("alpha", 1e-4, 10.0, log=True),
            "l1_ratio": trial.suggest_float("l1_ratio", 0.1, 0.9),
        }
    elif algo in ("logistic regression", "logisticregression"):
        return {
            "C": trial.suggest_float("C", 1e-3, 100.0, log=True),
        }
    elif algo in ("decision tree", "decisiontree"):
        return {
            "max_depth": trial.suggest_int("max_depth", 2, 16),
            "min_samples_split": trial.suggest_int("min_samples_split", 2, 10),
        }
    elif algo == "knn":
        return {
            "n_neighbors": trial.suggest_int("n_neighbors", 3, 25),
            "weights": trial.suggest_categorical("weights", ["uniform", "distance"]),
        }
    elif algo in ("sgd regressor", "sgd classifier", "sgd"):
        return {
            "alpha": trial.suggest_float("alpha", 1e-5, 1.0, log=True),
        }
    elif algo in ("linear regression", "linearregression"):
        return {}
    else:
        # Default generic parameters
        return {
            "n_estimators": trial.suggest_int("n_estimators", 50, 150, step=50),
        }


def _instantiate_model(
    algorithm: str,
    task_type: str,
    params: Dict[str, Any],
    use_gpu: bool = False,
) -> Any:
    """Instantiate model with given hyperparameters."""
    algo = algorithm.strip().lower()
    is_cls = task_type in ("classification", "multiclass")

    if is_cls:
        if algo in ("lightgbm", "lgbm"):
            return lgb.LGBMClassifier(
                **params,
                random_state=42,
                verbose=-1,
                device_type="cuda" if use_gpu else "cpu",
            )
        elif algo in ("xgboost", "xgb"):
            return xgb.XGBClassifier(
                **params,
                random_state=42,
                verbosity=0,
                eval_metric="logloss",
                tree_method="hist",
                device="cuda" if use_gpu else "cpu",
            )
        elif algo in ("random forest", "randomforest"):
            return RandomForestClassifier(**params, random_state=42, n_jobs=-1)
        elif algo in ("extra trees", "extratrees"):
            return ExtraTreesClassifier(**params, random_state=42, n_jobs=-1)
        elif algo in ("gradient boosting", "gradientboosting"):
            return GradientBoostingClassifier(**params, random_state=42)
        elif algo in ("logistic regression", "logisticregression"):
            return LogisticRegression(**params, max_iter=1000, random_state=42)
        elif algo in ("decision tree", "decisiontree"):
            return DecisionTreeClassifier(**params, random_state=42)
        elif algo == "knn":
            return KNeighborsClassifier(**params)
        elif algo in ("sgd classifier", "sgd"):
            return SGDClassifier(**params, random_state=42, loss="log_loss")
        else:
            return RandomForestClassifier(**params, random_state=42, n_jobs=-1)
    else:
        if algo in ("lightgbm", "lgbm"):
            return lgb.LGBMRegressor(
                **params,
                random_state=42,
                verbose=-1,
                device_type="cuda" if use_gpu else "cpu",
            )
        elif algo in ("xgboost", "xgb"):
            return xgb.XGBRegressor(
                **params,
                random_state=42,
                verbosity=0,
                tree_method="hist",
                device="cuda" if use_gpu else "cpu",
            )
        elif algo in ("random forest", "randomforest"):
            return RandomForestRegressor(**params, random_state=42, n_jobs=-1)
        elif algo in ("extra trees", "extratrees"):
            return ExtraTreesRegressor(**params, random_state=42, n_jobs=-1)
        elif algo in ("gradient boosting", "gradientboosting"):
            return GradientBoostingRegressor(**params, random_state=42)
        elif algo == "ridge":
            return Ridge(**params)
        elif algo in ("lasso", "lasso path"):
            return Lasso(**params, random_state=42)
        elif algo == "elasticnet":
            return ElasticNet(**params, random_state=42)
        elif algo in ("decision tree", "decisiontree"):
            return DecisionTreeRegressor(**params, random_state=42)
        elif algo == "knn":
            return KNeighborsRegressor(**params)
        elif algo in ("linear regression", "linearregression"):
            return LinearRegression()
        elif algo in ("sgd regressor", "sgd"):
            return SGDRegressor(**params, random_state=42)
        else:
            return RandomForestRegressor(**params, random_state=42, n_jobs=-1)


def run_optuna_tuning(
    job_id: str,
    req: TuningRequest,
) -> Dict[str, Any]:
    """Execute Optuna Bayesian Optimization on training set with Holdout verification.

    Args:
        job_id: Unique job identifier in ml_jobs table.
        req: TuningRequest payload with algorithm, hyperparameters, and folds.

    Returns:
        Dictionary containing tuning metrics, best trial, and 3 visual insights.
    """
    update_progress(job_id, progress=5, status="running", message="Loading dataset for tuning")

    try:
        parquet_file = CACHE_DIR / req.project_key / f"{req.input_node_id}.parquet"
        if not parquet_file.exists():
            raise FileNotFoundError(f"Input Parquet not found: {parquet_file}")

        df = pl.read_parquet(parquet_file)
        if req.target_column not in df.columns:
            raise KeyError(f"Target column '{req.target_column}' missing in dataset.")

        feature_cols = [c for c in req.feature_columns if c in df.columns and c != req.target_column]
        if not feature_cols:
            raise ValueError("No valid feature columns provided for tuning.")

        # Sampling
        is_cls = req.task_type in ("classification", "multiclass")
        sample_df = df
        if req.sample_limit > 0 and df.height > req.sample_limit:
            sample_df = df.sample(n=req.sample_limit, seed=42)

        # Train/Test Split (Holdout Test)
        sub_df = sample_df.select([req.target_column] + feature_cols)
        sub_df = sub_df.filter(pl.col(req.target_column).is_not_null())

        stratify_target = sub_df[req.target_column].to_list() if is_cls else None
        train_indices, test_indices = train_test_split(
            np.arange(sub_df.height),
            test_size=req.test_size,
            random_state=42,
            stratify=stratify_target,
        )

        train_df = sub_df[train_indices]
        test_df = sub_df[test_indices]

        # Apply Train-Only recipe steps (SMOTE / Jitter) strictly on train_df
        lineage = trace_node_lineage(req.project_key, req.input_node_id)
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

        update_progress(job_id, progress=15, message="Fitting ColumnTransformer preprocessing")

        # Feature preprocessing via ColumnTransformer
        num_indices = [i for i, c in enumerate(feature_cols) if train_df[c].dtype.is_numeric()]
        cat_indices = [i for i, c in enumerate(feature_cols) if i not in num_indices]

        transformer = build_column_transformer(num_indices, cat_indices, req.preprocessing)

        X_train_raw = train_df.select(feature_cols).to_numpy()
        X_test_raw = test_df.select(feature_cols).to_numpy()

        y_train_raw = train_df[req.target_column].to_numpy()
        y_test_raw = test_df[req.target_column].to_numpy()

        le: Optional[LabelEncoder] = None
        is_multiclass = False
        if is_cls:
            le = LabelEncoder()
            y_train = le.fit_transform(y_train_raw)
            y_test = le.transform(y_test_raw)
            is_multiclass = len(le.classes_) > 2
        else:
            y_train = y_train_raw.astype(np.float64)
            y_test = y_test_raw.astype(np.float64)

        if req.preprocessing.categorical_encoder == "target" and cat_indices:
            X_train_trans = transformer.fit_transform(X_train_raw, y_train)
        else:
            X_train_trans = transformer.fit_transform(X_train_raw)
        X_test_trans = transformer.transform(X_test_raw)

        update_progress(job_id, progress=20, message="Evaluating Baseline model on Holdout")

        # 1. Baseline Evaluation (Default Hyperparameters)
        base_model = _instantiate_model(req.algorithm, req.task_type, {}, use_gpu=req.use_gpu)
        base_model.fit(X_train_trans, y_train)
        y_base_pred = base_model.predict(X_test_trans)

        y_base_proba = None
        if is_cls and hasattr(base_model, "predict_proba"):
            try:
                y_base_proba = base_model.predict_proba(X_test_trans)
            except Exception:
                pass

        if is_cls:
            base_metrics, base_cm = _evaluate_classification_metrics(
                y_true=y_test,
                y_pred=y_base_pred,
                y_proba=y_base_proba,
                is_multiclass=is_multiclass,
            )
        else:
            base_metrics = _evaluate_regression_metrics(y_true=y_test, y_pred=y_base_pred)
            base_cm = None

        # 2. Setup Optuna Optimization Direction
        higher_is_better = {
            "accuracy", "f1", "precision", "recall", "roc_auc",
            "average_precision", "mcc", "explained_variance", "r2",
            "pearson_r", "cost_matrix_gain",
        }
        pm = req.primary_metric.lower().strip()
        direction = "maximize" if pm in higher_is_better else "minimize"

        # K-Fold Cross Validation Setup
        n_samples = len(y_train)
        n_splits = min(req.cv_folds, max(2, n_samples // 5))

        if is_cls:
            cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
            cv_splits = list(cv.split(X_train_trans, y_train))
        else:
            cv = KFold(n_splits=n_splits, shuffle=True, random_state=42)
            cv_splits = list(cv.split(X_train_trans))

        trials_log: List[Dict[str, Any]] = []

        def objective(trial: optuna.Trial) -> float:
            t_start = time.perf_counter()
            params = _sample_hyperparameters(trial, req.algorithm, req.task_type)

            fold_scores: List[float] = []
            for tr_idx, val_idx in cv_splits:
                X_tr, X_val = X_train_trans[tr_idx], X_train_trans[val_idx]
                y_tr, y_val = y_train[tr_idx], y_train[val_idx]

                m = _instantiate_model(req.algorithm, req.task_type, params, use_gpu=req.use_gpu)
                m.fit(X_tr, y_tr)
                y_val_pred = m.predict(X_val)

                if is_cls:
                    y_val_proba = m.predict_proba(X_val) if hasattr(m, "predict_proba") else None
                    m_dict, _ = _evaluate_classification_metrics(y_val, y_val_pred, y_val_proba, is_multiclass)
                else:
                    m_dict = _evaluate_regression_metrics(y_val, y_val_pred)

                score = m_dict.get(pm, 0.0)
                fold_scores.append(score)

            mean_score = float(np.mean(fold_scores))
            duration = round(time.perf_counter() - t_start, 3)

            trials_log.append(
                {
                    "trial_number": trial.number + 1,
                    "params": params,
                    "score": round(mean_score, 4),
                    "duration_sec": duration,
                }
            )

            # Update progress
            pct = 25 + int(((trial.number + 1) / req.n_trials) * 60)
            update_progress(job_id, progress=min(85, pct), message=f"Optuna Trial {trial.number + 1}/{req.n_trials}")

            return mean_score

        # 3. Run Optuna Optimization
        study = optuna.create_study(direction=direction)
        study.optimize(objective, n_trials=req.n_trials)

        update_progress(job_id, progress=88, message="Refitting best tuned model on full training set")

        # 4. Refit Best Model on Full Training Set & Evaluate on Holdout Test
        best_params = study.best_params
        best_model = _instantiate_model(req.algorithm, req.task_type, best_params, use_gpu=req.use_gpu)
        best_model.fit(X_train_trans, y_train)

        y_tuned_pred = best_model.predict(X_test_trans)
        y_tuned_proba = None
        if is_cls and hasattr(best_model, "predict_proba"):
            try:
                y_tuned_proba = best_model.predict_proba(X_test_trans)
            except Exception:
                pass

        if is_cls:
            tuned_metrics, tuned_cm = _evaluate_classification_metrics(
                y_true=y_test,
                y_pred=y_tuned_pred,
                y_proba=y_tuned_proba,
                is_multiclass=is_multiclass,
            )
        else:
            tuned_metrics = _evaluate_regression_metrics(y_true=y_test, y_pred=y_tuned_pred)
            tuned_cm = None

        # 5. Compute 3 Visual Insights
        # a) Hyperparameter Importance
        importance: Dict[str, float] = {}
        try:
            if len(study.trials) >= 2:
                raw_imp = optuna.importance.get_param_importances(study)
                importance = {k: round(float(v), 4) for k, v in raw_imp.items()}
        except Exception:
            if best_params:
                eq_weight = round(1.0 / len(best_params), 4)
                importance = {k: eq_weight for k in best_params.keys()}

        # b) Optimization History
        opt_history: List[Dict[str, Any]] = []
        best_so_far: Optional[float] = None
        for t in study.trials:
            if t.value is None:
                continue
            if best_so_far is None:
                best_so_far = t.value
            else:
                if direction == "maximize":
                    best_so_far = max(best_so_far, t.value)
                else:
                    best_so_far = min(best_so_far, t.value)
            opt_history.append(
                {
                    "trial_number": t.number + 1,
                    "score": round(float(t.value), 4),
                    "best_so_far": round(float(best_so_far), 4),
                }
            )

        # c) Baseline vs Tuned Head-to-Head Comparison
        baseline_vs_tuned: Dict[str, Any] = {}
        all_metric_keys = set(base_metrics.keys()) | set(tuned_metrics.keys())
        for mk in all_metric_keys:
            bv = float(base_metrics.get(mk, 0.0))
            tv = float(tuned_metrics.get(mk, 0.0))
            baseline_vs_tuned[mk] = {
                "baseline": bv,
                "tuned": tv,
                "diff": round(tv - bv, 4),
            }

        # 6. Save Tuning Artifact Candidate
        tuning_artifact_dir = CACHE_DIR / req.project_key / f"tuning_{job_id}"
        tuning_artifact_dir.mkdir(parents=True, exist_ok=True)

        bundle_candidate = {
            "model": best_model,
            "transformer": transformer,
            "label_encoder": le,
            "project_key": req.project_key,
            "input_node_id": req.input_node_id,
            "task_type": req.task_type,
            "algorithm": req.algorithm,
            "target_column": req.target_column,
            "feature_columns": feature_cols,
            "preprocessing": req.preprocessing.model_dump(),
            "best_params": best_params,
            "tuned_metrics": tuned_metrics,
            "frozen_lineage": lineage,
            "training_sample": df.head(100).to_dict(as_series=False),
        }
        candidate_bundle_file = tuning_artifact_dir / "best_model.joblib"
        joblib.dump(bundle_candidate, candidate_bundle_file)

        final_result = {
            "tuning_job_id": job_id,
            "project_key": req.project_key,
            "session_id": req.session_id,
            "input_node_id": req.input_node_id,
            "algorithm": req.algorithm,
            "task_type": req.task_type,
            "primary_metric": req.primary_metric,
            "best_trial_number": study.best_trial.number + 1,
            "best_params": best_params,
            "best_cv_score": round(float(study.best_value), 4),
            "baseline_metrics": base_metrics,
            "tuned_metrics": tuned_metrics,
            "hyperparameter_importance": importance,
            "optimization_history": opt_history,
            "baseline_vs_tuned": baseline_vs_tuned,
            "trials": trials_log,
            "candidate_bundle_path": candidate_bundle_file.as_posix(),
        }

        complete_job(job_id, final_result)
        return {"status": "completed", **final_result}

    except Exception as exc:
        fail_job(job_id, str(exc))
        raise exc


def promote_to_production(
    project_key: str,
    tuning_job_id: str,
    trial_number: int,
    activate_immediately: bool = True,
    model_name: str = "",
) -> Dict[str, Any]:
    """Freeze candidate model artifact into an immutable production version (v1, v2, ...).

    Args:
        project_key: Project identifier.
        tuning_job_id: Completed tuning job ID in ml_jobs.
        trial_number: Trial number chosen for promotion.
        activate_immediately: If True, sets status to 'active' and deactivates prior versions.
        model_name: Name used by freestyle scripts and API bindings (defaults to project_key).

    Returns:
        Dictionary containing created version metadata and artifact paths.
    """
    job_info = get_job(tuning_job_id)
    if not job_info:
        raise KeyError(f"Tuning job '{tuning_job_id}' not found.")

    res = job_info.get("result", {})
    if not res:
        raise ValueError(f"Tuning job '{tuning_job_id}' has no completed results.")

    best_trial = int(res.get("best_trial_number", 0))
    if int(trial_number) != best_trial:
        raise ValueError(
            f"Trial #{trial_number} cannot be promoted directly; "
            f"only the best trial (#{best_trial}) has a frozen candidate bundle."
        )

    # Load candidate bundle
    candidate_path = res.get("candidate_bundle_path")
    if not candidate_path or not Path(candidate_path).exists():
        raise FileNotFoundError(f"Tuned candidate bundle missing: {candidate_path}")

    bundle_data: Dict[str, Any] = joblib.load(candidate_path)

    # Determine next version number
    with get_db() as conn:
        row = conn.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM model_versions WHERE project_key = ?",
            (project_key,),
        ).fetchone()
        next_ver = int(row["next_ver"])

    # Prepare Production Artifact paths
    v_dir = ARTIFACTS_DIR / project_key / f"v{next_ver}"
    v_dir.mkdir(parents=True, exist_ok=True)
    bundle_dest = v_dir / "bundle.joblib"
    sample_dest = v_dir / "training_sample.parquet"

    # Input node Parquet to generate reference training sample
    input_node_id = bundle_data["input_node_id"]
    source_parquet = CACHE_DIR / project_key / f"{input_node_id}.parquet"
    if source_parquet.exists():
        ref_df = pl.read_parquet(source_parquet).head(200)
    else:
        ref_df = pl.DataFrame(bundle_data.get("training_sample", {}))

    ref_df.write_parquet(sample_dest)

    # Input schema
    input_schema = {c: str(ref_df[c].dtype) for c in ref_df.columns}

    # Freeze lineage metadata
    frozen_lineage = bundle_data.get("frozen_lineage", {})
    frozen_lineage["preprocessing"] = bundle_data.get("preprocessing", {})
    frozen_lineage["target_node_id"] = input_node_id
    frozen_lineage["promoted_trial_number"] = best_trial

    # Package production bundle
    resolved_name = (model_name or "").strip() or project_key
    prod_bundle = {
        "model": bundle_data["model"],
        "transformer": bundle_data["transformer"],
        "label_encoder": bundle_data.get("label_encoder"),
        "project_key": project_key,
        "model_name": resolved_name,
        "version": next_ver,
        "trial_number": best_trial,
        "task_type": bundle_data["task_type"],
        "algorithm": bundle_data["algorithm"],
        "target_column": bundle_data["target_column"],
        "feature_columns": bundle_data["feature_columns"],
        "hyperparameters": bundle_data["best_params"],
        "metrics": bundle_data["tuned_metrics"],
        "frozen_lineage": frozen_lineage,
        "input_schema": input_schema,
    }
    joblib.dump(prod_bundle, bundle_dest)

    version_status = "active" if activate_immediately else "staged"

    with get_db() as conn:
        if activate_immediately:
            conn.execute(
                "UPDATE model_versions SET status = 'staged' WHERE project_key = ? AND status = 'active'",
                (project_key,),
            )

        conn.execute(
            """
            INSERT INTO model_versions (
                project_key, model_name, version, status, task_type, algorithm,
                target_column, feature_columns_json, input_schema_json,
                metrics_json, hyperparameters_json, frozen_lineage_json,
                artifact_path, training_sample_path
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_key,
                resolved_name,
                next_ver,
                version_status,
                bundle_data["task_type"],
                bundle_data["algorithm"],
                bundle_data["target_column"],
                json.dumps(bundle_data["feature_columns"]),
                json.dumps(input_schema),
                json.dumps(bundle_data["tuned_metrics"]),
                json.dumps(bundle_data["best_params"]),
                json.dumps(frozen_lineage),
                bundle_dest.as_posix(),
                sample_dest.as_posix(),
            ),
        )

    return {
        "project_key": project_key,
        "version": next_ver,
        "model_name": resolved_name,
        "status": version_status,
        "algorithm": bundle_data["algorithm"],
        "task_type": bundle_data["task_type"],
        "artifact_path": bundle_dest.as_posix(),
        "training_sample_path": sample_dest.as_posix(),
        "metrics": bundle_data["tuned_metrics"],
    }


def retrain_published_model(
    project_key: str,
    base_version: int,
) -> Dict[str, Any]:
    """Retrain a published model on latest data with locked hyperparameters (STAGED review).

    Args:
        project_key: Project identifier.
        base_version: The existing active/published model version to base retraining on.

    Returns:
        Dictionary containing Old Active vs New Staged comparison metrics and new version id.
    """
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM model_versions WHERE project_key = ? AND version = ?",
            (project_key, base_version),
        ).fetchone()

    if not row:
        raise KeyError(f"Model version v{base_version} for project '{project_key}' not found.")

    frozen_lineage = json.loads(row["frozen_lineage_json"])
    locked_params = json.loads(row["hyperparameters_json"])
    feature_cols = json.loads(row["feature_columns_json"])
    old_metrics = json.loads(row["metrics_json"])
    task_type = row["task_type"]
    algorithm = row["algorithm"]
    target_column = row["target_column"]
    base_model_name = row["model_name"] or project_key
    target_node_id = frozen_lineage.get("target_node_id")

    # Re-execute DAG pipeline to pull fresh data
    fresh_parquet: Optional[Path] = None
    if target_node_id:
        try:
            execute_dag(project_key, target_node_id=target_node_id)
            fresh_parquet = CACHE_DIR / project_key / f"{target_node_id}.parquet"
        except Exception:
            # Fallback to existing cache if source external connection/file is unreachable
            candidate = CACHE_DIR / project_key / f"{target_node_id}.parquet"
            if candidate.exists():
                fresh_parquet = candidate

    if fresh_parquet is None or not fresh_parquet.exists():
        fresh_parquet = Path(row["training_sample_path"])

    if not fresh_parquet.exists():
        raise FileNotFoundError(f"Fresh data Parquet not found: {fresh_parquet}")

    df = pl.read_parquet(fresh_parquet)
    is_cls = task_type in ("classification", "multiclass")

    # Train / Test split on fresh data (80 / 20)
    sub_df = df.select([target_column] + feature_cols).filter(pl.col(target_column).is_not_null())
    stratify = sub_df[target_column].to_list() if is_cls else None
    tr_idx, te_idx = train_test_split(
        np.arange(sub_df.height),
        test_size=0.20,
        random_state=42,
        stratify=stratify,
    )

    train_df = sub_df[tr_idx]
    test_df = sub_df[te_idx]

    # Apply train-only augmentation cards if any
    train_only_steps_raw = [
        s for s in frozen_lineage.get("recipe_steps", []) if s.get("is_train_only") is True
    ]
    if train_only_steps_raw:
        train_only_steps = [RecipeStep.model_validate(s) for s in train_only_steps_raw]
        train_df, _ = apply_recipe_steps(
            train_df, train_only_steps, include_train_only=True, fail_fast_mode=False
        )

    # Re-fit preprocessing
    prep_cfg = PreprocessingConfig.model_validate(frozen_lineage.get("preprocessing", {}))
    num_idx = [i for i, c in enumerate(feature_cols) if train_df[c].dtype.is_numeric()]
    cat_idx = [i for i, c in enumerate(feature_cols) if i not in num_idx]

    transformer = build_column_transformer(num_idx, cat_idx, prep_cfg)
    X_tr_raw = train_df.select(feature_cols).to_numpy()
    X_te_raw = test_df.select(feature_cols).to_numpy()

    y_tr_raw = train_df[target_column].to_numpy()
    y_te_raw = test_df[target_column].to_numpy()

    le: Optional[LabelEncoder] = None
    is_multiclass = False
    if is_cls:
        le = LabelEncoder()
        y_tr = le.fit_transform(y_tr_raw)
        y_te = le.transform(y_te_raw)
        is_multiclass = len(le.classes_) > 2
    else:
        y_tr = y_tr_raw.astype(np.float64)
        y_te = y_te_raw.astype(np.float64)

    if prep_cfg.categorical_encoder == "target" and cat_idx:
        X_tr_trans = transformer.fit_transform(X_tr_raw, y_tr)
    else:
        X_tr_trans = transformer.fit_transform(X_tr_raw)
    X_te_trans = transformer.transform(X_te_raw)

    # Train model with locked hyperparameters
    model = _instantiate_model(algorithm, task_type, locked_params)
    model.fit(X_tr_trans, y_tr)

    # Evaluate new metrics on fresh holdout
    y_pred = model.predict(X_te_trans)
    y_proba = None
    if is_cls and hasattr(model, "predict_proba"):
        try:
            y_proba = model.predict_proba(X_te_trans)
        except Exception:
            pass

    if is_cls:
        new_metrics, _ = _evaluate_classification_metrics(y_te, y_pred, y_proba, is_multiclass)
    else:
        new_metrics = _evaluate_regression_metrics(y_te, y_pred)

    # Determine next version number
    with get_db() as conn:
        v_row = conn.execute(
            "SELECT COALESCE(MAX(version), 0) + 1 AS next_ver FROM model_versions WHERE project_key = ?",
            (project_key,),
        ).fetchone()
        new_version = int(v_row["next_ver"])

    v_dir = ARTIFACTS_DIR / project_key / f"v{new_version}"
    v_dir.mkdir(parents=True, exist_ok=True)
    bundle_path = v_dir / "bundle.joblib"
    sample_path = v_dir / "training_sample.parquet"

    df.head(200).write_parquet(sample_path)
    input_schema = {c: str(df[c].dtype) for c in feature_cols}  # feature columns only, never target

    prod_bundle = {
        "model": model,
        "transformer": transformer,
        "label_encoder": le,
        "project_key": project_key,
        "model_name": base_model_name,
        "version": new_version,
        "task_type": task_type,
        "algorithm": algorithm,
        "target_column": target_column,
        "feature_columns": feature_cols,
        "hyperparameters": locked_params,
        "metrics": new_metrics,
        "frozen_lineage": frozen_lineage,
        "input_schema": input_schema,
    }
    joblib.dump(prod_bundle, bundle_path)

    # Insert into model_versions strictly as STAGED (never overwrites ACTIVE)
    with get_db() as conn:
        conn.execute(
            """
            INSERT INTO model_versions (
                project_key, model_name, version, status, task_type, algorithm,
                target_column, feature_columns_json, input_schema_json,
                metrics_json, hyperparameters_json, frozen_lineage_json,
                artifact_path, training_sample_path
            ) VALUES (?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                project_key,
                base_model_name,
                new_version,
                task_type,
                algorithm,
                target_column,
                json.dumps(feature_cols),
                json.dumps(input_schema),
                json.dumps(new_metrics),
                json.dumps(locked_params),
                json.dumps(frozen_lineage),
                bundle_path.as_posix(),
                sample_path.as_posix(),
            ),
        )

    # Metrics comparison (Old Active vs New Staged)
    comparison: Dict[str, Any] = {}
    for k in set(old_metrics.keys()) | set(new_metrics.keys()):
        ov = float(old_metrics.get(k, 0.0))
        nv = float(new_metrics.get(k, 0.0))
        comparison[k] = {
            "old_active": ov,
            "new_staged": nv,
            "diff": round(nv - ov, 4),
        }

    return {
        "project_key": project_key,
        "base_version": base_version,
        "new_version": new_version,
        "model_name": base_model_name,
        "status": "staged",
        "algorithm": algorithm,
        "locked_hyperparameters": locked_params,
        "old_active_metrics": old_metrics,
        "new_staged_metrics": new_metrics,
        "metrics_comparison": comparison,
        "artifact_path": bundle_path.as_posix(),
    }
