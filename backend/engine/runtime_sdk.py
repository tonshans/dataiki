"""Dataiki Production Runtime SDK.

Provides high-performance production inference primitives:
- LRU cached production model loader (@lru_cache(maxsize=10)).
- PublishedModelWrapper: executes frozen recipes (fail_fast_mode=True), transforms, preprocessing, and estimator.
- DataikiRuntimeSDK: global 'dataiki' instance injected into custom inference scripts for API endpoints.
- execute_custom_endpoint_script: executes custom REST endpoint handler in controlled sandbox.
"""

from __future__ import annotations

import inspect
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union

import joblib
import numpy as np
import polars as pl

from backend.config import ARTIFACTS_DIR, CACHE_DIR
from backend.database import get_db
from backend.engine.recipe_engine import RecipeValidationError, replay_frozen_lineage
from backend.engine.sandbox import load_sandboxed_function
from backend.engine.vault import DatabaseConnectionWrapper, get_connection_wrapper


@lru_cache(maxsize=10)
def load_bundle_cached(bundle_path: str) -> Dict[str, Any]:
    """Load serialized production model bundle with LRU caching."""
    path = Path(bundle_path)
    if not path.exists():
        raise FileNotFoundError(f"Production bundle not found: {bundle_path}")
    return joblib.load(path)


def clear_model_cache() -> None:
    """Clear memory of all LRU cached model bundles."""
    load_bundle_cached.cache_clear()


class PublishedModelWrapper:
    """Wrapper around a frozen production model version.

    Executes the exact frozen pipeline in order:
    1. Frozen lineage replay (recipe steps + Python transforms, fail_fast_mode=True).
    2. Frozen ColumnTransformer preprocessing.
    3. Estimator prediction or probability inference.
    """

    def __init__(
        self,
        bundle: Dict[str, Any],
        training_sample_path: Optional[str] = None,
        model_name: Optional[str] = None,
    ) -> None:
        self.bundle = bundle
        self.model = bundle["model"]
        self.transformer = bundle["transformer"]
        self.label_encoder = bundle.get("label_encoder")
        self.project_key: str = bundle.get("project_key", "")
        self.model_name: str = model_name or bundle.get("model_name") or self.project_key
        self.version: int = bundle.get("version", 1)
        self.task_type: str = bundle.get("task_type", "")
        self.algorithm: str = bundle.get("algorithm", "")
        self.target_column: str = bundle.get("target_column", "")
        self.feature_columns: List[str] = bundle.get("feature_columns", [])
        self.hyperparameters: Dict[str, Any] = bundle.get("hyperparameters", {})
        self.metrics: Dict[str, float] = bundle.get("metrics", {})
        self.frozen_lineage: Dict[str, Any] = bundle.get("frozen_lineage", {})
        self.input_schema: Dict[str, str] = bundle.get("input_schema", {})
        self.training_sample_path = training_sample_path

    def get_info(self) -> Dict[str, Any]:
        """Return public metadata of the published model version."""
        return {
            "project_key": self.project_key,
            "model_name": self.model_name,
            "version": self.version,
            "task_type": self.task_type,
            "algorithm": self.algorithm,
            "target_column": self.target_column,
            "feature_columns": self.feature_columns,
            "metrics": self.metrics,
            "hyperparameters": self.hyperparameters,
            "input_schema": self.input_schema,
        }

    def get_training_data(self) -> pl.DataFrame:
        """Return reference sample DataFrame used during training."""
        if self.training_sample_path and Path(self.training_sample_path).exists():
            return pl.read_parquet(self.training_sample_path)
        sample_dict = self.bundle.get("training_sample")
        if sample_dict:
            return pl.DataFrame(sample_dict)
        return pl.DataFrame()

    def _prepare_features(
        self,
        data: Union[Dict[str, Any], List[Dict[str, Any]], pl.DataFrame],
    ) -> np.ndarray:
        """Run fail-fast recipe checks, python transforms, and preprocessing."""
        # Convert input to Polars DataFrame
        if isinstance(data, dict):
            df = pl.DataFrame([data])
        elif isinstance(data, list):
            if not data:
                raise ValueError("Inference input data list is empty.")
            df = pl.DataFrame(data)
        elif isinstance(data, pl.DataFrame):
            df = data
        else:
            raise TypeError(
                f"Unsupported data type for inference: {type(data).__name__}. Expected dict, list, or pl.DataFrame."
            )

        # 1. Replay frozen lineage (recipe steps + python transforms) in the same
        # order as the Live Gateway; fail_fast_mode=True raises on rejected rows.
        df = replay_frozen_lineage(df, self.frozen_lineage, fail_fast_mode=True)

        # 2. Ensure all feature columns exist
        missing_cols = [c for c in self.feature_columns if c not in df.columns]
        if missing_cols:
            raise RecipeValidationError(
                step_label="input_schema_validation",
                record_index=0,
                message=f"Missing required feature columns: {missing_cols}",
            )

        # 3. Transform features using pre-fitted ColumnTransformer
        X_raw = df.select(self.feature_columns).to_numpy()
        X_trans = self.transformer.transform(X_raw)
        return X_trans

    def predict(
        self,
        data: Union[Dict[str, Any], List[Dict[str, Any]], pl.DataFrame],
    ) -> Any:
        """Generate predictions for single record, list of records, or DataFrame."""
        is_single_dict = isinstance(data, dict)
        X_trans = self._prepare_features(data)
        preds = self.model.predict(X_trans)

        if self.label_encoder is not None:
            preds = self.label_encoder.inverse_transform(preds)

        if isinstance(preds, np.ndarray):
            pred_list = preds.tolist()
            return pred_list[0] if is_single_dict else pred_list
        return preds

    def predict_proba(
        self,
        data: Union[Dict[str, Any], List[Dict[str, Any]], pl.DataFrame],
    ) -> Any:
        """Generate prediction class probabilities."""
        if not hasattr(self.model, "predict_proba"):
            raise NotImplementedError(
                f"Model algorithm '{self.algorithm}' does not support probability estimation."
            )

        is_single_dict = isinstance(data, dict)
        X_trans = self._prepare_features(data)
        probas = self.model.predict_proba(X_trans)

        if isinstance(probas, np.ndarray):
            proba_list = probas.tolist()
            return proba_list[0] if is_single_dict else proba_list
        return probas


class _VaultAccessor:
    """Namespace for accessing connection vault inside runtime scripts."""

    def get_connection(self, name_or_id: str) -> DatabaseConnectionWrapper:
        """Retrieve connection wrapper by ID or name with .query_df() and .execute()."""
        return get_connection_wrapper(name_or_id)


class DataikiRuntimeSDK:
    """The 'dataiki' global context injected into user inference scripts."""

    def __init__(self, project_key: str):
        self.project_key = project_key
        self.vault = _VaultAccessor()

    def _resolve_model_row(
        self,
        model_name: Optional[str] = None,
        version: Optional[int] = None,
    ) -> Any:
        """Locate a model version row, optionally filtered by name."""
        with get_db() as conn:
            if version is not None:
                if model_name:
                    row = conn.execute(
                        """
                        SELECT * FROM model_versions
                        WHERE project_key = ? AND version = ?
                          AND (model_name = ? OR model_name = '' OR model_name IS NULL)
                        """,
                        (self.project_key, version, model_name),
                    ).fetchone()
                else:
                    row = conn.execute(
                        "SELECT * FROM model_versions WHERE project_key = ? AND version = ?",
                        (self.project_key, version),
                    ).fetchone()
            else:
                name_clause = ""
                params: List[Any] = [self.project_key]
                if model_name:
                    name_clause = "AND (model_name = ? OR model_name = '' OR model_name IS NULL)"
                    params.append(model_name)
                row = conn.execute(
                    f"SELECT * FROM model_versions WHERE project_key = ? {name_clause} "
                    "AND status = 'active' ORDER BY version DESC LIMIT 1",
                    params,
                ).fetchone()
                if not row:
                    row = conn.execute(
                        f"SELECT * FROM model_versions WHERE project_key = ? {name_clause} "
                        "ORDER BY version DESC LIMIT 1",
                        params,
                    ).fetchone()
        return row

    def models(self) -> List[Dict[str, Any]]:
        """List published model versions available to this project."""
        with get_db() as conn:
            rows = conn.execute(
                "SELECT * FROM model_versions WHERE project_key = ? ORDER BY version DESC",
                (self.project_key,),
            ).fetchall()
        return [
            {
                "model_name": row["model_name"] or self.project_key,
                "version": int(row["version"]),
                "status": row["status"],
                "task_type": row["task_type"],
                "algorithm": row["algorithm"],
                "target_column": row["target_column"],
            }
            for row in rows
        ]

    def get_published_model(
        self,
        version: Optional[int] = None,
        model_name: Optional[str] = None,
    ) -> PublishedModelWrapper:
        """Fetch and instantiate a PublishedModelWrapper for this project.

        Args:
            version: Specific model version integer (e.g. 1). If omitted, loads the
                     current 'active' model (or latest available version).
            model_name: Model name assigned at promotion. Omit for any model.
        """
        row = self._resolve_model_row(model_name=model_name, version=version)

        if not row:
            v_desc = f"v{version}" if version is not None else "active"
            name_desc = f" '{model_name}'" if model_name else ""
            raise KeyError(
                f"No published model version ({v_desc}){name_desc} found for project '{self.project_key}'."
            )

        artifact_path = row["artifact_path"]
        bundle = load_bundle_cached(artifact_path)
        return PublishedModelWrapper(
            bundle=bundle,
            training_sample_path=row["training_sample_path"],
            model_name=row["model_name"] or self.project_key,
        )

    def model(
        self,
        name: Optional[str] = None,
        version: Optional[int] = None,
    ) -> PublishedModelWrapper:
        """Shorthand used inside scripts: dataiki.model('churn', version=3)."""
        return self.get_published_model(version=version, model_name=name)

    def predict_frame(
        self,
        df: pl.DataFrame,
        model_name: Optional[str] = None,
        version: Optional[int] = None,
        include_proba: bool = True,
    ) -> pl.DataFrame:
        """Predict a whole DataFrame and append prediction/probability columns."""
        if not isinstance(df, pl.DataFrame):
            raise TypeError(
                f"predict_frame() expects a Polars DataFrame, got {type(df).__name__}."
            )
        wrapper = self.get_published_model(version=version, model_name=model_name)
        preds = wrapper.predict(df)
        pred_vals = preds if isinstance(preds, list) else [preds]
        pred_df = df.with_columns(
            pl.Series(name=f"prediction_{wrapper.target_column}", values=pred_vals)
        )
        if include_proba and hasattr(wrapper.model, "predict_proba"):
            try:
                probas = wrapper.predict_proba(df)
                if isinstance(probas, list) and len(probas) == df.height:
                    pred_df = pred_df.with_columns(
                        pl.Series(
                            name=f"probability_{wrapper.target_column}",
                            values=probas,
                        )
                    )
            except Exception:
                # Probabilities are optional metadata; never break predictions.
                pass
        return pred_df


def execute_custom_endpoint_script(
    project_key: str,
    endpoint_row: Dict[str, Any],
    payload_or_query: Dict[str, Any],
) -> Any:
    """Execute a user-defined production endpoint script in a controlled sandbox.

    Args:
        project_key: Project identifier.
        endpoint_row: Endpoint row dictionary from custom_endpoints table.
        payload_or_query: Request parameters or JSON body.

    Returns:
        The return value of handler_function.
    """
    script_text = endpoint_row.get("inference_script", "")
    handler_name = endpoint_row.get("handler_function", "predict")

    sdk_instance = DataikiRuntimeSDK(project_key)

    handler_fn = load_sandboxed_function(
        script_text,
        handler_name,
        extra_globals={"dataiki": sdk_instance},
    )

    # Pass payload_or_query if handler accepts argument
    sig = inspect.signature(handler_fn)
    if len(sig.parameters) > 0:
        return handler_fn(payload_or_query)
    else:
        return handler_fn()

