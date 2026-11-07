// Dataiki TypeScript contracts. Keep in sync with backend/schemas.py + Frontend Adapters.

export type ThemeMode = 'brutalism' | 'minimalist' | 'midnight';
export type WorkspaceTab = 'development' | 'production';
export type ProductionNavSection = 'models' | 'api_builder' | 'job_editor' | 'scheduler' | 'api_keys';

// Backend Pydantic NodeConfig.node_type menerima 5 literal ini.
// Untuk 'Split Data Card' di kanvas UI, kita gunakan ui_node_kind: 'split_data' yang diserialisasi sebagai 'data_recipe' ke backend.
export type BackendNodeType = 'ingestion' | 'join' | 'data_recipe' | 'py_transform' | 'ml_studio';
export type UINodeKind = 'datasource' | 'recipe' | 'split_data' | 'joiner' | 'python_script' | 'ml_studio';

export type PredictionType = 'binary_classification' | 'multiclass_classification' | 'regression' | 'forecasting';

export type RecipeActionType =
  | 'drop_column'
  | 'rename_column'
  | 'change_dtype'
  | 'fill_na'
  | 'filter_row'
  | 'formula_column'
  | 'split_extract_text'
  | 'string_clean'
  | 'find_replace'
  | 'binning'
  | 'clip_outliers'
  | 'datetime_extract'
  | 'auto_generate_features'
  | 'augment_rows';

export interface RecipeStep {
  step_id: string;
  action: RecipeActionType;
  column?: string;
  params: Record<string, any>;
  train_only: boolean; // Wajib true untuk 'augment_rows' (SMOTE / Gaussian Jitter)
  description: string;
}

export interface CanvasNodeData extends Record<string, any> {
  node_id: string;
  node_type: BackendNodeType;
  ui_node_kind: UINodeKind;
  label: string;
  params: Record<string, any>;
  recipe_steps: RecipeStep[];
  is_loading?: boolean;
  error_message?: string;
  is_ghost?: boolean;
}

export interface NodeConfig {
  node_id: string;
  node_type: BackendNodeType;
  label: string;
  position: { x: number; y: number };
  params: Record<string, any>; // Menyimpan ui_node_kind, split columns, sql query, join keys, python code, dll.
  recipe_steps: RecipeStep[];
}

export interface EdgeConfig {
  edge_id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface PipelineDAG {
  project_key: string;
  nodes: NodeConfig[];
  edges: EdgeConfig[];
}

export interface ProjectItem {
  project_key: string;       // Format di backend: "category__project_name" atau "project_name"
  name: string;              // Nama gabungan atau nama asli
  category: string;          // Hasil parse split('__')[0] atau 'Uncategorized'
  display_name: string;      // Hasil parse split('__')[1]
  description: string;
  created_at?: string;
  updated_at?: string;
}

export interface ConnectionItem {
  conn_id: string;
  name: string;
  conn_type: 'mssql' | 'oracle' | 'postgres' | 'mysql' | 'sqlite' | 'rest_api';
  connection_uri: string;    // Dimasking di UI setelah disimpan
  headers_json: string;
  created_at?: string;
}

export interface VaultSecretItem {
  secret_id: string;
  key_name: string;          // Contoh: 'OPENAI_API_KEY', 'SMTP_PASSWORD'
  secret_value: string;      // Dienkripsi/dimasking di UI, diakses via dataiki_ctx.vault.get_secret(key_name)
  description?: string;
  created_at: string;
}

export interface SqlSnippetItem {
  snippet_id: string;
  title: string;
  sql_text: string;
  created_at?: string;
}

export interface ColumnHeaderSummary {
  column_name: string;
  dtype: string;
  fill_rate_pct: number;
  null_pct: number;
  unique_count: number;
}

export interface TabularPreviewData {
  node_id: string;
  row_count: number;
  is_raw_view: boolean;
  last_modified_columns: string[];
  headers: ColumnHeaderSummary[];
  rows: Record<string, any>[];
  recipe_steps: RecipeStep[];
}

export interface ColumnDeepAnalysisResponse {
  column_name: string;
  dtype: string;
  total_rows: number;
  filled_count: number;
  fill_rate_pct: number;
  null_count: number;
  null_pct: number;
  zero_count: number;
  zero_ratio_pct: number;
  negative_count: number;
  mean?: number | null;
  median?: number | null;
  mode?: any;
  std_dev?: number | null;
  variance?: number | null;
  min_val?: any;
  max_val?: any;
  q25?: number | null;
  q50?: number | null;
  q75?: number | null;
  iqr?: number | null;
  iqr_outlier_count: number;
  iqr_outlier_pct: number;
  zscore_outlier_count: number;
  skewness?: number | null;
  kurtosis?: number | null;
  unique_count: number;
  top_frequencies: Array<{ value: string | number; count: number; pct?: number }>;
  histogram_bins: Array<{ bin_label: string; count: number }>;
  correlations: Array<{ column: string; correlation: number }>;
  target_correlation?: number | null;
}

export interface PreprocessingConfig {
  numerical_imputer: 'mean' | 'median' | 'constant' | 'drop';
  numerical_scaler: 'standard' | 'minmax' | 'robust' | 'none';
  categorical_imputer: 'mode' | 'constant' | 'drop';
  categorical_encoder: 'onehot' | 'ordinal' | 'target' | 'frequency';
  high_cardinality_threshold: number;
  custom_overrides: Record<string, Record<string, string>>;
}

export interface ScreeningRequest {
  project_key: string;
  session_name: string;
  input_node_id: string;
  prediction_type: PredictionType;
  target_column: string;
  feature_columns: string[];
  time_column?: string | null;
  preprocessing: PreprocessingConfig;
  selected_algorithms: string[];
  primary_metric: string;
  sample_limit?: number | null;
  test_size: number;
  cv_folds: number;
  use_gpu: boolean;
  cardinality_resolution?: 'continue' | 'drop_column' | null;
}

export interface TuningRequest {
  project_key: string;
  session_id: string;
  input_node_id: string;
  prediction_type: PredictionType;
  algorithm: string;
  target_column: string;
  feature_columns: string[];
  preprocessing: PreprocessingConfig;
  primary_metric: string;
  n_trials: number;
  sample_limit?: number | null;
  test_size: number;
  cv_folds: number;
  use_gpu: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  algorithm: string;
  source_node_id: string;
  source_node_label: string;
  fit_time_sec: number;
  latency_ms: number;
  metrics: Record<string, number>;
  confusion_matrix?: number[][];
  feature_importance?: Record<string, number>;
  artifact_path: string;
}

export interface TuningTrialEntry {
  trial_number: number;
  params: Record<string, any>;
  metrics: Record<string, number>;
  duration_sec: number;
  feature_importance?: Record<string, number>;
  artifact_path: string;
}

export interface OptunaInsights {
  param_importance: Record<string, number>;
  optimization_history: Array<{ trial_number: number; value: number; best_value: number }>;
  baseline_vs_tuned: { baseline_score: number; tuned_score: number; metric: string };
  best_feature_importance?: Record<string, number>;
}

export interface MLSessionItem {
  session_id: string;
  project_key: string;
  session_name: string;
  source_node_id: string;
  source_node_label: string;
  prediction_type: PredictionType;
  target_column: string;
  feature_columns: string[];
  sample_rows_used: number;
  test_size: number;
  primary_metric: string;
  preprocessing: PreprocessingConfig;
  leaderboard: LeaderboardEntry[];
  tuning_trials: TuningTrialEntry[];
  optuna_insights: OptunaInsights;
  created_at: string;
}

export interface PublishedModelItem {
  model_id: string;
  project_key: string;
  model_name: string;
  version: number;
  status: 'active' | 'staged' | 'archived';
  prediction_type: PredictionType;
  algorithm: string;
  target_column: string;
  feature_columns: string[];
  metrics: Record<string, number>;
  feature_importance?: Record<string, number>;
  created_at: string;
}

export interface CustomEndpointConfig {
  endpoint_id?: string;
  project_key: string;
  model_id: string;          // Diisi otomatis dengan model_id yang berstatus 'active' dari model_name terpilih
  model_name?: string;       // Nama model yang dipilih pengguna di UI
  http_method: 'POST' | 'GET';
  custom_path: string;
  function_name: string;
  api_logic_script: string;
  is_enabled: boolean;
  require_api_key?: boolean;
}

export interface SmtpAlertConfig {
  enabled: boolean;
  smtp_host: string;
  smtp_port: number;
  smtp_user: string;
  smtp_password_secret_key: string; // Merujuk ke Global Secrets atau string terenkripsi
  mail_to: string;
  mail_cc: string;
  subject: string;
  body_message: string;
}

export interface ScheduleConfig {
  is_scheduled: boolean;
  schedule_type: 'unscheduled' | 'every_minute' | 'every_hour' | 'daily_at' | 'specific_date';
  interval_val: number;
  daily_time: string;
  run_date?: string | null;
  smtp_alert?: SmtpAlertConfig;
}

export interface ProductionJobItem {
  job_script_id?: string;
  project_key: string;
  job_name: string;
  model_id: string;          // Otomatis mengacu ke versi 'active' dari model_name
  model_name?: string;
  source_config: {
    source_type: 'db' | 'file' | 'api';
    conn_id?: string;
    sql_query?: string;
    file_path?: string;
    api_url?: string;
  };
  pre_mapper_script: string;
  post_calc_script: string;
  sink_config: {
    sink_type: 'db' | 'api' | 'file';
    conn_id?: string;
    table_name?: string;
    write_mode?: 'append' | 'replace' | 'upsert';
    file_format?: 'xlsx' | 'csv' | 'parquet';
    output_dir?: string;
    api_url?: string;
  };
  schedule_config: ScheduleConfig;
  last_run_at?: string | null;
  last_status?: 'never_run' | 'running' | 'completed' | 'warning' | 'failed';
  last_error?: string;
  created_at?: string;
}

export interface JobExecutionLogEntry {
  log_id: string;
  job_script_id: string;
  schedule_name: string;
  status: 'running' | 'success' | 'warning' | 'error';
  started_at: string;        // ISO string timestamp
  finished_at?: string;
  stdout_text: string;       // Menyimpan output print() dari script
  error_detail?: string;     // Menyimpan pesan error / traceback jika gagal
}

export interface ApiKeyItem {
  key_id: string;
  label: string;
  token: string;             // Format: dki_live_xxxxxxxxxxxxxxxx
  created_at: string;
  is_active: boolean;
}

export interface JanitorScanResult {
  orphaned_caches: { size_mb: number; files: string[] };
  unpublished_experiments: { size_mb: number; files: string[] };
  protected_production_assets: { size_mb: number; files: string[] };
}
