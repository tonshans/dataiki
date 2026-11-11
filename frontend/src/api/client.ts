import type {
  ColumnDeepAnalysisResponse,
  ConnectionItem,
  CustomEndpointConfig,
  EdgeConfig,
  JanitorScanResult,
  MLSessionItem,
  NodeConfig,
  PipelineDAG,
  PredictionType,
  PreprocessingConfig,
  ProductionJobItem,
  ProjectItem,
  PublishedModelItem,
  RecipeActionType,
  RecipeStep,
  ScheduleConfig,
  ScreeningRequest,
  SmtpAlertConfig,
  SqlSnippetItem,
  TabularPreviewData,
  TuningRequest,
  UINodeKind,
} from '../types/dataiki';
import { parseProjectKey } from '../utils/projectDelimiter';

const API_BASE = '/api';

export class DataikiApiError extends Error {
  status: number;
  detail: unknown;

  constructor(message: string, status: number, detail: unknown = null) {
    super(message);
    this.name = 'DataikiApiError';
    this.status = status;
    this.detail = detail;
  }
}

function errorMessage(status: number, payload: any): string {
  const detail = payload?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item: any) => `${(item?.loc ?? []).join('.')}: ${item?.msg ?? 'validation error'}`)
      .join('; ');
  }
  if (detail && typeof detail === 'object') return JSON.stringify(detail);
  return `HTTP ${status}`;
}

async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
  const text = await response.text();
  let payload: any = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new DataikiApiError(errorMessage(response.status, payload), response.status, payload);
  }
  return payload as T;
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function joinPath(value: string): string {
  return value
    .split('/')
    .filter(Boolean)
    .map(segment)
    .join('/');
}

function round(value: number, digits = 2): number {
  return Number(value.toFixed(digits));
}

/* =====================================================================
   Local response/request shapes (not part of dataiki.ts contracts)
   ===================================================================== */

export interface HealthStatus {
  status: string;
  app: string;
  version: string;
}

export interface ProjectDetail {
  project: ProjectItem;
  dag: PipelineDAG | null;
}

export interface UploadFileItem {
  file_name: string;
  file_path: string;
  file_size_bytes: number;
  file_size_mb: number;
  modified_at?: string;
  file_extension?: string;
}

export interface UploadedFileResult {
  file_name: string;
  file_path: string;
  file_size_bytes: number;
  file_size_mb: number;
  status: string;
}

export interface ScreeningStartResponse {
  job_id: string;
  status: string;
  high_cardinality_columns?: Array<{ column: string; unique_count: number; threshold?: number }>;
  message?: string;
}

export interface MLJobStatusResponse {
  job_id: string;
  project_key: string;
  job_type: string;
  status: string;
  progress: number;
  triggered_columns?: Array<{ column: string; unique_count: number; threshold?: number }>;
  result: Record<string, any>;
  error_message?: string;
}

export interface TuningStartResponse {
  job_id: string;
  status: string;
  message?: string;
}

export interface ApiTestResult {
  ok: boolean;
  status: number;
  statusText: string;
  duration_ms: number;
  data: unknown;
}

export interface JobRunResult {
  batch_job_id: string;
  status: string;
  rows_processed: number;
  sink_destination: string;
  executed_at: string;
}

export interface JanitorPurgeResult {
  purged_files_count: number;
  purged_bytes: number;
  purged_mb: number;
  post_purge_scan: JanitorScanResult;
}

export type SplitBranch = 'a' | 'b';

/* =====================================================================
   Adapters — backend/schemas.py compatibility
   ===================================================================== */

export function encodeModelId(projectKey: string, version: number): string {
  return `${projectKey}::v${version}`;
}

export function parseModelId(modelId: string): { projectKey: string; version: number } | null {
  const match = modelId.match(/^(.*)::v(\d+)$/);
  if (!match) return null;
  return { projectKey: match[1], version: Number(match[2]) };
}

const BACKEND_ACTION_MAP: Record<Exclude<RecipeActionType, 'split_extract_text' | 'augment_rows'>, string> = {
  drop_column: 'drop_column',
  rename_column: 'rename_column',
  change_dtype: 'cast_dtype',
  fill_na: 'fill_na',
  filter_row: 'filter_row',
  formula_column: 'add_column_formula',
  string_clean: 'string_clean',
  find_replace: 'find_replace',
  binning: 'binning',
  clip_outliers: 'clip_outliers',
  datetime_extract: 'datetime_extract',
  auto_generate_features: 'auto_features',
};

const FRONTEND_ACTION_MAP: Record<string, RecipeActionType> = {
  drop_column: 'drop_column',
  rename_column: 'rename_column',
  cast_dtype: 'change_dtype',
  fill_na: 'fill_na',
  filter_row: 'filter_row',
  add_column_formula: 'formula_column',
  split_text: 'split_extract_text',
  regex_extract: 'split_extract_text',
  string_clean: 'string_clean',
  find_replace: 'find_replace',
  binning: 'binning',
  clip_outliers: 'clip_outliers',
  datetime_extract: 'datetime_extract',
  auto_features: 'auto_generate_features',
  row_augment_smote: 'augment_rows',
  row_augment_jitter: 'augment_rows',
};

function backendOpForStep(step: RecipeStep): string {
  if (step.action === 'augment_rows') {
    const method = String(step.params?.method ?? step.params?.augmentation ?? 'smote').toLowerCase();
    return method === 'jitter' ? 'row_augment_jitter' : 'row_augment_smote';
  }
  if (step.action === 'split_extract_text') {
    return step.params?.pattern ? 'regex_extract' : 'split_text';
  }
  return BACKEND_ACTION_MAP[step.action];
}

export function toBackendRecipeSteps(steps: RecipeStep[]): Array<Record<string, any>> {
  return steps.map((step) => ({
    step_id: step.step_id,
    op_type: backendOpForStep(step),
    label: step.description || step.action,
    params: {
      ...step.params,
      ...(step.column && step.params?.column === undefined ? { column: step.column } : {}),
    },
    // SMOTE / Gaussian Jitter: default applies to preview & output node (is_train_only: false)
    // unless explicitly set to scope === 'train_only'
    is_train_only:
      step.action === 'augment_rows'
        ? step.params?.scope === 'train_only' ||
          (step.train_only && step.params?.scope !== 'output_and_preview')
        : Boolean(step.train_only),
  }));
}

export function fromBackendRecipeSteps(rawSteps: unknown): RecipeStep[] {
  if (!Array.isArray(rawSteps)) return [];
  const steps: RecipeStep[] = [];
  for (const raw of rawSteps as any[]) {
    if (raw?.action) {
      steps.push(raw as RecipeStep);
      continue;
    }
    const action = FRONTEND_ACTION_MAP[String(raw?.op_type)];
    const stepId = String(raw?.step_id ?? '');
    if (!action || !stepId) continue;
    const isTrainOnly = Boolean(raw?.is_train_only);
    const params = { ...(raw?.params ?? {}) };
    if (action === 'augment_rows' && !params.scope) {
      params.scope = isTrainOnly ? 'train_only' : 'output_and_preview';
    }
    steps.push({
      step_id: stepId,
      action,
      column: raw?.params?.column,
      params,
      train_only: isTrainOnly,
      description: String(raw?.label ?? action),
    });
  }
  return steps;
}

function uiKindForNode(node: NodeConfig): UINodeKind {
  const declared = node.params?.ui_node_kind as UINodeKind | undefined;
  if (declared) return declared;
  const byType: Record<NodeConfig['node_type'], UINodeKind> = {
    ingestion: 'datasource',
    join: 'joiner',
    data_recipe: 'recipe',
    py_transform: 'python_script',
    ml_studio: 'ml_studio',
  };
  return byType[node.node_type] ?? 'recipe';
}

function splitColumns(params: Record<string, any>, branch: SplitBranch): string[] {
  const key = branch === 'a' ? 'path_a_columns' : 'path_b_columns';
  const value = params?.[key] ?? params?.[branch === 'a' ? 'pathA' : 'pathB'];
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Serializes the UI DAG into the Pydantic PipelineDAG contract.
 * - `ui_node_kind: 'split_data'` is sent as `node_type: 'data_recipe'`.
 * - For a selected branch, the complement columns become `drop_column` steps.
 * - `recipe_steps` move into `params` (backend NodeConfig has no top-level field).
 */
export function toBackendDag(
  dag: PipelineDAG,
  splitBranch?: { nodeId: string; branch: SplitBranch },
): PipelineDAG {
  const nodes: NodeConfig[] = dag.nodes.map((node) => {
    const uiNodeKind = uiKindForNode(node);
    const isSplit = uiNodeKind === 'split_data';
    const steps = toBackendRecipeSteps(node.recipe_steps ?? []);

    if (isSplit && splitBranch?.nodeId === node.node_id) {
      const keep = splitColumns(node.params, splitBranch.branch);
      const all = [
        ...new Set([
          ...splitColumns(node.params, 'a'),
          ...splitColumns(node.params, 'b'),
        ]),
      ];
      const drop = all.filter((column) => !keep.includes(column));
      if (drop.length > 0) {
        steps.push({
          step_id: `split_${splitBranch.branch}_drop_${node.node_id}`,
          op_type: 'drop_column',
          label: `Split path ${splitBranch.branch.toUpperCase()}`,
          params: { columns: drop },
          is_train_only: false,
        });
      }
    }

    return {
      ...node,
      node_type: isSplit ? 'data_recipe' : node.node_type,
      recipe_steps: steps as any,
      params: { ...node.params, ui_node_kind: uiNodeKind, recipe_steps: steps },
    };
  });

  return {
    project_key: dag.project_key,
    nodes,
    edges: dag.edges.map((edge: EdgeConfig) => ({
      edge_id: edge.edge_id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
}

function fromBackendDag(raw: any): PipelineDAG {
  const nodes: NodeConfig[] = Array.isArray(raw?.nodes)
    ? raw.nodes.map((node: any) => {
      const params = node?.params ?? {};
      const uiNodeKind = (params.ui_node_kind as UINodeKind | undefined) ?? 'recipe';
      return {
        node_id: String(node?.node_id ?? ''),
        node_type: node?.node_type,
        label: String(node?.label ?? ''),
        position: { x: Number(node?.position?.x ?? 0), y: Number(node?.position?.y ?? 0) },
        params: { ...params, ui_node_kind: uiNodeKind },
        recipe_steps: fromBackendRecipeSteps(node?.recipe_steps ?? params.recipe_steps),
      } satisfies NodeConfig;
    })
    : [];

  const edges: EdgeConfig[] = Array.isArray(raw?.edges)
    ? raw.edges.map((edge: any) => ({
      edge_id: String(edge?.edge_id ?? `${edge?.source}->${edge?.target}`),
      source: String(edge?.source ?? ''),
      target: String(edge?.target ?? ''),
      sourceHandle: edge?.sourceHandle ?? null,
      targetHandle: edge?.targetHandle ?? null,
    }))
    : [];

  return { project_key: String(raw?.project_key ?? ''), nodes, edges };
}

export function parseProjectItem(raw: any): ProjectItem {
  const projectKey = String(raw?.project_key ?? raw?.name ?? '');
  const { category, displayName } = parseProjectKey(projectKey);
  return {
    project_key: projectKey,
    name: String(raw?.name ?? projectKey),
    category,
    display_name: displayName,
    description: String(raw?.description ?? ''),
    created_at: raw?.created_at,
    updated_at: raw?.updated_at,
  };
}

function adaptPreview(
  raw: any,
  nodeId: string,
  isRawView: boolean,
  steps: RecipeStep[],
): TabularPreviewData {
  const rowCount = Number(raw?.total_rows ?? raw?.row_count ?? 0);
  const headers = Array.isArray(raw?.headers)
    ? raw.headers.map((header: any) => {
      const nullCount = Number(header?.null_count ?? 0);
      return {
        column_name: String(header?.column_name ?? ''),
        dtype: String(header?.dtype ?? ''),
        fill_rate_pct: Number(header?.fill_rate_pct ?? 0),
        null_pct: header?.null_pct ?? (rowCount > 0 ? round((nullCount / rowCount) * 100) : 0),
        unique_count: Number(header?.unique_count ?? 0),
      };
    })
    : [];

  return {
    node_id: nodeId,
    row_count: rowCount,
    is_raw_view: isRawView,
    last_modified_columns: raw?.modified_columns ?? raw?.last_modified_columns ?? [],
    headers,
    rows: Array.isArray(raw?.rows) ? raw.rows : [],
    recipe_steps: steps,
  };
}

function adaptColumnAnalysis(raw: any, targetColumn?: string | null): ColumnDeepAnalysisResponse {
  const totalRows = Number(raw?.row_count ?? raw?.total_rows ?? 0);
  const nullCount = Number(raw?.null_count ?? 0);
  const zeroRatio = Number(raw?.zero_ratio_pct ?? 0);
  const central = raw?.central_tendency ?? {};
  const dispersion = raw?.dispersion ?? {};
  const outliers = raw?.outliers ?? {};
  const distribution: any[] = Array.isArray(raw?.distribution) ? raw.distribution : [];
  const correlations: Record<string, number> = raw?.correlations ?? {};

  const correlationList = Object.entries(correlations)
    .map(([column, correlation]) => ({ column, correlation: Number(correlation) }))
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  const targetCorrelation =
    targetColumn && correlations[targetColumn] !== undefined
      ? Number(correlations[targetColumn])
      : null;

  const numericFieldsPresent = dispersion.min !== undefined && dispersion.min !== null;

  return {
    column_name: String(raw?.column_name ?? ''),
    dtype: String(raw?.dtype ?? ''),
    total_rows: totalRows,
    filled_count: Math.max(totalRows - nullCount, 0),
    fill_rate_pct: Number(raw?.fill_rate_pct ?? 0),
    null_count: nullCount,
    null_pct: totalRows > 0 ? round((nullCount / totalRows) * 100) : 0,
    zero_count: Number(raw?.zero_count ?? Math.round((zeroRatio / 100) * totalRows)),
    zero_ratio_pct: zeroRatio,
    negative_count: Number(raw?.negative_count ?? 0),
    mean: central.mean ?? null,
    median: central.median ?? null,
    mode: central.mode ?? null,
    std_dev: dispersion.std ?? null,
    variance: dispersion.variance ?? null,
    min_val: numericFieldsPresent ? dispersion.min : null,
    max_val: numericFieldsPresent ? dispersion.max : null,
    q25: dispersion.q25 ?? null,
    q50: dispersion.q50 ?? null,
    q75: dispersion.q75 ?? null,
    iqr: dispersion.iqr ?? null,
    iqr_outlier_count: Number(outliers.iqr_count ?? 0),
    iqr_outlier_pct: Number(outliers.iqr_pct ?? 0),
    zscore_outlier_count: Number(outliers.zscore_count ?? 0),
    skewness: raw?.skewness ?? null,
    kurtosis: raw?.kurtosis ?? null,
    unique_count: Number(raw?.unique_count ?? 0),
    top_frequencies: distribution
      .filter((item) => item?.value !== undefined)
      .map((item) => ({ value: item.value, count: Number(item.count ?? 0), pct: item.pct })),
    histogram_bins: distribution
      .filter((item) => item?.bucket !== undefined)
      .map((item) => ({ bin_label: String(item.bucket), count: Number(item.count ?? 0) })),
    correlations: correlationList,
    target_correlation: targetCorrelation,
  };
}

function predictionTypeToTaskType(type: PredictionType): string {
  const map: Record<PredictionType, string> = {
    binary_classification: 'classification',
    multiclass_classification: 'multiclass',
    regression: 'regression',
    forecasting: 'timeseries',
  };
  return map[type];
}

function taskTypeToPredictionType(taskType: string): PredictionType {
  const map: Record<string, PredictionType> = {
    classification: 'binary_classification',
    multiclass: 'multiclass_classification',
    regression: 'regression',
    timeseries: 'forecasting',
    forecasting: 'forecasting',
  };
  return map[taskType] ?? 'binary_classification';
}

function normalizeConfusionMatrix(raw: any): number[][] | undefined {
  if (Array.isArray(raw)) return raw as number[][];
  if (raw && typeof raw === 'object' && Array.isArray(raw.matrix)) {
    return raw.matrix as number[][];
  }
  return undefined;
}

function adaptMlSession(raw: any): MLSessionItem {
  return {
    session_id: String(raw?.session_id ?? ''),
    project_key: String(raw?.project_key ?? ''),
    session_name: String(raw?.session_name ?? ''),
    source_node_id: String(raw?.source_node_id ?? ''),
    source_node_label: String(raw?.source_node_label ?? raw?.source_node_id ?? ''),
    prediction_type: taskTypeToPredictionType(String(raw?.task_type ?? 'classification')),
    target_column: String(raw?.target_column ?? ''),
    feature_columns: Array.isArray(raw?.feature_columns) ? raw.feature_columns : [],
    sample_rows_used: Number(raw?.sample_rows_used ?? raw?.sample_limit ?? 0),
    test_size: Number(raw?.test_size ?? 0.2),
    primary_metric: String(raw?.primary_metric ?? ''),
    preprocessing: (raw?.preprocessing ?? {}) as PreprocessingConfig,
    leaderboard: Array.isArray(raw?.leaderboard)
      ? raw.leaderboard.map((entry: any, index: number) => ({
        rank: Number(entry?.rank ?? index + 1),
        algorithm: String(entry?.algorithm ?? ''),
        source_node_id: String(entry?.source_node_id ?? ''),
        source_node_label: String(entry?.source_node_label ?? entry?.source_recipe_label ?? ''),
        fit_time_sec: Number(entry?.fit_time_sec ?? 0),
        latency_ms: Number(entry?.latency_ms ?? 0),
        metrics: entry?.metrics ?? {},
        confusion_matrix: normalizeConfusionMatrix(entry?.confusion_matrix),
        feature_importance: entry?.feature_importance,
        artifact_path: String(entry?.artifact_path ?? ''),
      }))
      : [],
    tuning_trials: Array.isArray(raw?.tuning_trials) ? raw.tuning_trials : [],
    optuna_insights: {
      param_importance: raw?.optuna_insights?.param_importance ?? {},
      optimization_history: raw?.optuna_insights?.optimization_history ?? [],
      baseline_vs_tuned:
        raw?.optuna_insights?.baseline_vs_tuned ?? { baseline_score: 0, tuned_score: 0, metric: '' },
      best_feature_importance: raw?.optuna_insights?.best_feature_importance,
    },
    created_at: String(raw?.created_at ?? ''),
  };
}

function adaptPublishedModel(raw: any): PublishedModelItem {
  const projectKey = String(raw?.project_key ?? '');
  const version = Number(raw?.version ?? 0);
  return {
    model_id: encodeModelId(projectKey, version),
    project_key: projectKey,
    model_name: String(raw?.model_name ?? projectKey),
    version,
    status: raw?.status === 'active' || raw?.status === 'archived' ? raw.status : 'staged',
    prediction_type: taskTypeToPredictionType(String(raw?.task_type ?? 'classification')),
    algorithm: String(raw?.algorithm ?? ''),
    target_column: String(raw?.target_column ?? ''),
    feature_columns: Array.isArray(raw?.feature_columns) ? raw.feature_columns : [],
    metrics: raw?.metrics ?? {},
    feature_importance: raw?.feature_importance,
    created_at: String(raw?.created_at ?? ''),
  };
}

function scheduleToBackend(schedule: ScheduleConfig, smtpAlert?: SmtpAlertConfig): Record<string, any> {
  const modeMap: Record<ScheduleConfig['schedule_type'], string> = {
    unscheduled: 'none',
    every_minute: 'every_minute',
    every_hour: 'every_hour',
    daily_at: 'daily_at',
    specific_date: 'specific_date',
  };
  const value =
    schedule.schedule_type === 'daily_at'
      ? schedule.daily_time
      : schedule.schedule_type === 'specific_date'
        ? schedule.run_date ?? ''
        : '';
  return {
    enabled: schedule.is_scheduled && schedule.schedule_type !== 'unscheduled',
    mode: modeMap[schedule.schedule_type],
    value,
    ...(smtpAlert ? { smtp_alert: smtpAlert } : {}),
  };
}

function scheduleFromBackend(raw: any): ScheduleConfig {
  const mode = String(raw?.mode ?? 'none');
  const typeMap: Record<string, ScheduleConfig['schedule_type']> = {
    none: 'unscheduled',
    every_minute: 'every_minute',
    every_hour: 'every_hour',
    daily_at: 'daily_at',
    specific_date: 'specific_date',
  };
  const scheduleType = typeMap[mode] ?? 'unscheduled';
  return {
    is_scheduled: Boolean(raw?.enabled) && scheduleType !== 'unscheduled',
    schedule_type: scheduleType,
    interval_val: scheduleType === 'every_minute' || scheduleType === 'every_hour' ? 1 : 0,
    daily_time: scheduleType === 'daily_at' ? String(raw?.value ?? '') : '',
    run_date: scheduleType === 'specific_date' ? String(raw?.value ?? '') : null,
    smtp_alert: raw?.smtp_alert,
  };
}

function jobToBackend(job: ProductionJobItem) {
  const parsed = parseModelId(job.model_id);
  if (!parsed) {
    throw new DataikiApiError(`Invalid model_id '${job.model_id}'. Expected '<project>::v<number>'.`, 0);
  }

  const sourceConfig: Record<string, any> = { source_type: job.source_config.source_type };
  if (job.source_config.source_type === 'db') {
    sourceConfig.conn_id = job.source_config.conn_id;
    sourceConfig.query_or_path = job.source_config.sql_query ?? '';
  } else if (job.source_config.source_type === 'file') {
    sourceConfig.file_path = job.source_config.file_path ?? '';
  } else {
    sourceConfig.url = job.source_config.api_url ?? '';
    sourceConfig.conn_id = job.source_config.conn_id;
  }

  const sink = job.sink_config;
  const sinkConfig: Record<string, any> = { sink_type: sink.sink_type };
  if (sink.sink_type === 'db') {
    sinkConfig.conn_id = sink.conn_id;
    sinkConfig.table_name = sink.table_name ?? 'batch_predictions';
    sinkConfig.mode = sink.write_mode ?? 'append';
  } else if (sink.sink_type === 'api') {
    sinkConfig.url = sink.api_url ?? '';
  } else {
    const format = sink.file_format ?? 'parquet';
    sinkConfig.format = format;
    sinkConfig.output_dir = sink.output_dir ?? 'storage/exports';
  }
  // shortcut: SMTP alert rides inside sink_config because backend ScheduleConfig drops extra keys.
  if (job.schedule_config.smtp_alert) sinkConfig.smtp_alert = job.schedule_config.smtp_alert;

  return {
    project_key: job.project_key,
    job_name: job.job_name,
    model_version: parsed.version,
    source_config: sourceConfig,
    pre_mapper_script: job.pre_mapper_script,
    post_calc_script: job.post_calc_script,
    sink_config: sinkConfig,
    schedule_config: scheduleToBackend(job.schedule_config),
  };
}

function jobFromBackend(raw: any): ProductionJobItem {
  const projectKey = String(raw?.project_key ?? '');
  const version = Number(raw?.model_version ?? 0);
  const source = raw?.source_config ?? {};
  const sink = raw?.sink_config ?? {};
  return {
    job_script_id: String(raw?.batch_job_id ?? raw?.job_script_id ?? ''),
    project_key: projectKey,
    job_name: String(raw?.job_name ?? ''),
    model_id: encodeModelId(projectKey, version),
    model_name: raw?.model_name,
    source_config: {
      source_type: source.source_type === 'db' || source.source_type === 'api' ? source.source_type : 'file',
      conn_id: source.conn_id,
      sql_query: source.query_or_path ?? source.query,
      file_path: source.file_path ?? (source.source_type === 'file' ? source.query_or_path : undefined),
      api_url: source.url ?? (source.source_type === 'api' ? source.query_or_path : undefined),
    },
    pre_mapper_script: String(raw?.pre_mapper_script ?? ''),
    post_calc_script: String(raw?.post_calc_script ?? ''),
    sink_config: {
      sink_type: sink.sink_type === 'db' || sink.sink_type === 'api' ? sink.sink_type : 'file',
      conn_id: sink.conn_id,
      table_name: sink.table_name,
      write_mode: sink.mode,
      file_format: sink.format,
      output_dir:
        sink.output_dir ??
        (sink.dest_path ? String(sink.dest_path).replace(/\/[^/]+$/, '') : undefined),
      api_url: sink.url,
    },
    schedule_config: scheduleFromBackend({ ...(raw?.schedule_config ?? {}), smtp_alert: sink.smtp_alert }),
    last_run_at: raw?.last_run_at ?? null,
    last_status: raw?.last_status ?? 'never_run',
    last_error: raw?.last_error,
    created_at: raw?.created_at,
  };
}

/* =====================================================================
   System — projects, vault, snippets, uploads, janitor
   ===================================================================== */

export function getHealth(): Promise<HealthStatus> {
  return apiRequest<HealthStatus>('/health');
}

export async function fetchProjects(): Promise<ProjectItem[]> {
  const rows = await apiRequest<any[]>('/system/projects');
  return rows.map(parseProjectItem);
}

export async function fetchProject(projectKey: string): Promise<ProjectDetail> {
  const raw = await apiRequest<any>(`/system/projects/${segment(projectKey)}`);
  let dag: PipelineDAG | null = null;
  if (raw?.dag_json) {
    try {
      dag = fromBackendDag(typeof raw.dag_json === 'string' ? JSON.parse(raw.dag_json) : raw.dag_json);
    } catch {
      dag = null;
    }
  }
  return { project: parseProjectItem(raw), dag };
}

export function saveProject(payload: {
  project_key: string;
  name: string;
  description?: string;
  dag?: PipelineDAG;
}): Promise<{ project_key: string; name: string; description: string; status: string }> {
  return apiRequest('/system/projects', {
    method: 'POST',
    body: jsonBody({
      project_key: payload.project_key,
      name: payload.name,
      description: payload.description ?? '',
      dag_json: payload.dag ? jsonBody(toBackendDag(payload.dag)) : null,
    }),
  });
}

export function deleteProject(projectKey: string): Promise<{ status: string; project_key: string }> {
  return apiRequest(`/system/projects/${segment(projectKey)}`, { method: 'DELETE' });
}

export interface ConnectionPayload {
  conn_id?: string;
  name: string;
  conn_type: ConnectionItem['conn_type'];
  connection_uri: string;
  headers?: Record<string, string>;
  is_read_only?: boolean;
}

function adaptConnection(raw: any): ConnectionItem {
  return {
    conn_id: String(raw?.conn_id ?? ''),
    name: String(raw?.name ?? ''),
    conn_type: raw?.conn_type,
    connection_uri: String(raw?.connection_uri ?? ''),
    headers_json: String(raw?.headers_json ?? JSON.stringify(raw?.headers ?? {})),
    is_read_only: raw?.is_read_only !== undefined ? Boolean(raw.is_read_only) : true,
    created_at: raw?.created_at,
  };
}

export async function fetchConnections(): Promise<ConnectionItem[]> {
  const rows = await apiRequest<any[]>('/system/connections');
  return rows.map(adaptConnection);
}

export async function createConnection(payload: ConnectionPayload): Promise<ConnectionItem> {
  return adaptConnection(
    await apiRequest('/system/connections', { method: 'POST', body: jsonBody(payload) }),
  );
}

export async function updateConnection(
  connId: string,
  payload: ConnectionPayload,
): Promise<ConnectionItem> {
  return adaptConnection(
    await apiRequest(`/system/connections/${segment(connId)}`, {
      method: 'PUT',
      body: jsonBody({ ...payload, conn_id: connId }),
    }),
  );
}

export async function patchConnectionReadOnly(
  connId: string,
  isReadOnly: boolean,
): Promise<ConnectionItem> {
  return adaptConnection(
    await apiRequest(`/system/connections/${segment(connId)}/read-only`, {
      method: 'PATCH',
      body: jsonBody({ is_read_only: isReadOnly }),
    }),
  );
}

export function deleteConnection(connId: string): Promise<{ status: string; conn_id: string }> {
  return apiRequest(`/system/connections/${segment(connId)}`, { method: 'DELETE' });
}

export function testConnection(payload: {
  conn_type: ConnectionItem['conn_type'];
  connection_uri: string;
  headers?: Record<string, string>;
}): Promise<{ ok?: boolean; status?: string; message?: string;[key: string]: any }> {
  return apiRequest('/system/connections/test', { method: 'POST', body: jsonBody(payload) });
}

export async function fetchSnippets(): Promise<SqlSnippetItem[]> {
  return apiRequest<SqlSnippetItem[]>('/system/snippets');
}

export function createSnippet(payload: {
  snippet_id?: string;
  title: string;
  sql_text: string;
}): Promise<SqlSnippetItem> {
  return apiRequest('/system/snippets', { method: 'POST', body: jsonBody(payload) });
}

export function updateSnippet(
  snippetId: string,
  payload: { title: string; sql_text: string },
): Promise<SqlSnippetItem> {
  return apiRequest(`/system/snippets/${segment(snippetId)}`, {
    method: 'PUT',
    body: jsonBody({ snippet_id: snippetId, ...payload }),
  });
}

export function deleteSnippet(snippetId: string): Promise<{ status: string; snippet_id: string }> {
  return apiRequest(`/system/snippets/${segment(snippetId)}`, { method: 'DELETE' });
}

export function fetchUploads(): Promise<UploadFileItem[]> {
  return apiRequest<UploadFileItem[]>('/system/uploads');
}

export async function uploadFile(file: File): Promise<UploadedFileResult> {
  const form = new FormData();
  form.append('file', file);
  return apiRequest<UploadedFileResult>('/system/uploads', { method: 'POST', body: form });
}

function adaptJanitorScan(raw: any): JanitorScanResult {
  const summary = (value: any) => ({
    size_mb: Number(value?.size_mb ?? 0),
    files: Array.isArray(value?.files) ? value.files : [],
  });
  return {
    orphaned_caches: summary(raw?.orphaned_caches),
    unpublished_experiments: summary(raw?.unpublished_models ?? raw?.unpublished_experiments),
    protected_production_assets: summary(raw?.protected_production_assets),
  };
}

export async function scanJanitor(): Promise<JanitorScanResult> {
  return adaptJanitorScan(await apiRequest('/system/janitor/scan'));
}

export function purgeJanitor(
  categories: Array<'orphaned_caches' | 'unpublished_experiments'>,
): Promise<JanitorPurgeResult> {
  return apiRequest('/system/janitor/purge', {
    method: 'POST',
    body: jsonBody({
      purge_orphaned_caches: categories.includes('orphaned_caches'),
      purge_unpublished_models: categories.includes('unpublished_experiments'),
    }),
  });
}

/* =====================================================================
   Lab — DAG, preview, recipe simulation, column analysis
   ===================================================================== */

export async function fetchDag(projectKey: string): Promise<PipelineDAG> {
  return fromBackendDag(await apiRequest(`/lab/dag/${segment(projectKey)}`));
}

export function saveDag(projectKey: string, dag: PipelineDAG): Promise<{ status: string; project_key: string }> {
  return apiRequest(`/lab/dag/${segment(projectKey)}`, {
    method: 'POST',
    body: jsonBody(toBackendDag(dag)),
  });
}

export async function runDag(
  projectKey: string,
  targetNodeId?: string | null,
  splitBranch?: { nodeId: string; branch: SplitBranch } | null,
): Promise<{ status: string; project_key: string; executed_nodes: Record<string, string> }> {
  if (splitBranch) {
    const dag = await fetchDag(projectKey);
    await apiRequest(`/lab/dag/${segment(projectKey)}`, {
      method: 'POST',
      body: jsonBody(toBackendDag(dag, splitBranch)),
    });
  }
  return apiRequest('/lab/pipeline/run', {
    method: 'POST',
    body: jsonBody({ project_key: projectKey, target_node_id: targetNodeId ?? null }),
  });
}

export async function fetchNodePreview(
  projectKey: string,
  nodeId: string,
  options: { viewRaw?: boolean; limit?: number; recipeSteps?: RecipeStep[] } = {},
): Promise<TabularPreviewData> {
  const recipeSteps = options.recipeSteps ?? [];
  const raw = await apiRequest<any>(`/lab/node/${segment(projectKey)}/${segment(nodeId)}/preview`, {
    method: 'POST',
    body: jsonBody({
      view_raw: options.viewRaw ?? false,
      limit: options.limit ?? 100,
      recipe_steps: toBackendRecipeSteps(recipeSteps),
    }),
  });
  return adaptPreview(raw, nodeId, options.viewRaw ?? false, recipeSteps);
}

export async function saveNodeRecipe(
  projectKey: string,
  nodeId: string,
  recipeSteps: RecipeStep[],
  limit = 100,
): Promise<TabularPreviewData> {
  return fetchNodePreview(projectKey, nodeId, { viewRaw: false, limit, recipeSteps });
}

export async function fetchColumnAnalysis(
  projectKey: string,
  nodeId: string,
  column: string,
  targetColumn?: string | null,
  viewRaw?: boolean,
): Promise<ColumnDeepAnalysisResponse> {
  const query = new URLSearchParams({ column });
  if (targetColumn) query.set('target', targetColumn);
  if (viewRaw !== undefined) query.set('view_raw', String(Boolean(viewRaw)));
  return adaptColumnAnalysis(
    await apiRequest(`/lab/node/${segment(projectKey)}/${segment(nodeId)}/column-analysis?${query}`),
    targetColumn,
  );
}

/* =====================================================================
   ML Studio — screening, tuning, polling, sessions
   ===================================================================== */

export async function startScreening(request: ScreeningRequest): Promise<ScreeningStartResponse> {
  const raw = await apiRequest<any>('/ml/screen', {
    method: 'POST',
    body: jsonBody({
      project_key: request.project_key,
      session_name: request.session_name,
      input_node_id: request.input_node_id,
      task_type: predictionTypeToTaskType(request.prediction_type),
      target_column: request.target_column,
      feature_columns: request.feature_columns,
      time_column: request.time_column ?? null,
      preprocessing: request.preprocessing,
      selected_algorithms: request.selected_algorithms,
      primary_metric: request.primary_metric,
      sample_limit: request.sample_limit ?? 0,
      test_size: request.test_size,
      cv_folds: request.cv_folds,
      use_gpu: request.use_gpu,
      high_cardinality_action: request.cardinality_resolution ?? null,
    }),
  });

  return {
    job_id: String(raw?.job_id ?? ''),
    status: String(raw?.status ?? ''),
    high_cardinality_columns: Array.isArray(raw?.high_cardinality_columns)
      ? raw.high_cardinality_columns.map((item: any) => ({
        column: String(item?.column_name ?? item?.column ?? ''),
        unique_count: Number(item?.unique_count ?? 0),
        threshold: item?.threshold,
      }))
      : undefined,
    message: raw?.message,
  };
}

export function resolveHighCardinality(
  jobId: string,
  action: 'continue' | 'drop_column' | 'stop',
): Promise<{ job_id: string; status: string; action?: string; message?: string }> {
  return apiRequest(`/ml/job/${segment(jobId)}/resolve-cardinality`, {
    method: 'POST',
    body: jsonBody({ action }),
  });
}

export async function fetchJobStatus(jobId: string): Promise<MLJobStatusResponse> {
  const raw = await apiRequest<any>(`/ml/job/${segment(jobId)}/status`);
  const triggered = raw?.pause_context?.triggered_columns;
  return {
    job_id: String(raw?.job_id ?? jobId),
    project_key: String(raw?.project_key ?? ''),
    job_type: String(raw?.job_type ?? ''),
    status: String(raw?.status ?? ''),
    progress: Number(raw?.progress ?? 0),
    triggered_columns: Array.isArray(triggered)
      ? triggered.map((item: any) => ({
        column: String(item?.column_name ?? item?.column ?? ''),
        unique_count: Number(item?.unique_count ?? 0),
        threshold: item?.threshold,
      }))
      : undefined,
    result: raw?.result ?? {},
    error_message: raw?.error_message,
  };
}

export function startTuning(request: TuningRequest): Promise<TuningStartResponse> {
  return apiRequest('/ml/tune', {
    method: 'POST',
    body: jsonBody({
      project_key: request.project_key,
      session_id: request.session_id,
      input_node_id: request.input_node_id,
      task_type: predictionTypeToTaskType(request.prediction_type),
      algorithm: request.algorithm,
      target_column: request.target_column,
      feature_columns: request.feature_columns,
      preprocessing: request.preprocessing,
      primary_metric: request.primary_metric,
      sample_limit: request.sample_limit ?? 0,
      test_size: request.test_size,
      n_trials: request.n_trials,
      cv_folds: request.cv_folds,
      use_gpu: request.use_gpu,
    }),
  });
}

export async function fetchMLSessions(projectKey: string): Promise<MLSessionItem[]> {
  const rows = await apiRequest<any[]>(`/ml/sessions/${segment(projectKey)}`);
  return rows.map(adaptMlSession);
}

export function deleteMLSession(sessionId: string): Promise<{ status: string; session_id: string }> {
  return apiRequest(`/ml/sessions/${segment(sessionId)}`, { method: 'DELETE' });
}

/* =====================================================================
   Production — model registry
   ===================================================================== */

export async function fetchPublishedModels(projectKey: string): Promise<PublishedModelItem[]> {
  const rows = await apiRequest<any[]>(`/production/models/${segment(projectKey)}`);
  return rows.map(adaptPublishedModel);
}

export function promoteModel(payload: {
  project_key: string;
  tuning_job_id: string;
  trial_number: number;
  activate_immediately?: boolean;
}): Promise<Record<string, any>> {
  return apiRequest('/production/models/promote', {
    method: 'POST',
    body: jsonBody({ activate_immediately: true, ...payload }),
  });
}

export function retrainModel(projectKey: string, version: number): Promise<Record<string, any>> {
  return apiRequest(`/production/models/${segment(projectKey)}/${version}/retrain`, { method: 'POST' });
}

export function changeModelStatus(
  projectKey: string,
  version: number,
  action: 'activate' | 'unpublish' | 'delete',
): Promise<Record<string, any>> {
  return apiRequest(`/production/models/${segment(projectKey)}/${version}/status`, {
    method: 'POST',
    body: jsonBody({ action }),
  });
}

export async function downloadStandaloneModel(projectKey: string, version: number): Promise<void> {
  const response = await fetch(`${API_BASE}/production/export/${segment(projectKey)}/${version}`);
  if (!response.ok) {
    const text = await response.text();
    throw new DataikiApiError(`Export failed (HTTP ${response.status})`, response.status, text);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${projectKey}_v${version}_standalone.zip`;
  link.click();
  URL.revokeObjectURL(url);
}

/* =====================================================================
   Production — custom REST API builder & gateway tester
   ===================================================================== */

function adaptCustomEndpoint(raw: any): CustomEndpointConfig {
  const projectKey = String(raw?.project_key ?? '');
  const version = Number(raw?.model_version ?? 0);
  return {
    endpoint_id: raw?.endpoint_id,
    project_key: projectKey,
    model_id: encodeModelId(projectKey, version),
    model_name: raw?.model_name,
    http_method: raw?.http_method === 'GET' ? 'GET' : 'POST',
    custom_path: String(raw?.custom_path ?? ''),
    function_name: String(raw?.handler_function ?? raw?.function_name ?? 'handle_request'),
    api_logic_script: String(raw?.inference_script ?? raw?.api_logic_script ?? ''),
    is_enabled: Boolean(raw?.is_enabled),
    require_api_key: raw?.require_api_key,
  };
}

export async function fetchCustomEndpoints(projectKey: string): Promise<CustomEndpointConfig[]> {
  const rows = await apiRequest<any[]>(`/production/endpoints/${segment(projectKey)}`);
  return rows.map(adaptCustomEndpoint);
}

export function saveCustomEndpoint(config: CustomEndpointConfig): Promise<Record<string, any>> {
  const parsed = parseModelId(config.model_id);
  if (!parsed) {
    throw new DataikiApiError(
      `Invalid model_id '${config.model_id}'. Select an Active Model first.`,
      0,
    );
  }
  const payload = {
    project_key: config.project_key,
    http_method: config.http_method,
    custom_path: config.custom_path,
    handler_function: config.function_name,
    inference_script: config.api_logic_script,
    model_version: parsed.version,
    is_enabled: config.is_enabled,
  };
  if (config.endpoint_id) {
    return apiRequest(`/production/endpoints/${segment(config.endpoint_id)}`, {
      method: 'PUT',
      body: jsonBody(payload),
    });
  }
  return apiRequest('/production/endpoints', { method: 'POST', body: jsonBody(payload) });
}

export function deleteCustomEndpoint(endpointId: string): Promise<{ status: string; endpoint_id: string }> {
  return apiRequest(`/production/endpoints/${segment(endpointId)}`, { method: 'DELETE' });
}

export async function testCustomEndpoint(options: {
  projectKey: string;
  httpMethod: 'GET' | 'POST';
  customPath: string;
  payload?: unknown;
  apiKey?: string;
}): Promise<ApiTestResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.apiKey) {
    headers['x-api-key'] = options.apiKey;
    headers.Authorization = `Bearer ${options.apiKey}`;
  }

  const started = performance.now();
  const response = await fetch(
    `${API_BASE}/v1/${segment(options.projectKey)}/${joinPath(options.customPath)}`,
    {
      method: options.httpMethod,
      headers,
      body: options.httpMethod === 'POST' ? jsonBody(options.payload ?? {}) : undefined,
    },
  );
  const duration = performance.now() - started;
  const text = await response.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    duration_ms: round(duration, 1),
    data,
  };
}

/* =====================================================================
   Production — batch jobs, scheduler, execution logs
   ===================================================================== */

export async function fetchProductionJobs(projectKey: string): Promise<ProductionJobItem[]> {
  const rows = await apiRequest<any[]>(`/production/jobs/${segment(projectKey)}`);
  return rows.map(jobFromBackend);
}

export async function fetchProductionJob(jobId: string): Promise<ProductionJobItem> {
  return jobFromBackend(await apiRequest(`/production/jobs/detail/${segment(jobId)}`));
}

/**
 * Persist a batch job. New jobs are created with POST; existing jobs are
 * updated in full (source, model, scripts, sink, schedule) via PUT.
 */
export async function saveProductionJob(job: ProductionJobItem): Promise<ProductionJobItem> {
  const payload = jobToBackend(job);
  if (job.job_script_id) {
    await apiRequest<any>(`/production/jobs/${segment(job.job_script_id)}`, {
      method: 'PUT',
      body: jsonBody(payload),
    });
    return {
      ...job,
      schedule_config: scheduleFromBackend({
        ...payload.schedule_config,
        smtp_alert: payload.sink_config.smtp_alert,
      }),
    };
  }

  const created = await apiRequest<{ batch_job_id: string; job_name: string; status: string }>(
    '/production/jobs',
    { method: 'POST', body: jsonBody(payload) },
  );
  return { ...job, job_script_id: created.batch_job_id };
}

export function deleteProductionJob(jobId: string): Promise<{ status: string; batch_job_id: string }> {
  return apiRequest(`/production/jobs/${segment(jobId)}`, { method: 'DELETE' });
}

export function runProductionJobNow(jobId: string): Promise<JobRunResult> {
  return apiRequest(`/production/jobs/${segment(jobId)}/run`, { method: 'POST' });
}

export function updateJobSchedule(
  jobId: string,
  schedule: ScheduleConfig,
): Promise<{ batch_job_id: string; schedule: Record<string, any>; status: string }> {
  return apiRequest(`/production/jobs/${segment(jobId)}/schedule`, {
    method: 'PUT',
    body: jsonBody(scheduleToBackend(schedule, schedule.smtp_alert)),
  });
}

