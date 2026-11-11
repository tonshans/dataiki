"""Dataiki Pydantic v2 data contracts and schemas."""

from typing import Any, Dict, List, Literal, Optional, Union
from pydantic import BaseModel, Field

# =====================================================================
# 1. DAG & Recipe Contracts
# =====================================================================

RecipeOperationType = Literal[
    "drop_column",
    "rename_column",
    "cast_dtype",
    "fill_na",
    "filter_row",
    "add_column_formula",
    "split_text",
    "regex_extract",
    "string_clean",
    "find_replace",
    "binning",
    "clip_outliers",
    "datetime_extract",
    "auto_features",
    "row_augment_smote",
    "row_augment_jitter",
]


class RecipeStep(BaseModel):
    """Specification for a single data manipulation step in a recipe."""

    step_id: str
    op_type: RecipeOperationType
    label: str
    params: Dict[str, Any] = Field(default_factory=dict)
    is_train_only: bool = False  # True strictly for SMOTE and Gaussian Jitter


class NodeConfig(BaseModel):
    """Configuration for a single DAG canvas node."""

    node_id: str
    node_type: Literal["ingestion", "join", "data_recipe", "py_transform", "ml_studio"]
    label: str
    position: Dict[str, float] = Field(default_factory=lambda: {"x": 0.0, "y": 0.0})
    params: Dict[str, Any] = Field(default_factory=dict)
    recipe_steps: List[RecipeStep] = Field(default_factory=list)


class EdgeConfig(BaseModel):
    """Configuration for a connection between two DAG nodes."""

    edge_id: str
    source: str
    target: str


class PipelineDAG(BaseModel):
    """Serialized representation of a project's visual DAG."""

    project_key: str
    nodes: List[NodeConfig] = Field(default_factory=list)
    edges: List[EdgeConfig] = Field(default_factory=list)


class PreviewRequest(BaseModel):
    """Payload for interactive tabular data preview execution."""

    view_raw: bool = False
    limit: int = 100
    recipe_steps: List[RecipeStep] = Field(default_factory=list)


# =====================================================================
# 2. Vault, Snippets & Project Contracts
# =====================================================================


class ProjectCreate(BaseModel):
    """Payload to create or update a project."""

    project_key: str
    name: str
    description: str = ""
    dag_json: Optional[str] = None


class ConnectionCreate(BaseModel):
    """Payload to create or update an external database connection."""

    conn_id: Optional[str] = None
    name: str
    conn_type: Literal["mssql", "oracle", "postgres", "mysql", "sqlite", "rest_api"]
    connection_uri: str
    headers: Dict[str, Any] = Field(default_factory=dict)
    is_read_only: bool = True


class ConnectionReadOnlyPatch(BaseModel):
    """Payload to toggle read-only flag for a connection."""

    is_read_only: bool


class ConnectionTestRequest(BaseModel):
    """Payload to test external database or REST API connectivity."""

    conn_type: Literal["mssql", "oracle", "postgres", "mysql", "sqlite", "rest_api"]
    connection_uri: str
    headers: Dict[str, Any] = Field(default_factory=dict)


class SnippetCreate(BaseModel):
    """Payload to save an SQL snippet to the vault."""

    snippet_id: Optional[str] = None
    title: str
    sql_text: str


# =====================================================================
# 3. Tabular Preview & Column Analysis Contracts
# =====================================================================


class ColumnHeaderSummary(BaseModel):
    """Summary metrics displayed directly in tabular column headers."""

    column_name: str
    dtype: str
    fill_rate_pct: float
    null_count: int
    unique_count: int


class TabularPreviewResponse(BaseModel):
    """Response containing sampled rows and calculated header fill-rates."""

    total_rows: int
    headers: List[ColumnHeaderSummary]
    rows: List[Dict[str, Any]]
    modified_columns: List[str] = Field(default_factory=list)


class ColumnAnalysisResponse(BaseModel):
    """Comprehensive deep statistical analysis for a single column."""

    column_name: str
    dtype: str
    row_count: int
    fill_rate_pct: float
    null_count: int
    zero_ratio_pct: float
    negative_count: int
    unique_count: int = 0
    zero_count: int = 0
    skewness: Optional[float] = None
    kurtosis: Optional[float] = None
    central_tendency: Dict[str, Optional[Union[float, str]]]  # {mean, median, mode}
    dispersion: Dict[str, Optional[float]]                    # {std, variance, min, max, iqr, q25, q50, q75}
    outliers: Dict[str, Union[float, int]]                    # {iqr_count, iqr_pct, zscore_count, zscore_pct}
    distribution: List[Dict[str, Any]]                        # Bins [{bucket, count}] or Top Frequencies [{value, count, pct}]
    correlations: Dict[str, float]                            # {other_col_name: pearson_r}


# =====================================================================
# 4. ML Studio Screening & Tuning Contracts
# =====================================================================


class PreprocessingConfig(BaseModel):
    """Configuration for automated scikit-learn ColumnTransformer."""

    numerical_imputer: Literal["mean", "median", "constant", "drop"] = "median"
    numerical_scaler: Literal["standard", "minmax", "robust", "none"] = "standard"
    categorical_imputer: Literal["mode", "constant", "drop"] = "mode"
    categorical_encoder: Literal["onehot", "ordinal", "target", "frequency"] = "onehot"
    high_cardinality_threshold: int = 50
    custom_overrides: Dict[str, Dict[str, str]] = Field(default_factory=dict)


class ScreeningRequest(BaseModel):
    """Request payload to initiate Phase 1 Multi-Algorithm Screening."""

    project_key: str
    session_name: str
    input_node_id: str
    task_type: Literal["regression", "classification", "multiclass", "timeseries"]
    target_column: str
    feature_columns: List[str]
    time_column: Optional[str] = None
    preprocessing: PreprocessingConfig = Field(default_factory=PreprocessingConfig)
    selected_algorithms: List[str]
    primary_metric: str
    sample_limit: int = 10000          # 0 indicates Full Data
    test_size: float = 0.20            # Holdout ratio (0.05 to 0.50)
    cv_folds: int = 5
    use_gpu: bool = False
    high_cardinality_action: Optional[Literal["continue", "drop_column", "stop"]] = None


class CardinalityResolutionRequest(BaseModel):
    """User decision payload when screening encounters high cardinality."""

    action: Literal["continue", "drop_column", "stop"]


class TuningRequest(BaseModel):
    """Request payload to initiate Phase 2 Optuna Deep Tuning."""

    project_key: str
    session_id: str
    input_node_id: str
    task_type: Literal["regression", "classification", "multiclass", "timeseries"]
    algorithm: str
    target_column: str
    feature_columns: List[str]
    preprocessing: PreprocessingConfig = Field(default_factory=PreprocessingConfig)
    primary_metric: str
    sample_limit: int = 0              # 0 indicates Full Data
    test_size: float = 0.20
    n_trials: int = 30
    cv_folds: int = 5
    use_gpu: bool = False


class PromoteModelRequest(BaseModel):
    """Request payload to freeze and promote a tuned candidate into Production."""

    project_key: str
    tuning_job_id: str
    trial_number: int
    activate_immediately: bool = True


class LeaderboardEntry(BaseModel):
    """Single row entry in the ML Studio Trophy Cabinet leaderboard."""

    rank: int
    algorithm: str
    source_node_id: str = ""
    source_recipe_label: str = ""
    metrics: Dict[str, float] = Field(default_factory=dict)
    confusion_matrix: Optional[Dict[str, Any]] = None
    fit_time_sec: float = 0.0
    latency_ms: float = 0.0


# =====================================================================
# 5. Production Gateway, Custom API & Job/Scheduler Contracts
# =====================================================================


class CustomEndpointCreate(BaseModel):
    """Configuration to publish a dynamic custom REST API endpoint."""

    project_key: str
    http_method: Literal["GET", "POST"]
    custom_path: str
    handler_function: str
    inference_script: str
    model_version: int
    is_enabled: bool = True


class ScheduleConfig(BaseModel):
    """Human-friendly schedule configuration without raw cron syntax."""

    enabled: bool = False
    mode: Literal["none", "every_minute", "every_hour", "daily_at", "specific_date"] = "none"
    value: str = ""                    # 'HH:MM' for daily_at or 'YYYY-MM-DD HH:MM' for specific_date


class BatchJobCreate(BaseModel):
    """Configuration to define a 5-carriage automated batch prediction job."""

    project_key: str
    job_name: str
    model_version: int
    source_config: Dict[str, Any]      # {source_type: 'db'|'file'|'api', conn_id, query_or_path}
    pre_mapper_script: str = ""
    post_calc_script: str = ""
    sink_config: Dict[str, Any]        # {sink_type: 'db_table'|'external_api'|'local_file', ...}
    schedule_config: ScheduleConfig = Field(default_factory=ScheduleConfig)


class ModelStatusActionRequest(BaseModel):
    """Action payload for activating, unpublishing, or rolling back model versions."""

    action: Literal["activate", "unpublish", "delete"]


class JanitorPurgeRequest(BaseModel):
    """Confirmation payload to garbage collect unused assets."""

    purge_orphaned_caches: bool = True
    purge_unpublished_models: bool = True

