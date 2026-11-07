import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  BrainCircuit,
  CheckCircle2,
  Cpu,
  Gauge,
  Info,
  LineChart,
  ListOrdered,
  Loader2,
  Package,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Settings2,
  Sparkles,
  Target,
  Timer,
  Trophy,
  X,
  Zap,
} from 'lucide-react';
import * as api from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type {
  ColumnDeepAnalysisResponse,
  ColumnHeaderSummary,
  LeaderboardEntry,
  MLSessionItem,
  PipelineDAG,
  PredictionType,
  PreprocessingConfig,
  ScreeningRequest,
  TuningRequest,
} from '../../types/dataiki';
import { FeatureImportanceModal } from './FeatureImportanceModal';
import { HighCardinalityModal } from './HighCardinalityModal';

type StudioTab = 1 | 2 | 3;
type SortDirection = 'asc' | 'desc';

interface SortState {
  key: string;
  direction: SortDirection;
}

interface SetupState {
  predictionType: PredictionType;
  targetColumn: string;
  timeColumn: string;
  featureColumns: string[];
  sampleLimit: number;
  testSize: number;
  cvFolds: number;
  useGpu: boolean;
  preprocessing: PreprocessingConfig;
  selectedAlgorithms: string[];
  primaryMetric: string;
  sessionName: string;
}

interface JobState {
  id: string;
  status: string;
  progress: number;
  algorithm?: string;
}

interface TrialRow {
  trial_number: number;
  params: Record<string, any>;
  metrics: Record<string, number>;
  score: number;
  duration_sec: number;
}

interface HistoryPoint {
  trial_number: number;
  value: number;
  best_value: number;
}

interface ComparisonRow {
  metric: string;
  baseline: number;
  tuned: number;
  diff: number;
}

interface TuningResult {
  tuning_job_id: string;
  session_id: string;
  algorithm: string;
  primary_metric: string;
  best_trial_number: number;
  best_cv_score: number;
  best_params: Record<string, any>;
  tuned_metrics: Record<string, number>;
  baseline_metrics: Record<string, number>;
  best_feature_importance: Record<string, number>;
  hyperparameter_importance: Record<string, number>;
  optimization_history: HistoryPoint[];
  comparisons: ComparisonRow[];
  trials: TrialRow[];
}

const CLASSIFICATION_ALGORITHMS = [
  'LightGBM',
  'XGBoost',
  'Random Forest',
  'Extra Trees',
  'Gradient Boosting',
  'Logistic Regression',
  'Decision Tree',
  'KNN',
  'SGD Classifier',
];
const REGRESSION_ALGORITHMS = [
  'LightGBM',
  'XGBoost',
  'Random Forest',
  'Extra Trees',
  'Gradient Boosting',
  'Ridge',
  'Lasso Path',
  'ElasticNet',
  'Decision Tree',
  'KNN',
  'Linear Regression',
  'SGD Regressor',
];
const CLASSIFICATION_METRICS = [
  'roc_auc',
  'f1',
  'accuracy',
  'precision',
  'recall',
  'log_loss',
  'mcc',
  'average_precision',
];
const REGRESSION_METRICS = [
  'rmse',
  'mae',
  'mape',
  'r2',
  'pearson_r',
  'explained_variance',
  'rmsle',
];
const METRIC_LABELS: Record<string, string> = {
  roc_auc: 'ROC AUC',
  f1: 'F1',
  accuracy: 'Accuracy',
  precision: 'Precision',
  recall: 'Recall',
  log_loss: 'Log Loss',
  mcc: 'MCC',
  average_precision: 'Avg Precision',
  rmse: 'RMSE',
  mae: 'MAE',
  mape: 'MAPE',
  r2: 'R²',
  pearson_r: 'Pearson R',
  explained_variance: 'Explained Var',
  rmsle: 'RMSLE',
  fit_time_sec: 'Fit Time (s)',
  latency_ms: 'Latency (ms)',
};
const HIGHER_IS_BETTER = new Set([
  'accuracy',
  'f1',
  'precision',
  'recall',
  'roc_auc',
  'average_precision',
  'mcc',
  'explained_variance',
  'r2',
  'pearson_r',
]);
const PERCENT_METRICS = new Set([...HIGHER_IS_BETTER, 'mape']);

const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50';
const LABEL_CLASS =
  'mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const SECONDARY_BUTTON =
  'flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
const HINT_CLASS = 'text-[11px] text-[var(--text-muted)]';
const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] rounded-[var(--border-radius)]';
const TABLE_HEAD_CLASS =
  'border-b-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1.5 text-left text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const SMALL_BADGE =
  'inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] px-1.5 py-0.5 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isClassificationType(type: PredictionType): boolean {
  return type === 'binary_classification' || type === 'multiclass_classification';
}

function algorithmsFor(type: PredictionType): string[] {
  return isClassificationType(type) ? CLASSIFICATION_ALGORITHMS : REGRESSION_ALGORITHMS;
}

function metricsFor(type: PredictionType): string[] {
  return isClassificationType(type) ? CLASSIFICATION_METRICS : REGRESSION_METRICS;
}

function defaultMetricFor(type: PredictionType): string {
  return isClassificationType(type) ? 'roc_auc' : 'rmse';
}

function defaultAlgorithmsFor(type: PredictionType): string[] {
  return algorithmsFor(type).slice(0, 3);
}

function metricLabel(key: string): string {
  return (
    METRIC_LABELS[key.toLowerCase()] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function metricIsHigherBetter(key: string): boolean {
  return HIGHER_IS_BETTER.has(key.toLowerCase());
}

function formatMetricValue(key: string, value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (PERCENT_METRICS.has(key.toLowerCase())) {
    return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  }
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatScore(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds >= 60) return `${(seconds / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })}m`;
  return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 2 })}s`;
}

function formatParam(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? String(value)
      : value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function defaultSetup(nodeLabel: string): SetupState {
  return {
    predictionType: 'binary_classification',
    targetColumn: '',
    timeColumn: '',
    featureColumns: [],
    sampleLimit: 10000,
    testSize: 0.2,
    cvFolds: 5,
    useGpu: false,
    preprocessing: {
      numerical_imputer: 'median',
      numerical_scaler: 'standard',
      categorical_imputer: 'mode',
      categorical_encoder: 'onehot',
      high_cardinality_threshold: 50,
      custom_overrides: {},
    },
    selectedAlgorithms: defaultAlgorithmsFor('binary_classification'),
    primaryMetric: 'roc_auc',
    sessionName: `${nodeLabel} screening`,
  };
}

function readSetup(raw: Record<string, any> | undefined, nodeLabel: string): SetupState {
  const base = defaultSetup(nodeLabel);
  if (!raw) return base;
  const stored = raw.ml_studio;
  if (!stored || typeof stored !== 'object') return base;
  return {
    ...base,
    ...stored,
    preprocessing: { ...base.preprocessing, ...(stored.preprocessing ?? {}) },
    featureColumns: Array.isArray(stored.featureColumns) ? stored.featureColumns : base.featureColumns,
    selectedAlgorithms: Array.isArray(stored.selectedAlgorithms)
      ? stored.selectedAlgorithms
      : base.selectedAlgorithms,
  };
}

function normalizeConfusionMatrix(raw: unknown): number[][] | undefined {
  if (Array.isArray(raw)) return raw as number[][];
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).matrix)) {
    return (raw as any).matrix as number[][];
  }
  return undefined;
}

function normalizeLeaderboard(raw: unknown): LeaderboardEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry: any, index: number) => ({
    rank: Number(entry?.rank ?? index + 1),
    algorithm: String(entry?.algorithm ?? ''),
    source_node_id: String(entry?.source_node_id ?? ''),
    source_node_label: String(entry?.source_node_label ?? entry?.source_recipe_label ?? ''),
    fit_time_sec: Number(entry?.fit_time_sec ?? 0),
    latency_ms: Number(entry?.latency_ms ?? 0),
    metrics:
      entry?.metrics && typeof entry.metrics === 'object'
        ? Object.fromEntries(
            Object.entries(entry.metrics).map(([key, value]) => [key, Number(value)]),
          )
        : {},
    confusion_matrix: normalizeConfusionMatrix(entry?.confusion_matrix),
    feature_importance:
      entry?.feature_importance && typeof entry.feature_importance === 'object'
        ? entry.feature_importance
        : undefined,
    artifact_path: String(entry?.artifact_path ?? ''),
  }));
}

function normalizeTrials(raw: unknown): TrialRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((trial: any, index: number) => {
    const metrics =
      trial?.metrics && typeof trial.metrics === 'object'
        ? Object.fromEntries(
            Object.entries(trial.metrics).map(([key, value]) => [key, Number(value)]),
          )
        : {};
    const score = Number(trial?.score ?? trial?.value ?? 0);
    return {
      trial_number: Number(trial?.trial_number ?? index + 1),
      params: trial?.params && typeof trial.params === 'object' ? trial.params : {},
      metrics,
      score: Number.isFinite(score) ? score : 0,
      duration_sec: Number(trial?.duration_sec ?? 0),
    };
  });
}

function normalizeHistory(raw: unknown): HistoryPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((point: any, index: number) => ({
    trial_number: Number(point?.trial_number ?? index + 1),
    value: Number(point?.value ?? point?.score ?? 0),
    best_value: Number(point?.best_value ?? point?.best_so_far ?? point?.value ?? 0),
  }));
}

function normalizeComparisons(
  raw: unknown,
  baselineMetrics: Record<string, number>,
  tunedMetrics: Record<string, number>,
): ComparisonRow[] {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const direct = raw as Record<string, any>;
    if ('baseline_score' in direct && 'tuned_score' in direct) {
      const baseline = Number(direct.baseline_score ?? 0);
      const tuned = Number(direct.tuned_score ?? 0);
      return [
        {
          metric: String(direct.metric ?? 'score'),
          baseline,
          tuned,
          diff: Number(direct.diff ?? tuned - baseline),
        },
      ];
    }
    const rows: ComparisonRow[] = [];
    Object.entries(direct).forEach(([metric, value]) => {
      if (value && typeof value === 'object') {
        const baseline = Number((value as any).baseline ?? 0);
        const tuned = Number((value as any).tuned ?? 0);
        rows.push({
          metric,
          baseline,
          tuned,
          diff: Number((value as any).diff ?? tuned - baseline),
        });
      }
    });
    if (rows.length > 0) return rows;
  }
  return Object.keys({ ...baselineMetrics, ...tunedMetrics }).map((metric) => {
    const baseline = Number(baselineMetrics[metric] ?? 0);
    const tuned = Number(tunedMetrics[metric] ?? 0);
    return { metric, baseline, tuned, diff: tuned - baseline };
  });
}

function parseTuningResult(raw: Record<string, any>): TuningResult {
  const tunedMetrics =
    raw?.tuned_metrics && typeof raw.tuned_metrics === 'object'
      ? (raw.tuned_metrics as Record<string, number>)
      : {};
  const baselineMetrics =
    raw?.baseline_metrics && typeof raw.baseline_metrics === 'object'
      ? (raw.baseline_metrics as Record<string, number>)
      : {};
  return {
    tuning_job_id: String(raw?.tuning_job_id ?? ''),
    session_id: String(raw?.session_id ?? ''),
    algorithm: String(raw?.algorithm ?? ''),
    primary_metric: String(raw?.primary_metric ?? ''),
    best_trial_number: Number(raw?.best_trial_number ?? 1),
    best_cv_score: Number(raw?.best_cv_score ?? 0),
    best_params:
      raw?.best_params && typeof raw.best_params === 'object' ? raw.best_params : {},
    tuned_metrics: tunedMetrics,
    baseline_metrics: baselineMetrics,
    best_feature_importance:
      raw?.best_feature_importance && typeof raw.best_feature_importance === 'object'
        ? raw.best_feature_importance
        : {},
    hyperparameter_importance:
      raw?.hyperparameter_importance && typeof raw.hyperparameter_importance === 'object'
        ? raw.hyperparameter_importance
        : {},
    optimization_history: normalizeHistory(raw?.optimization_history),
    comparisons: normalizeComparisons(raw?.baseline_vs_tuned, baselineMetrics, tunedMetrics),
    trials: normalizeTrials(raw?.trials),
  };
}

function mergeTuningResults(previous: TuningResult | null, next: TuningResult): TuningResult {
  if (!previous) return next;
  const offset = previous.trials.reduce(
    (max, trial) => Math.max(max, trial.trial_number),
    0,
  );
  const history = [
    ...previous.optimization_history,
    ...next.optimization_history.map((point) => ({
      ...point,
      trial_number: point.trial_number + offset,
    })),
  ];
  const trials = [
    ...previous.trials,
    ...next.trials.map((trial) => ({
      ...trial,
      trial_number: trial.trial_number + offset,
    })),
  ];
  const higher = metricIsHigherBetter(next.primary_metric);
  const nextBetter = higher
    ? next.best_cv_score >= previous.best_cv_score
    : next.best_cv_score <= previous.best_cv_score;
  const best = nextBetter ? next : previous;
  return {
    ...best,
    tuning_job_id: best.tuning_job_id,
    session_id: next.session_id || previous.session_id,
    algorithm: next.algorithm || previous.algorithm,
    primary_metric: next.primary_metric || previous.primary_metric,
    best_trial_number: nextBetter
      ? next.best_trial_number + offset
      : previous.best_trial_number,
    best_cv_score: best.best_cv_score,
    hyperparameter_importance:
      Object.keys(next.hyperparameter_importance).length > 0
        ? next.hyperparameter_importance
        : previous.hyperparameter_importance,
    optimization_history: history,
    trials,
    comparisons: best.comparisons,
  };
}

function sortLeaderboard(entries: LeaderboardEntry[], sort: SortState): LeaderboardEntry[] {
  const sorted = [...entries];
  sorted.sort((left, right) => {
    let leftValue: string | number | null;
    let rightValue: string | number | null;
    if (sort.key === 'rank') {
      leftValue = left.rank;
      rightValue = right.rank;
    } else if (sort.key === 'algorithm') {
      leftValue = left.algorithm;
      rightValue = right.algorithm;
    } else if (sort.key === 'fit_time_sec') {
      leftValue = left.fit_time_sec;
      rightValue = right.fit_time_sec;
    } else if (sort.key === 'latency_ms') {
      leftValue = left.latency_ms;
      rightValue = right.latency_ms;
    } else {
      leftValue = Number.isFinite(left.metrics[sort.key]) ? left.metrics[sort.key] : null;
      rightValue = Number.isFinite(right.metrics[sort.key]) ? right.metrics[sort.key] : null;
    }

    if (leftValue === null && rightValue === null) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    if (typeof leftValue === 'string' || typeof rightValue === 'string') {
      return (
        String(leftValue).localeCompare(String(rightValue)) *
        (sort.direction === 'asc' ? 1 : -1)
      );
    }
    return (leftValue - rightValue) * (sort.direction === 'asc' ? 1 : -1);
  });
  return sorted;
}

function sortTrials(trials: TrialRow[], sort: SortState): TrialRow[] {
  const sorted = [...trials];
  sorted.sort((left, right) => {
    let leftValue: string | number;
    let rightValue: string | number;
    if (sort.key === 'trial') {
      leftValue = left.trial_number;
      rightValue = right.trial_number;
    } else if (sort.key === 'score') {
      leftValue = left.score;
      rightValue = right.score;
    } else if (sort.key === 'duration') {
      leftValue = left.duration_sec;
      rightValue = right.duration_sec;
    } else {
      leftValue = JSON.stringify(left.params[sort.key] ?? '');
      rightValue = JSON.stringify(right.params[sort.key] ?? '');
    }
    if (typeof leftValue === 'string' || typeof rightValue === 'string') {
      return (
        String(leftValue).localeCompare(String(rightValue)) *
        (sort.direction === 'asc' ? 1 : -1)
      );
    }
    return (leftValue - rightValue) * (sort.direction === 'asc' ? 1 : -1);
  });
  return sorted;
}

function tuningKey(result: TuningResult): string {
  return result.tuning_job_id || result.algorithm;
}

function nextSort(current: SortState, key: string): SortState {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  const ascending = key === 'rank' || key === 'algorithm' || key === 'trial';
  return { key, direction: ascending ? 'asc' : 'desc' };
}

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className={CARD_CLASS}>
      <header className="flex items-start gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
        <span className="mt-0.5 shrink-0 text-[var(--accent-primary)]">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
            {title}
          </h3>
          {description && <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">{description}</p>}
        </div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className={LABEL_CLASS}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-[var(--text-muted)]">{hint}</span>}
    </label>
  );
}

function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className={INPUT_CLASS}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-3 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-2 text-left rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
    >
      <span className="min-w-0">
        <span className="block text-xs font-bold text-[var(--text-main)]">{label}</span>
        {description && <span className="mt-0.5 block text-[10px] text-[var(--text-muted)]">{description}</span>}
      </span>
      <span
        aria-hidden="true"
        className={`relative h-5 w-9 shrink-0 border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)] ${
          checked ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-canvas)]'
        }`}
      >
        <span
          className="absolute top-0 h-full w-1/2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] transition-all"
          style={{ left: checked ? '50%' : '0%' }}
        />
      </span>
    </button>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  align?: 'left' | 'right';
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th className={TABLE_HEAD_CLASS} style={{ textAlign: align }}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="inline-flex items-center gap-1 text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)] hover:text-[var(--text-main)]"
        style={{ justifyContent: align === 'right' ? 'flex-end' : 'flex-start' }}
      >
        {label}
        <Icon size={10} className={active ? 'text-[var(--accent-primary)]' : ''} />
      </button>
    </th>
  );
}

function BarList({
  rows,
  emptyLabel,
  formatter,
}: {
  rows: Array<{ label: string; value: number; detail?: string }>;
  emptyLabel: string;
  formatter?: (value: number) => string;
}) {
  const maxValue = Math.max(0.0001, ...rows.map((row) => Math.abs(row.value)));
  if (rows.length === 0) {
    return <p className="text-xs text-[var(--text-muted)]">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1.5">
      {rows.map((row, index) => (
        <li key={`${row.label}_${index}`} className="flex items-center gap-2">
          <span className="w-24 shrink-0 truncate font-mono text-[10px] text-[var(--text-main)]" title={row.label}>
            {row.label}
          </span>
          <span className="h-3 min-w-0 flex-1 overflow-hidden bg-[var(--bg-canvas)]">
            <span
              className={`block h-full ${row.value < 0 ? 'bg-[var(--accent-danger)]' : 'bg-[var(--accent-primary)]'}`}
              style={{ width: `${(Math.abs(row.value) / maxValue) * 100}%` }}
            />
          </span>
          <span className="w-24 shrink-0 text-right font-mono text-[10px] font-bold text-[var(--text-main)]">
            {formatter ? formatter(row.value) : formatScore(row.value)}
            {row.detail && (
              <span className="ml-1 font-normal text-[var(--text-muted)]">{row.detail}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function HistoryChart({ points }: { points: HistoryPoint[] }) {
  if (points.length === 0) {
    return <p className="text-xs text-[var(--text-muted)]">No optimization history yet.</p>;
  }
  const width = 320;
  const height = 120;
  const padding = 8;
  const values = points.flatMap((point) => [point.value, point.best_value]);
  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue || 1;
  const toX = (index: number) =>
    padding + (index / Math.max(1, points.length - 1)) * (width - padding * 2);
  const toY = (value: number) =>
    height - padding - ((value - minValue) / range) * (height - padding * 2);
  const scorePath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${toX(index)} ${toY(point.value)}`)
    .join(' ');
  const bestPath = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${toX(index)} ${toY(point.best_value)}`)
    .join(' ');

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[10px] font-bold text-[var(--text-muted)]">
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-3 bg-[var(--accent-primary)]" />
          Trial score
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-2 w-3 bg-[var(--accent-secondary)]" />
          Best so far
        </span>
        <span className="ml-auto font-mono">
          {points.length} trials · {formatScore(minValue)} → {formatScore(maxValue)}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="h-40 w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] rounded-[var(--border-radius)]"
        role="img"
        aria-label="Optimization history"
      >
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={padding}
            x2={width - padding}
            y1={padding + ratio * (height - padding * 2)}
            y2={padding + ratio * (height - padding * 2)}
            stroke="var(--border-color)"
            strokeOpacity={0.25}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path
          d={scorePath}
          fill="none"
          stroke="var(--accent-primary)"
          strokeWidth={1.5}
          strokeOpacity={0.65}
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={bestPath}
          fill="none"
          stroke="var(--accent-secondary)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
        <span>trial {points[0]?.trial_number}</span>
        <span>trial {points[points.length - 1]?.trial_number}</span>
      </div>
    </div>
  );
}

function ComparisonBars({ rows }: { rows: ComparisonRow[] }) {
  if (rows.length === 0) {
    return <p className="text-xs text-[var(--text-muted)]">No baseline comparison returned.</p>;
  }
  const visible = rows.slice(0, 8);
  const maxValue = Math.max(
    0.0001,
    ...visible.flatMap((row) => [Math.abs(row.baseline), Math.abs(row.tuned)]),
  );
  return (
    <ul className="space-y-2">
      {visible.map((row) => (
        <li key={row.metric}>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-main)]">
              {metricLabel(row.metric)}
            </span>
            <span
              className={`font-mono text-[10px] font-bold ${
                metricIsHigherBetter(row.metric)
                  ? row.diff >= 0
                    ? 'text-[var(--accent-secondary)]'
                    : 'text-[var(--accent-danger)]'
                  : row.diff <= 0
                    ? 'text-[var(--accent-secondary)]'
                    : 'text-[var(--accent-danger)]'
              }`}
            >
              {row.diff >= 0 ? '+' : ''}
              {formatMetricValue(row.metric, row.diff)}
            </span>
          </div>
          <div className="mt-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[9px] font-bold text-[var(--text-muted)]">BASELINE</span>
              <span className="h-2.5 flex-1 overflow-hidden bg-[var(--bg-canvas)]">
                <span
                  className="block h-full bg-[var(--text-muted)]"
                  style={{ width: `${(Math.abs(row.baseline) / maxValue) * 100}%` }}
                />
              </span>
              <span className="w-16 text-right font-mono text-[10px] text-[var(--text-main)]">
                {formatMetricValue(row.metric, row.baseline)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-[9px] font-bold text-[var(--accent-secondary)]">TUNED</span>
              <span className="h-2.5 flex-1 overflow-hidden bg-[var(--bg-canvas)]">
                <span
                  className="block h-full bg-[var(--accent-secondary)]"
                  style={{ width: `${(Math.abs(row.tuned) / maxValue) * 100}%` }}
                />
              </span>
              <span className="w-16 text-right font-mono text-[10px] font-bold text-[var(--text-main)]">
                {formatMetricValue(row.metric, row.tuned)}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function MLStudioModal() {
  const activeNodeId = useUIStore((state) => state.activeConfigNodeId);
  const setActiveConfigNodeId = useUIStore((state) => state.setActiveConfigNodeId);
  const addToast = useUIStore((state) => state.addToast);
  const setFeatureImportanceTarget = useUIStore((state) => state.setFeatureImportanceTarget);
  const setHighCardinalityWarning = useUIStore((state) => state.setHighCardinalityWarning);

  const node = usePipelineStore((state) =>
    state.nodes.find((item) => item.id === activeNodeId),
  );
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const upstreamId = usePipelineStore((state) => {
    const edge = state.edges.find((item) => item.target === activeNodeId);
    return edge?.source ?? null;
  });
  const sessions = usePipelineStore((state) => state.mlSessions);
  const activeSessionId = usePipelineStore((state) => state.activeSessionId);
  const setActiveSessionId = usePipelineStore((state) => state.setActiveSessionId);
  const loadMLSessions = usePipelineStore((state) => state.loadMLSessions);
  const startScreeningJob = usePipelineStore((state) => state.startScreeningJob);
  const startTuningJob = usePipelineStore((state) => state.startTuningJob);
  const promoteModelToProduction = usePipelineStore(
    (state) => state.promoteModelToProduction,
  );

  const [activeTab, setActiveTab] = useState<StudioTab>(1);
  const [setup, setSetup] = useState<SetupState>(() =>
    readSetup(node?.data.params, node?.data.label ?? 'ML Studio'),
  );
  const [columns, setColumns] = useState<ColumnHeaderSummary[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError] = useState<string | null>(null);
  const [featureQuery, setFeatureQuery] = useState('');
  const [targetAnalysis, setTargetAnalysis] = useState<ColumnDeepAnalysisResponse | null>(null);
  const [targetLoading, setTargetLoading] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);

  const [screeningJob, setScreeningJob] = useState<JobState | null>(null);
  const [pausedCardinality, setPausedCardinality] = useState<{
    jobId: string;
    offendingColumns: Array<{ column: string; unique_count: number }>;
  } | null>(null);
  const [screeningError, setScreeningError] = useState<string | null>(null);
  const [isStartingScreening, setIsStartingScreening] = useState(false);
  const [liveLeaderboard, setLiveLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [leaderboardSort, setLeaderboardSort] = useState<SortState>({
    key: 'rank',
    direction: 'asc',
  });

  const [tuningJob, setTuningJob] = useState<JobState | null>(null);
  const [tuningError, setTuningError] = useState<string | null>(null);
  const [isStartingTuning, setIsStartingTuning] = useState(false);
  const [tuningAlgorithm, setTuningAlgorithm] = useState('');
  const [tuningTrialsToRun, setTuningTrialsToRun] = useState(50);
  const [tunedModels, setTunedModels] = useState<TuningResult[]>([]);
  const [trialsSort, setTrialsSort] = useState<SortState>({ key: 'trial', direction: 'asc' });
  const [promotedVersions, setPromotedVersions] = useState<Record<string, number>>({});
  const [isPromoting, setIsPromoting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const lastScreeningStatusRef = useRef('');
  const screeningHandledRef = useRef('');
  const tuningHandledRef = useRef('');

  useEffect(() => {
    if (!node) return;
    setSetup(readSetup(node.data.params, node.data.label));
  }, [node?.id]);

  useEffect(() => {
    if (!projectKey || !upstreamId) {
      setColumns([]);
      setColumnsError(null);
      return;
    }
    let cancelled = false;
    setColumnsLoading(true);
    api
      .fetchNodePreview(projectKey, upstreamId, { limit: 5 })
      .then((preview) => {
        if (cancelled) return;
        setColumns(preview.headers);
        setColumnsError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setColumns([]);
        setColumnsError(messageOf(error));
      })
      .finally(() => {
        if (!cancelled) setColumnsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, upstreamId]);

  useEffect(() => {
    if (!projectKey) return;
    void loadMLSessions(projectKey).catch(() => undefined);
  }, [loadMLSessions, projectKey]);

  useEffect(() => {
    if (!projectKey || !upstreamId || !setup.targetColumn) {
      setTargetAnalysis(null);
      setTargetError(null);
      return;
    }
    let cancelled = false;
    setTargetLoading(true);
    api
      .fetchColumnAnalysis(projectKey, upstreamId, setup.targetColumn, setup.targetColumn)
      .then((analysis) => {
        if (cancelled) return;
        setTargetAnalysis(analysis);
        setTargetError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTargetAnalysis(null);
        setTargetError(messageOf(error));
      })
      .finally(() => {
        if (!cancelled) setTargetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectKey, setup.targetColumn, upstreamId]);

  useEffect(() => {
    const screeningActive =
      screeningJob &&
      ['running', 'queued', 'paused_high_cardinality'].includes(screeningJob.status);
    const tuningActive =
      tuningJob && ['running', 'queued', 'starting'].includes(tuningJob.status);
    if (!screeningActive && !tuningActive) return;

    let cancelled = false;
    let timer = 0;

    const tick = async () => {
      if (screeningActive && screeningJob) {
        try {
          const status = await api.fetchJobStatus(screeningJob.id);
          if (cancelled) return;
          const previousStatus = lastScreeningStatusRef.current;
          lastScreeningStatusRef.current = status.status;
          setScreeningJob((current) =>
            current && current.id === status.job_id
              ? { ...current, status: status.status, progress: status.progress }
              : current,
          );

          if (status.status === 'paused_high_cardinality') {
            const paused = {
              jobId: status.job_id,
              offendingColumns: (status.triggered_columns ?? []).map((column) => ({
                column: column.column,
                unique_count: column.unique_count,
              })),
            };
            setPausedCardinality(paused);
            if (previousStatus !== 'paused_high_cardinality') {
              setHighCardinalityWarning(paused);
            }
          } else if (status.status === 'running') {
            setPausedCardinality(null);
          } else if (status.status === 'completed') {
            if (screeningHandledRef.current !== status.job_id) {
              screeningHandledRef.current = status.job_id;
              setPausedCardinality(null);
              const activeWarning = useUIStore.getState().highCardinalityWarning;
              if (activeWarning?.jobId === status.job_id) setHighCardinalityWarning(null);
              setLiveLeaderboard(normalizeLeaderboard(status.result?.leaderboard));
              const sessionId = String(status.result?.session_id ?? '');
              if (sessionId) {
                try {
                  await loadMLSessions(projectKey);
                } catch {
                  // Session history refresh is optional; the live leaderboard still renders.
                }
                setActiveSessionId(sessionId);
              }
              setScreeningError(null);
              setActiveTab(2);
              addToast('success', 'Screening completed. Leaderboard is ready.');
            }
          } else if (status.status === 'failed') {
            if (screeningHandledRef.current !== status.job_id) {
              screeningHandledRef.current = status.job_id;
              setPausedCardinality(null);
              const detail = status.error_message ?? 'Screening failed.';
              setScreeningError(detail);
              addToast('error', detail);
            }
          }
        } catch (error) {
          if (!cancelled) {
            const detail = `Screening status poll failed: ${messageOf(error)}`;
            setScreeningError(detail);
          }
        }
      }

      if (tuningActive && tuningJob) {
        try {
          const status = await api.fetchJobStatus(tuningJob.id);
          if (cancelled) return;
          setTuningJob((current) =>
            current && current.id === status.job_id
              ? { ...current, status: status.status, progress: status.progress }
              : current,
          );

          if (status.status === 'completed') {
            if (tuningHandledRef.current !== status.job_id) {
              tuningHandledRef.current = status.job_id;
              const parsed = parseTuningResult(status.result ?? {});
              setTunedModels((current) => {
                const index = current.findIndex(
                  (item) => item.algorithm === parsed.algorithm,
                );
                if (index >= 0) {
                  const next = [...current];
                  next[index] = mergeTuningResults(next[index], parsed);
                  return next;
                }
                return [...current, parsed];
              });
              setTuningAlgorithm(parsed.algorithm || tuningJob.algorithm || tuningAlgorithm);
              setActiveTab(3);
              addToast(
                'success',
                `Optuna tuning completed for ${parsed.algorithm || tuningJob.algorithm}.`,
              );
            }
          } else if (status.status === 'failed') {
            if (tuningHandledRef.current !== status.job_id) {
              tuningHandledRef.current = status.job_id;
              const detail = status.error_message ?? 'Tuning failed.';
              setTuningError(detail);
              addToast('error', detail);
            }
          }
        } catch (error) {
          if (!cancelled) {
            setTuningError(`Tuning status poll failed: ${messageOf(error)}`);
          }
        }
      }

      if (!cancelled) {
        timer = window.setTimeout(() => void tick(), 1500);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    addToast,
    loadMLSessions,
    projectKey,
    screeningJob?.id,
    screeningJob?.status,
    setActiveSessionId,
    setActiveTab,
    setHighCardinalityWarning,
    tuningAlgorithm,
    tuningJob?.algorithm,
    tuningJob?.id,
    tuningJob?.status,
  ]);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.session_id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const tuningResult = useMemo(
    () => tunedModels.find((item) => item.algorithm === tuningAlgorithm) ?? null,
    [tunedModels, tuningAlgorithm],
  );
  const promotedVersion = tuningResult
    ? promotedVersions[tuningKey(tuningResult)] ?? null
    : null;

  useEffect(() => {
    if (tuningAlgorithm) return;
    const first = selectedSession?.leaderboard?.[0]?.algorithm;
    if (first) setTuningAlgorithm(first);
  }, [selectedSession, tuningAlgorithm]);

  const availableAlgorithms = useMemo(
    () => algorithmsFor(setup.predictionType),
    [setup.predictionType],
  );
  const availableMetrics = useMemo(
    () => metricsFor(setup.predictionType),
    [setup.predictionType],
  );
  const classification = isClassificationType(setup.predictionType);

  const featureColumns = useMemo(
    () =>
      columns
        .filter(
          (column) =>
            column.column_name !== setup.targetColumn &&
            column.column_name !== setup.timeColumn,
        )
        .filter((column) =>
          column.column_name.toLowerCase().includes(featureQuery.toLowerCase()),
        ),
    [columns, featureQuery, setup.targetColumn, setup.timeColumn],
  );

  const targetDistribution = useMemo(() => {
    if (!targetAnalysis) return [];
    if (classification) {
      return targetAnalysis.top_frequencies.map((row) => ({
        label: String(row.value),
        value: Number(row.count),
        detail:
          row.pct === undefined
            ? undefined
            : `${Number(row.pct).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`,
      }));
    }
    return targetAnalysis.histogram_bins.map((bin) => ({
      label: bin.bin_label,
      value: Number(bin.count),
    }));
  }, [classification, targetAnalysis]);

  const minorityPercent = useMemo(() => {
    if (!classification || targetDistribution.length === 0) return null;
    // The profiler returns the top 10 classes only; skip imbalance math when truncated.
    if (targetAnalysis && targetAnalysis.unique_count > targetDistribution.length) return null;
    const total = targetDistribution.reduce((sum, row) => sum + row.value, 0);
    if (total <= 0) return null;
    return (Math.min(...targetDistribution.map((row) => row.value)) / total) * 100;
  }, [classification, targetAnalysis, targetDistribution]);

  const leaderboard = selectedSession?.leaderboard?.length
    ? selectedSession.leaderboard
    : liveLeaderboard;

  const leaderboardMetrics = useMemo(() => {
    const keys = new Set<string>();
    leaderboard.forEach((entry) => {
      Object.keys(entry.metrics).forEach((key) => keys.add(key));
    });
    if (keys.size === 0) availableMetrics.forEach((key) => keys.add(key));
    return Array.from(keys);
  }, [availableMetrics, leaderboard]);

  const sortedLeaderboard = useMemo(
    () => sortLeaderboard(leaderboard, leaderboardSort),
    [leaderboard, leaderboardSort],
  );

  const sortedTrials = useMemo(
    () => sortTrials(tuningResult?.trials ?? [], trialsSort),
    [trialsSort, tuningResult?.trials],
  );

  const paramImportanceRows = useMemo(
    () =>
      Object.entries(tuningResult?.hyperparameter_importance ?? {})
        .map(([label, value]) => ({ label, value: Number(value) }))
        .filter((row) => Number.isFinite(row.value))
        .sort((left, right) => Math.abs(right.value) - Math.abs(left.value)),
    [tuningResult?.hyperparameter_importance],
  );

  const trialParamKeys = useMemo(() => {
    const keys = new Set<string>();
    (tuningResult?.trials ?? []).forEach((trial) => {
      Object.keys(trial.params).forEach((key) => keys.add(key));
    });
    return Array.from(keys);
  }, [tuningResult?.trials]);

  if (!node || node.data.ui_node_kind !== 'ml_studio') return null;

  const patchSetup = (patch: Partial<SetupState>) => {
    setSetup((current) => ({ ...current, ...patch }));
  };

  const changePredictionType = (value: PredictionType) => {
    setSetup((current) => ({
      ...current,
      predictionType: value,
      selectedAlgorithms: defaultAlgorithmsFor(value),
      primaryMetric: defaultMetricFor(value),
      timeColumn: value === 'forecasting' ? current.timeColumn : '',
    }));
  };

  const changeTargetColumn = (value: string) => {
    setSetup((current) => ({
      ...current,
      targetColumn: value,
      featureColumns: value
        ? columns
            .filter((column) => column.column_name !== value)
            .map((column) => column.column_name)
        : [],
      timeColumn: current.timeColumn === value ? '' : current.timeColumn,
    }));
  };

  const toggleFeature = (column: string) => {
    setSetup((current) => ({
      ...current,
      featureColumns: current.featureColumns.includes(column)
        ? current.featureColumns.filter((item) => item !== column)
        : [...current.featureColumns, column],
    }));
  };

  const selectAllFeatures = () => {
    setSetup((current) => ({
      ...current,
      featureColumns: columns
        .filter(
          (column) =>
            column.column_name !== current.targetColumn &&
            column.column_name !== current.timeColumn,
        )
        .map((column) => column.column_name),
    }));
  };

  const toggleAlgorithm = (algorithm: string) => {
    setSetup((current) => ({
      ...current,
      selectedAlgorithms: current.selectedAlgorithms.includes(algorithm)
        ? current.selectedAlgorithms.filter((item) => item !== algorithm)
        : [...current.selectedAlgorithms, algorithm],
    }));
  };

  const persistSetup = async () => {
    const state = usePipelineStore.getState();
    state.updateNodeConfig(node.id, {
      params: { ...node.data.params, ml_studio: setup },
    });
    const latest = usePipelineStore.getState();
    const dag: PipelineDAG = {
      project_key: projectKey,
      nodes: latest.nodes.map((item) => ({
        node_id: item.data.node_id,
        node_type: item.data.node_type,
        label: item.data.label,
        position: { x: item.position.x, y: item.position.y },
        params: { ...item.data.params },
        recipe_steps: item.data.recipe_steps ?? [],
      })),
      edges: latest.edges.map((edge) => ({
        edge_id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      })),
    };
    await api.saveDag(projectKey, dag);
  };

  const handleStartScreening = async () => {
    if (!projectKey) {
      addToast('error', 'Select a project before starting screening.');
      return;
    }
    if (!upstreamId) {
      addToast('error', 'Connect an upstream node to this ML Studio card first.');
      return;
    }
    if (!setup.targetColumn) {
      addToast('warning', 'Choose a target column first.');
      return;
    }
    if (setup.featureColumns.length === 0) {
      addToast('warning', 'Select at least one feature column.');
      return;
    }
    if (setup.selectedAlgorithms.length === 0) {
      addToast('warning', 'Select at least one algorithm.');
      return;
    }
    if (setup.predictionType === 'forecasting' && !setup.timeColumn) {
      addToast('warning', 'Choose a time column for forecasting.');
      return;
    }

    setIsStartingScreening(true);
    setScreeningError(null);
    setPausedCardinality(null);
    try {
      await persistSetup();
      await api.runDag(projectKey, node.id);

      const request: ScreeningRequest = {
        project_key: projectKey,
        session_name:
          setup.sessionName.trim() || `${node.data.label} screening ${new Date().toLocaleString()}`,
        input_node_id: upstreamId,
        prediction_type: setup.predictionType,
        target_column: setup.targetColumn,
        feature_columns: setup.featureColumns,
        time_column: setup.predictionType === 'forecasting' ? setup.timeColumn || null : null,
        preprocessing: setup.preprocessing,
        selected_algorithms: setup.selectedAlgorithms,
        primary_metric: setup.primaryMetric,
        sample_limit: setup.sampleLimit,
        test_size: setup.testSize,
        cv_folds: setup.cvFolds,
        use_gpu: setup.useGpu,
        cardinality_resolution: null,
      };
      const response = await startScreeningJob(request);
      lastScreeningStatusRef.current = '';
      screeningHandledRef.current = '';
      setScreeningJob({ id: response.job_id, status: response.status, progress: 0 });
      setLiveLeaderboard([]);

      if (
        response.status === 'paused_high_cardinality' ||
        (response.high_cardinality_columns?.length ?? 0) > 0
      ) {
        const paused = {
          jobId: response.job_id,
          offendingColumns: (response.high_cardinality_columns ?? []).map((column) => ({
            column: column.column,
            unique_count: column.unique_count,
          })),
        };
        setPausedCardinality(paused);
        setHighCardinalityWarning(paused);
        addToast('warning', 'Screening paused: resolve the high cardinality warning.');
      } else {
        addToast('info', `Screening job ${response.job_id} started.`);
      }
    } catch (error) {
      const detail = messageOf(error);
      setScreeningError(detail);
      addToast('error', `Screening start failed: ${detail}`);
    } finally {
      setIsStartingScreening(false);
    }
  };

  const beginTuning = async (
    algorithm: string,
    session: MLSessionItem | null,
    trials: number,
    append: boolean,
  ) => {
    if (!projectKey) {
      addToast('error', 'Select a project before tuning.');
      return;
    }
    if (!session) {
      addToast('warning', 'Run screening or select a session before tuning.');
      return;
    }
    if (!algorithm) {
      addToast('warning', 'Choose an algorithm to tune.');
      return;
    }
    if (!append) {
      setTunedModels((current) => current.filter((item) => item.algorithm !== algorithm));
    }
    setIsStartingTuning(true);
    setTuningError(null);
    try {
      const request: TuningRequest = {
        project_key: projectKey,
        session_id: session.session_id,
        input_node_id: session.source_node_id || upstreamId || '',
        prediction_type: session.prediction_type,
        algorithm,
        target_column: session.target_column,
        feature_columns: session.feature_columns,
        preprocessing: session.preprocessing,
        primary_metric: session.primary_metric,
        n_trials: trials,
        sample_limit: session.sample_rows_used || 0,
        test_size: session.test_size,
        cv_folds: setup.cvFolds,
        use_gpu: setup.useGpu,
      };
      const response = await startTuningJob(request);
      tuningHandledRef.current = '';
      setTuningAlgorithm(algorithm);
      setTuningJob({
        id: response.job_id,
        status: response.status,
        progress: 0,
        algorithm,
      });
      setActiveTab(3);
      addToast(
        'info',
        append
          ? `Running ${trials} more Optuna trials for ${algorithm}.`
          : `Optuna tuning started for ${algorithm} (${trials} trials).`,
      );
    } catch (error) {
      const detail = messageOf(error);
      setTuningError(detail);
      addToast('error', `Tuning start failed: ${detail}`);
    } finally {
      setIsStartingTuning(false);
    }
  };

  const openEntryImportance = (entry: LeaderboardEntry) => {
    setFeatureImportanceTarget({
      title: `${entry.algorithm} · ${
        selectedSession?.session_name ?? (liveLeaderboard.length > 0 ? 'Latest screening' : 'Screening')
      }`,
      importance: entry.feature_importance ?? {},
      metrics: entry.metrics,
      confusionMatrix: entry.confusion_matrix,
    });
  };

  const openTunedImportance = () => {
    if (!tuningResult) return;
    setFeatureImportanceTarget({
      title: `${tuningResult.algorithm || tuningAlgorithm} · Tuned`,
      importance: tuningResult.best_feature_importance,
      metrics: tuningResult.tuned_metrics,
      confusionMatrix: undefined,
    });
  };

  const handleTuneRow = (entry: LeaderboardEntry) => {
    if (!selectedSession) {
      addToast('warning', 'Select a screening session before tuning an algorithm.');
      return;
    }
    void beginTuning(entry.algorithm, selectedSession, 50, false);
  };

  const handleRunMoreTrials = () => {
    if (!tuningResult) return;
    const session =
      sessions.find((item) => item.session_id === tuningResult.session_id) ??
      selectedSession;
    void beginTuning(
      tuningResult.algorithm || tuningAlgorithm,
      session,
      tuningTrialsToRun,
      true,
    );
  };

  const handlePromote = async (model: TuningResult | null = tuningResult) => {
    if (!model || !projectKey) return;
    setIsPromoting(true);
    try {
      const result = await promoteModelToProduction({
        project_key: projectKey,
        tuning_job_id: model.tuning_job_id,
        trial_number: model.best_trial_number,
        activate_immediately: true,
      });
      const version = Number(result.version ?? 0);
      if (version > 0) {
        setPromotedVersions((current) => ({ ...current, [tuningKey(model)]: version }));
      }
      addToast(
        'success',
        `${model.algorithm} promoted to Production Gateway as v${version || '?'}.`,
      );
    } catch (error) {
      addToast('error', `Promotion failed: ${messageOf(error)}`);
    } finally {
      setIsPromoting(false);
    }
  };

  const handleExport = async (model: TuningResult | null = tuningResult) => {
    if (!model || !projectKey) return;
    setIsExporting(true);
    try {
      let version = promotedVersions[tuningKey(model)] ?? 0;
      if (!version) {
        const result = await promoteModelToProduction({
          project_key: projectKey,
          tuning_job_id: model.tuning_job_id,
          trial_number: model.best_trial_number,
          activate_immediately: false,
        });
        version = Number(result.version ?? 0);
        if (version > 0) {
          setPromotedVersions((current) => ({ ...current, [tuningKey(model)]: version }));
        }
        addToast('info', `Staged registry version v${version} created for export.`);
      }
      if (!version) throw new Error('No registry version available for export.');
      await api.downloadStandaloneModel(projectKey, version);
      addToast('success', 'Standalone ZIP bundle downloaded.');
    } catch (error) {
      addToast('error', `Standalone export failed: ${messageOf(error)}`);
    } finally {
      setIsExporting(false);
    }
  };

  const screeningBusy =
    isStartingScreening ||
    (screeningJob !== null &&
      ['running', 'queued', 'paused_high_cardinality'].includes(screeningJob.status));
  const tuningBusy =
    isStartingTuning || (tuningJob !== null && ['running', 'queued'].includes(tuningJob.status));

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setActiveConfigNodeId(null);
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="ml-studio-title"
          className="relative z-[51] flex h-[min(920px,96vh)] w-[min(1320px,98vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
        >
          <header className="flex shrink-0 items-start justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
            <div className="flex min-w-0 items-start gap-2">
              <BrainCircuit size={20} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
              <div className="min-w-0">
                <h2
                  id="ml-studio-title"
                  className="truncate text-lg font-bold text-[var(--text-main)]"
                >
                  {node.data.label}
                </h2>
                <p className="truncate text-xs text-[var(--text-muted)]">
                  ML Studio · multi-algorithm screening, leaderboard, and Optuna tuning
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {screeningBusy && screeningJob && (
                <span className={SMALL_BADGE} title="Screening job status">
                  <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />
                  Screening {screeningJob.progress}%
                </span>
              )}
              {tuningBusy && tuningJob && (
                <span className={SMALL_BADGE} title="Tuning job status">
                  <Loader2 size={11} className="animate-spin text-[var(--accent-secondary)]" />
                  Tuning {tuningJob.progress}%
                </span>
              )}
              <button
                type="button"
                onClick={() => setActiveConfigNodeId(null)}
                className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
                aria-label="Close ML Studio"
                title="Close"
              >
                <X size={16} />
              </button>
            </div>
          </header>

          <nav className="flex shrink-0 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)]">
            {(
              [
                { id: 1 as StudioTab, label: 'Setup & Screening', icon: Target },
                { id: 2 as StudioTab, label: 'Leaderboard', icon: Trophy },
                { id: 3 as StudioTab, label: 'Tuning Dashboard', icon: Sparkles },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex min-w-0 flex-1 items-center justify-center gap-2 border-r-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2 text-xs font-bold transition-colors ${
                    active
                      ? 'bg-[var(--bg-card)] text-[var(--accent-primary)]'
                      : 'bg-[var(--bg-canvas)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                  }`}
                >
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] font-mono text-[10px] rounded-[var(--border-radius)] ${
                      active
                        ? 'bg-[var(--accent-primary)] text-[var(--bg-card)]'
                        : 'bg-[var(--bg-card)] text-[var(--text-muted)]'
                    }`}
                  >
                    {tab.id}
                  </span>
                  <Icon size={13} className="shrink-0" />
                  <span className="truncate">{tab.label}</span>
                </button>
              );
            })}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {activeTab === 1 && (
              <div className="space-y-3">
                {screeningError && (
                  <div
                    className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-canvas)] px-3 py-2 rounded-[var(--border-radius)]"
                    role="alert"
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
                    <p className="text-xs text-[var(--text-main)]">{screeningError}</p>
                  </div>
                )}

                {pausedCardinality && (
                  <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-warning)] bg-[var(--bg-canvas)] px-3 py-2 rounded-[var(--border-radius)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-warning)]" />
                    <div className="min-w-0 flex-1 text-xs text-[var(--text-main)]">
                      <p className="font-bold">Screening paused · high cardinality</p>
                      <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        {pausedCardinality.offendingColumns.length} column(s) exceed the one-hot
                        threshold. Resolve the decision to continue.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setHighCardinalityWarning(pausedCardinality)}
                      className={`${SECONDARY_BUTTON} shrink-0 px-2 py-1 text-[10px]`}
                    >
                      Resolve
                    </button>
                  </div>
                )}

                <div className="grid gap-3 xl:grid-cols-[minmax(0,1.15fr)_minmax(340px,0.85fr)]">
                  <div className="space-y-3">
                    <Section
                      icon={<Target size={14} />}
                      title="Task & Dataset"
                      description="Choose the prediction task, target, and session label."
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Prediction Type">
                          <Select
                            value={setup.predictionType}
                            onChange={(value) => changePredictionType(value as PredictionType)}
                            options={[
                              { value: 'binary_classification', label: 'Binary Classification' },
                              { value: 'multiclass_classification', label: 'Multiclass Classification' },
                              { value: 'regression', label: 'Regression' },
                              { value: 'forecasting', label: 'Forecasting' },
                            ]}
                          />
                        </Field>
                        <Field label="Target Column">
                          <Select
                            value={setup.targetColumn}
                            onChange={changeTargetColumn}
                            disabled={columnsLoading || columns.length === 0}
                            options={[
                              {
                                value: '',
                                label: columnsLoading ? 'Loading columns…' : 'Select target column',
                              },
                              ...columns.map((column) => ({
                                value: column.column_name,
                                label: `${column.column_name} · ${column.dtype}`,
                              })),
                            ]}
                          />
                        </Field>
                        {setup.predictionType === 'forecasting' && (
                          <Field label="Time Column">
                            <Select
                              value={setup.timeColumn}
                              onChange={(value) =>
                                setSetup((current) => ({
                                  ...current,
                                  timeColumn: value,
                                  featureColumns: current.featureColumns.filter(
                                    (column) => column !== value,
                                  ),
                                }))
                              }
                              disabled={columns.length === 0}
                              options={[
                                { value: '', label: 'Select time column' },
                                ...columns
                                  .filter((column) => column.column_name !== setup.targetColumn)
                                  .map((column) => ({
                                    value: column.column_name,
                                    label: `${column.column_name} · ${column.dtype}`,
                                  })),
                              ]}
                            />
                          </Field>
                        )}
                        <Field label="Session Name">
                          <input
                            value={setup.sessionName}
                            onChange={(event) => patchSetup({ sessionName: event.target.value })}
                            className={INPUT_CLASS}
                            placeholder="Screening session name"
                          />
                        </Field>
                      </div>

                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                            Columns
                          </p>
                          <p className="mt-0.5 font-mono text-sm font-bold text-[var(--text-main)]">
                            {columns.length.toLocaleString()}
                          </p>
                        </div>
                        <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                            Features
                          </p>
                          <p className="mt-0.5 font-mono text-sm font-bold text-[var(--text-main)]">
                            {setup.featureColumns.length.toLocaleString()}
                          </p>
                        </div>
                        <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                            Algorithms
                          </p>
                          <p className="mt-0.5 font-mono text-sm font-bold text-[var(--text-main)]">
                            {setup.selectedAlgorithms.length.toLocaleString()}
                          </p>
                        </div>
                        <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                            Task
                          </p>
                          <p className="mt-0.5 font-mono text-sm font-bold text-[var(--text-main)]">
                            {classification ? 'CLS' : 'REG'}
                          </p>
                        </div>
                      </div>

                      {columnsError && (
                        <p className="mt-2 text-[11px] text-[var(--accent-danger)]">
                          Failed to load columns: {columnsError}
                        </p>
                      )}
                      {!upstreamId && (
                        <p className="mt-2 text-[11px] text-[var(--accent-warning)]">
                          Connect an upstream node to this ML Studio card to load data.
                        </p>
                      )}
                    </Section>

                    <Section
                      icon={<Settings2 size={14} />}
                      title="Feature Checklist"
                      description="Select All Exclude Target, or choose columns manually."
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          value={featureQuery}
                          onChange={(event) => setFeatureQuery(event.target.value)}
                          className={`${INPUT_CLASS} max-w-[240px]`}
                          placeholder="Search features…"
                        />
                        <button type="button" onClick={selectAllFeatures} className={SECONDARY_BUTTON}>
                          <CheckCircle2 size={12} />
                          Select All Exclude Target
                        </button>
                        <button
                          type="button"
                          onClick={() => patchSetup({ featureColumns: [] })}
                          className={SECONDARY_BUTTON}
                        >
                          Clear
                        </button>
                        <span className={`${HINT_CLASS} ml-auto font-mono`}>
                          {setup.featureColumns.length}/{Math.max(0, columns.length - (setup.targetColumn ? 1 : 0))}
                        </span>
                      </div>

                      <div className="mt-2 max-h-56 overflow-y-auto border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] rounded-[var(--border-radius)]">
                        {columnsLoading ? (
                          <div className="flex items-center justify-center gap-2 py-6 text-xs text-[var(--text-muted)]">
                            <Loader2 size={14} className="animate-spin" />
                            Loading feature columns…
                          </div>
                        ) : featureColumns.length === 0 ? (
                          <p className="px-3 py-4 text-xs text-[var(--text-muted)]">
                            {setup.targetColumn
                              ? 'No feature columns match the current filter.'
                              : 'Select a target column to list available features.'}
                          </p>
                        ) : (
                          featureColumns.map((column) => {
                            const checked = setup.featureColumns.includes(column.column_name);
                            return (
                              <label
                                key={column.column_name}
                                className="flex cursor-pointer items-center gap-2 border-b border-[var(--border-color)] px-2 py-1 last:border-b-0 hover:bg-[var(--bg-hover)]"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleFeature(column.column_name)}
                                  className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
                                />
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--text-main)]">
                                  {column.column_name}
                                </span>
                                <span className="shrink-0 font-mono text-[9px] text-[var(--text-muted)]">
                                  {column.dtype} · {column.unique_count.toLocaleString()} uniq
                                </span>
                              </label>
                            );
                          })
                        )}
                      </div>
                    </Section>

                    <Section
                      icon={<Settings2 size={14} />}
                      title="Preprocessing Pipeline"
                      description="Imputer, scaler, and categorical encoder applied before training."
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Numerical Imputer">
                          <Select
                            value={setup.preprocessing.numerical_imputer}
                            onChange={(value) =>
                              patchSetup({
                                preprocessing: {
                                  ...setup.preprocessing,
                                  numerical_imputer: value as PreprocessingConfig['numerical_imputer'],
                                },
                              })
                            }
                            options={[
                              { value: 'mean', label: 'Mean' },
                              { value: 'median', label: 'Median' },
                              { value: 'constant', label: 'Constant' },
                              { value: 'drop', label: 'Drop rows' },
                            ]}
                          />
                        </Field>
                        <Field label="Numerical Scaler">
                          <Select
                            value={setup.preprocessing.numerical_scaler}
                            onChange={(value) =>
                              patchSetup({
                                preprocessing: {
                                  ...setup.preprocessing,
                                  numerical_scaler: value as PreprocessingConfig['numerical_scaler'],
                                },
                              })
                            }
                            options={[
                              { value: 'standard', label: 'StandardScaler' },
                              { value: 'minmax', label: 'MinMaxScaler' },
                              { value: 'robust', label: 'RobustScaler' },
                              { value: 'none', label: 'None' },
                            ]}
                          />
                        </Field>
                        <Field label="Categorical Imputer">
                          <Select
                            value={setup.preprocessing.categorical_imputer}
                            onChange={(value) =>
                              patchSetup({
                                preprocessing: {
                                  ...setup.preprocessing,
                                  categorical_imputer: value as PreprocessingConfig['categorical_imputer'],
                                },
                              })
                            }
                            options={[
                              { value: 'mode', label: 'Most frequent' },
                              { value: 'constant', label: 'Constant' },
                              { value: 'drop', label: 'Drop rows' },
                            ]}
                          />
                        </Field>
                        <Field label="Categorical Encoder">
                          <Select
                            value={setup.preprocessing.categorical_encoder}
                            onChange={(value) =>
                              patchSetup({
                                preprocessing: {
                                  ...setup.preprocessing,
                                  categorical_encoder: value as PreprocessingConfig['categorical_encoder'],
                                },
                              })
                            }
                            options={[
                              { value: 'onehot', label: 'One-Hot' },
                              { value: 'ordinal', label: 'Ordinal' },
                              { value: 'target', label: 'Target Encoding' },
                              { value: 'frequency', label: 'Frequency' },
                            ]}
                          />
                        </Field>
                        <Field
                          label="High Cardinality Threshold"
                          hint="One-Hot pauses screening when a column exceeds this unique count."
                        >
                          <input
                            type="number"
                            min={2}
                            value={setup.preprocessing.high_cardinality_threshold}
                            onChange={(event) =>
                              patchSetup({
                                preprocessing: {
                                  ...setup.preprocessing,
                                  high_cardinality_threshold: Math.max(
                                    2,
                                    Number(event.target.value) || 2,
                                  ),
                                },
                              })
                            }
                            className={INPUT_CLASS}
                          />
                        </Field>
                        <Toggle
                          checked={setup.useGpu}
                          onChange={(checked) => patchSetup({ useGpu: checked })}
                          label="GPU Acceleration"
                          description="Use CUDA for LightGBM / XGBoost when available."
                        />
                      </div>
                    </Section>

                    <Section
                      icon={<Gauge size={14} />}
                      title="Sampling & Validation"
                      description="Holdout test split and cross-validation used by screening."
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Sampling Limit">
                          <Select
                            value={String(setup.sampleLimit)}
                            onChange={(value) => patchSetup({ sampleLimit: Number(value) })}
                            options={[
                              { value: '10000', label: '10,000 rows' },
                              { value: '50000', label: '50,000 rows' },
                              { value: '0', label: 'Full Data' },
                            ]}
                          />
                        </Field>
                        <Field label="CV Folds">
                          <Select
                            value={String(setup.cvFolds)}
                            onChange={(value) => patchSetup({ cvFolds: Number(value) })}
                            options={[
                              { value: '3', label: '3 folds' },
                              { value: '5', label: '5 folds' },
                              { value: '10', label: '10 folds' },
                            ]}
                          />
                        </Field>
                        <div className="sm:col-span-2">
                          <label className={LABEL_CLASS}>
                            Holdout Test Split · {Math.round(setup.testSize * 100)}%
                          </label>
                          <input
                            type="range"
                            min={0.1}
                            max={0.4}
                            step={0.05}
                            value={setup.testSize}
                            onChange={(event) =>
                              patchSetup({ testSize: Number(event.target.value) })
                            }
                            className="w-full accent-[var(--accent-primary)]"
                          />
                          <div className="flex justify-between font-mono text-[10px] text-[var(--text-muted)]">
                            <span>10%</span>
                            <span>40%</span>
                          </div>
                        </div>
                        <Field label="Primary Metric">
                          <Select
                            value={setup.primaryMetric}
                            onChange={(value) => patchSetup({ primaryMetric: value })}
                            options={availableMetrics.map((metric) => ({
                              value: metric,
                              label: metricLabel(metric),
                            }))}
                          />
                        </Field>
                      </div>
                    </Section>

                    <Section
                      icon={<Cpu size={14} />}
                      title="Multi-Algorithm Checklist"
                      description="Every selected algorithm is trained and ranked by the primary metric."
                    >
                      <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                        {availableAlgorithms.map((algorithm) => {
                          const checked = setup.selectedAlgorithms.includes(algorithm);
                          return (
                            <label
                              key={algorithm}
                              className={`flex cursor-pointer items-center gap-2 border-[length:var(--border-width)] px-2 py-1.5 rounded-[var(--border-radius)] ${
                                checked
                                  ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)]'
                                  : 'border-[var(--border-color)] bg-[var(--bg-input)]'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleAlgorithm(algorithm)}
                                className="h-3.5 w-3.5 accent-[var(--accent-primary)]"
                              />
                              <span className="truncate text-[11px] font-bold text-[var(--text-main)]">
                                {algorithm}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </Section>
                  </div>

                  <div className="space-y-3">
                    <Section
                      icon={<BarChart3 size={14} />}
                      title="Target Distribution Preview"
                      description="Rendered automatically when the target column changes."
                    >
                      {!setup.targetColumn ? (
                        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                          <Target size={22} className="text-[var(--text-muted)]" />
                          <p className="text-xs font-bold text-[var(--text-main)]">
                            No target selected
                          </p>
                          <p className="text-[11px] text-[var(--text-muted)]">
                            Pick a target column to preview its distribution and imbalance risk.
                          </p>
                        </div>
                      ) : targetLoading ? (
                        <div className="flex items-center justify-center gap-2 py-10 text-xs text-[var(--text-muted)]">
                          <Loader2 size={14} className="animate-spin" />
                          Profiling target distribution…
                        </div>
                      ) : targetError ? (
                        <p className="text-xs text-[var(--accent-danger)]">
                          Failed to profile target: {targetError}
                        </p>
                      ) : targetDistribution.length === 0 ? (
                        <p className="text-xs text-[var(--text-muted)]">
                          No distribution values returned for this target.
                        </p>
                      ) : (
                        <div className="space-y-3">
                          <div className="grid grid-cols-3 gap-2">
                            <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                                Rows
                              </p>
                              <p className="mt-0.5 font-mono text-sm font-bold text-[var(--text-main)]">
                                {targetAnalysis?.total_rows.toLocaleString() ?? '—'}
                              </p>
                            </div>
                            <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                                Classes
                              </p>
                              <p className="mt-0.5 font-mono text-sm font-bold text-[var(--text-main)]">
                                {targetAnalysis?.unique_count.toLocaleString() ?? '—'}
                              </p>
                            </div>
                            <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                                Minority
                              </p>
                              <p
                                className={`mt-0.5 font-mono text-sm font-bold ${
                                  minorityPercent !== null && minorityPercent < 10
                                    ? 'text-[var(--accent-warning)]'
                                    : 'text-[var(--text-main)]'
                                }`}
                              >
                                {minorityPercent === null
                                  ? '—'
                                  : `${minorityPercent.toLocaleString(undefined, {
                                      maximumFractionDigits: 1,
                                    })}%`}
                              </p>
                            </div>
                          </div>

                          <BarList
                            rows={targetDistribution}
                            emptyLabel="No distribution values returned."
                            formatter={(value) => value.toLocaleString()}
                          />

                          {classification && minorityPercent !== null && minorityPercent < 10 && (
                            <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-warning)] bg-[var(--bg-canvas)] px-2.5 py-2 rounded-[var(--border-radius)]">
                              <AlertTriangle
                                size={14}
                                className="mt-0.5 shrink-0 text-[var(--accent-warning)]"
                              />
                              <p className="text-[11px] text-[var(--text-main)]">
                                <span className="font-bold">Highly imbalanced target detected</span> (&lt;10%
                                minority class). Consider adding an Augment Rows (SMOTE) step in your
                                Data Recipe.
                              </p>
                            </div>
                          )}
                        </div>
                      )}
                    </Section>

                    <Section
                      icon={<Info size={14} />}
                      title="Screening Setup Summary"
                      description="Review the job before launching."
                    >
                      <dl className="space-y-1.5 text-[11px]">
                        {[
                          ['Target', setup.targetColumn || '—'],
                          ['Features', setup.featureColumns.length.toLocaleString()],
                          ['Algorithms', setup.selectedAlgorithms.length.toLocaleString()],
                          [
                            'Holdout',
                            `${Math.round(setup.testSize * 100)}% · ${setup.cvFolds} CV folds`,
                          ],
                          [
                            'Sampling',
                            setup.sampleLimit > 0
                              ? `${setup.sampleLimit.toLocaleString()} rows`
                              : 'Full data',
                          ],
                          ['Encoder', setup.preprocessing.categorical_encoder],
                          ['Primary metric', metricLabel(setup.primaryMetric)],
                        ].map(([label, value]) => (
                          <div key={label} className="flex items-center justify-between gap-3">
                            <dt className="text-[var(--text-muted)]">{label}</dt>
                            <dd className="truncate font-mono font-bold text-[var(--text-main)]">
                              {value}
                            </dd>
                          </div>
                        ))}
                      </dl>

                      {screeningJob && (
                        <div className="mt-3 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                          <div className="flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--text-muted)]">
                            <span className="truncate">JOB {screeningJob.id}</span>
                            <span className="font-mono text-[var(--text-main)]">
                              {screeningJob.status} · {screeningJob.progress}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-2 overflow-hidden bg-[var(--bg-card)]">
                            <div
                              className="h-full bg-[var(--accent-primary)] transition-all"
                              style={{ width: `${Math.min(100, Math.max(0, screeningJob.progress))}%` }}
                            />
                          </div>
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => void handleStartScreening()}
                        disabled={
                          screeningBusy ||
                          !upstreamId ||
                          !setup.targetColumn ||
                          setup.featureColumns.length === 0 ||
                          setup.selectedAlgorithms.length === 0 ||
                          (setup.predictionType === 'forecasting' && !setup.timeColumn)
                        }
                        className={`${PRIMARY_BUTTON} mt-3 w-full py-2`}
                      >
                        {isStartingScreening ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Play size={14} />
                        )}
                        {isStartingScreening ? 'Running upstream DAG…' : 'Start Screening Job'}
                      </button>
                      <p className={`${HINT_CLASS} mt-1.5`}>
                        The upstream DAG is executed before the screening job starts.
                      </p>
                    </Section>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 2 && (
              <div className="space-y-3">
                <div className={CARD_CLASS}>
                  <div className="flex flex-wrap items-end gap-2 p-3">
                    <Field label="Session History">
                      <select
                        value={activeSessionId ?? ''}
                        onChange={(event) => setActiveSessionId(event.target.value || null)}
                        className={`${INPUT_CLASS} min-w-[280px]`}
                      >
                        <option value="">Latest live result</option>
                        {sessions.map((session) => (
                          <option key={session.session_id} value={session.session_id}>
                            {session.session_name} · {session.source_node_label || session.source_node_id} ·{' '}
                            {session.target_column}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <button
                      type="button"
                      onClick={() => void loadMLSessions(projectKey)}
                      className={SECONDARY_BUTTON}
                      title="Refresh session history"
                    >
                      <RefreshCw size={12} />
                      Refresh
                    </button>
                    {selectedSession && (
                      <div className="flex flex-wrap items-center gap-1.5 pb-1">
                        <span className={SMALL_BADGE}>{selectedSession.target_column}</span>
                        <span className={SMALL_BADGE}>
                          {metricLabel(selectedSession.primary_metric)}
                        </span>
                        <span className={SMALL_BADGE}>
                          {selectedSession.feature_columns.length} features
                        </span>
                        <span className={SMALL_BADGE}>
                          {selectedSession.sample_rows_used > 0
                            ? `${selectedSession.sample_rows_used.toLocaleString()} rows`
                            : 'Full data'}
                        </span>
                      </div>
                    )}
                  </div>
                  {screeningBusy && screeningJob && (
                    <div className="border-t-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2">
                      <div className="flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--text-muted)]">
                        <span className="inline-flex items-center gap-1">
                          <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />
                          Training algorithms in background
                        </span>
                        <span className="font-mono text-[var(--text-main)]">{screeningJob.progress}%</span>
                      </div>
                      <div className="mt-1 h-2 overflow-hidden bg-[var(--bg-canvas)]">
                        <div
                          className="h-full bg-[var(--accent-primary)] transition-all"
                          style={{ width: `${Math.min(100, Math.max(0, screeningJob.progress))}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {screeningError && (
                  <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-canvas)] px-3 py-2 rounded-[var(--border-radius)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
                    <p className="text-xs text-[var(--text-main)]">{screeningError}</p>
                  </div>
                )}

                <div className={`${CARD_CLASS} overflow-hidden`}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
                    <div className="flex items-center gap-2">
                      <Trophy size={14} className="text-[var(--accent-primary)]" />
                      <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
                        Sortable Leaderboard
                      </h3>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] font-bold text-[var(--text-muted)]">
                      <span className="font-mono">{leaderboard.length} algorithms</span>
                      <span className={SMALL_BADGE}>Click a metric header to sort</span>
                    </div>
                  </div>

                  {leaderboard.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-2 px-4 py-14 text-center">
                      <Trophy size={24} className="text-[var(--text-muted)]" />
                      <p className="text-xs font-bold text-[var(--text-main)]">
                        No screening results yet
                      </p>
                      <p className="max-w-sm text-[11px] text-[var(--text-muted)]">
                        Run a screening job from Tab 1, or select a previous session from Session
                        History.
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveTab(1)}
                        className={`${SECONDARY_BUTTON} mt-1`}
                      >
                        <Target size={12} />
                        Go to Setup
                      </button>
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[980px] border-collapse text-[11px]">
                        <thead>
                          <tr className="bg-[var(--bg-card)]">
                            <SortHeader
                              label="Rank"
                              sortKey="rank"
                              sort={leaderboardSort}
                              onSort={(key) => setLeaderboardSort(nextSort(leaderboardSort, key))}
                            />
                            <SortHeader
                              label="Algorithm"
                              sortKey="algorithm"
                              sort={leaderboardSort}
                              onSort={(key) => setLeaderboardSort(nextSort(leaderboardSort, key))}
                            />
                            <SortHeader
                              label="Fit (s)"
                              sortKey="fit_time_sec"
                              sort={leaderboardSort}
                              onSort={(key) => setLeaderboardSort(nextSort(leaderboardSort, key))}
                              align="right"
                            />
                            <SortHeader
                              label="Latency (ms)"
                              sortKey="latency_ms"
                              sort={leaderboardSort}
                              onSort={(key) => setLeaderboardSort(nextSort(leaderboardSort, key))}
                              align="right"
                            />
                            {leaderboardMetrics.map((metric) => (
                              <SortHeader
                                key={metric}
                                label={metricLabel(metric)}
                                sortKey={metric}
                                sort={leaderboardSort}
                                onSort={(key) => setLeaderboardSort(nextSort(leaderboardSort, key))}
                                align="right"
                              />
                            ))}
                            <th className={TABLE_HEAD_CLASS} style={{ textAlign: 'right' }}>
                              Actions
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedLeaderboard.map((entry) => {
                            const failed = entry.rank >= 999;
                            return (
                              <tr
                                key={`${entry.algorithm}_${entry.rank}_${entry.artifact_path}`}
                                className="border-b border-[var(--border-color)] last:border-b-0 hover:bg-[var(--bg-hover)]"
                              >
                                <td className="px-2 py-1.5">
                                  <span
                                    className={`inline-flex min-w-6 items-center justify-center border-[length:var(--border-width)] px-1 py-0.5 font-mono text-[10px] font-bold rounded-[var(--border-radius)] ${
                                      entry.rank === 1
                                        ? 'border-[var(--accent-warning)] bg-[var(--accent-warning)] text-[var(--bg-card)]'
                                        : 'border-[var(--border-color)] text-[var(--text-main)]'
                                    }`}
                                  >
                                    {failed ? '—' : entry.rank}
                                  </span>
                                </td>
                                <td className="px-2 py-1.5">
                                  <p className="truncate font-bold text-[var(--text-main)]">
                                    {entry.algorithm}
                                  </p>
                                  <p className="truncate text-[10px] text-[var(--text-muted)]">
                                    {entry.source_node_label || entry.source_node_id || 'Main Recipe'}
                                  </p>
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono text-[var(--text-main)]">
                                  {formatDuration(entry.fit_time_sec)}
                                </td>
                                <td className="px-2 py-1.5 text-right font-mono text-[var(--text-main)]">
                                  {entry.latency_ms.toLocaleString(undefined, {
                                    maximumFractionDigits: 2,
                                  })}
                                </td>
                                {leaderboardMetrics.map((metric) => {
                                  const value = entry.metrics[metric];
                                  return (
                                    <td
                                      key={metric}
                                      className="px-2 py-1.5 text-right font-mono text-[var(--text-main)]"
                                      title={Number.isFinite(value) ? String(value) : 'Not reported'}
                                    >
                                      {Number.isFinite(value)
                                        ? formatMetricValue(metric, value)
                                        : '—'}
                                    </td>
                                  );
                                })}
                                <td className="px-2 py-1.5">
                                  <div className="flex items-center justify-end gap-1">
                                    <button
                                      type="button"
                                      onClick={() => openEntryImportance(entry)}
                                      className={`${SECONDARY_BUTTON} px-2 py-1 text-[10px]`}
                                      title="Open feature importance and evaluation matrix"
                                    >
                                      <BarChart3 size={11} />
                                      Feature Importance
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleTuneRow(entry)}
                                      disabled={!selectedSession || tuningBusy}
                                      className={`${SECONDARY_BUTTON} px-2 py-1 text-[10px]`}
                                      title="Send this algorithm to Optuna tuning"
                                    >
                                      {tuningBusy && tuningAlgorithm === entry.algorithm ? (
                                        <Loader2 size={11} className="animate-spin" />
                                      ) : (
                                        <Zap size={11} />
                                      )}
                                      Tune
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            )}

            {activeTab === 3 && (
              <div className="space-y-3">
                {tuningError && (
                  <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-canvas)] px-3 py-2 rounded-[var(--border-radius)]">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
                    <p className="text-xs text-[var(--text-main)]">{tuningError}</p>
                  </div>
                )}

                <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_340px]">
                  <div className="space-y-3">
                    <Section
                      icon={<Sparkles size={14} />}
                      title="Optuna Iterative Optimization"
                      description="Bayesian search over the selected algorithm's hyperparameter space."
                    >
                      <div className="grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
                        <Field label="Algorithm">
                          <Select
                            value={tuningAlgorithm}
                            onChange={setTuningAlgorithm}
                            options={[
                              { value: '', label: 'Select algorithm' },
                              ...Array.from(
                                new Set(
                                  selectedSession?.leaderboard.map((entry) => entry.algorithm) ??
                                    availableAlgorithms,
                                ),
                              ).map((algorithm) => ({ value: algorithm, label: algorithm })),
                            ]}
                          />
                        </Field>
                        <Field label="Trials">
                          <input
                            type="number"
                            min={1}
                            max={500}
                            value={tuningTrialsToRun}
                            onChange={(event) =>
                              setTuningTrialsToRun(Math.max(1, Number(event.target.value) || 1))
                            }
                            className={INPUT_CLASS}
                          />
                        </Field>
                        <button
                          type="button"
                          onClick={() =>
                            void beginTuning(tuningAlgorithm, selectedSession, tuningTrialsToRun, false)
                          }
                          disabled={!selectedSession || !tuningAlgorithm || tuningBusy}
                          className={PRIMARY_BUTTON}
                        >
                          {isStartingTuning ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Play size={13} />
                          )}
                          Start Optuna Tuning
                        </button>
                      </div>

                      {tuningJob && (
                        <div className="mt-3 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                          <div className="flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--text-muted)]">
                            <span className="truncate">
                              JOB {tuningJob.id} · {tuningJob.algorithm}
                            </span>
                            <span className="font-mono text-[var(--text-main)]">
                              {tuningJob.status} · {tuningJob.progress}%
                            </span>
                          </div>
                          <div className="mt-1.5 h-2 overflow-hidden bg-[var(--bg-card)]">
                            <div
                              className="h-full bg-[var(--accent-secondary)] transition-all"
                              style={{ width: `${Math.min(100, Math.max(0, tuningJob.progress))}%` }}
                            />
                          </div>
                        </div>
                      )}

                      {!selectedSession && (
                        <p className={`${HINT_CLASS} mt-2`}>
                          Run screening first or choose a session in Tab 2. Tuning needs a session ID.
                        </p>
                      )}
                    </Section>

                    {!tuningResult ? (
                      <div className={`${CARD_CLASS} flex flex-col items-center justify-center gap-2 px-4 py-16 text-center`}>
                        <Sparkles size={24} className="text-[var(--text-muted)]" />
                        <p className="text-xs font-bold text-[var(--text-main)]">
                          No tuning result yet
                        </p>
                        <p className="max-w-md text-[11px] text-[var(--text-muted)]">
                          Pick an algorithm and start Optuna tuning, or press Tune on a Leaderboard
                          row. Hyperparameter importance, optimization history, and baseline-vs-tuned
                          comparison appear here.
                        </p>
                        <button
                          type="button"
                          onClick={() => setActiveTab(2)}
                          className={`${SECONDARY_BUTTON} mt-1`}
                        >
                          <Trophy size={12} />
                          Open Leaderboard
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="grid gap-3 lg:grid-cols-2">
                          <Section
                            icon={<BarChart3 size={14} />}
                            title="Hyperparameter Importance"
                          >
                            <BarList
                              rows={paramImportanceRows}
                              emptyLabel="No parameter importance returned."
                              formatter={(value) =>
                                `${(value * 100).toLocaleString(undefined, {
                                  maximumFractionDigits: 1,
                                })}%`
                              }
                            />
                          </Section>
                          <Section
                            icon={<Activity size={14} />}
                            title="Baseline vs Tuned"
                          >
                            <ComparisonBars rows={tuningResult.comparisons} />
                          </Section>
                        </div>

                        <Section
                          icon={<LineChart size={14} />}
                          title="Optimization History"
                          description="Trial score versus best-so-far across the study."
                        >
                          <HistoryChart points={tuningResult.optimization_history} />
                        </Section>

                        <div className={`${CARD_CLASS} overflow-hidden`}>
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
                            <div className="flex items-center gap-2">
                              <ListOrdered size={14} className="text-[var(--accent-primary)]" />
                              <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
                                Sortable Tuning Trials
                              </h3>
                            </div>
                            <span className="font-mono text-[10px] font-bold text-[var(--text-muted)]">
                              {tuningResult.trials.length} trials
                            </span>
                          </div>
                          {tuningResult.trials.length === 0 ? (
                            <p className="px-3 py-6 text-xs text-[var(--text-muted)]">
                              No trial rows returned by the tuning job.
                            </p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[780px] border-collapse text-[11px]">
                                <thead>
                                  <tr className="bg-[var(--bg-card)]">
                                    <SortHeader
                                      label="Trial"
                                      sortKey="trial"
                                      sort={trialsSort}
                                      onSort={(key) => setTrialsSort(nextSort(trialsSort, key))}
                                    />
                                    <SortHeader
                                      label={metricLabel(tuningResult.primary_metric)}
                                      sortKey="score"
                                      sort={trialsSort}
                                      onSort={(key) => setTrialsSort(nextSort(trialsSort, key))}
                                      align="right"
                                    />
                                    <SortHeader
                                      label="Duration"
                                      sortKey="duration"
                                      sort={trialsSort}
                                      onSort={(key) => setTrialsSort(nextSort(trialsSort, key))}
                                      align="right"
                                    />
                                    {trialParamKeys.map((key) => (
                                      <SortHeader
                                        key={key}
                                        label={key}
                                        sortKey={key}
                                        sort={trialsSort}
                                        onSort={(sortKey) =>
                                          setTrialsSort(nextSort(trialsSort, sortKey))
                                        }
                                        align="right"
                                      />
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {sortedTrials.map((trial) => {
                                    const best = trial.trial_number === tuningResult.best_trial_number;
                                    return (
                                      <tr
                                        key={trial.trial_number}
                                        className={`border-b border-[var(--border-color)] last:border-b-0 ${
                                          best ? 'bg-[var(--bg-canvas)]' : ''
                                        }`}
                                      >
                                        <td className="px-2 py-1.5">
                                          <span className="inline-flex items-center gap-1 font-mono font-bold text-[var(--text-main)]">
                                            #{trial.trial_number}
                                            {best && (
                                              <span className="border-[length:var(--border-width)] border-[var(--accent-secondary)] px-1 text-[9px] font-bold text-[var(--accent-secondary)] rounded-[var(--border-radius)]">
                                                BEST
                                              </span>
                                            )}
                                          </span>
                                        </td>
                                        <td className="px-2 py-1.5 text-right font-mono font-bold text-[var(--text-main)]">
                                          {formatMetricValue(tuningResult.primary_metric, trial.score)}
                                        </td>
                                        <td className="px-2 py-1.5 text-right font-mono text-[var(--text-main)]">
                                          {formatDuration(trial.duration_sec)}
                                        </td>
                                        {trialParamKeys.map((key) => (
                                          <td
                                            key={key}
                                            className="px-2 py-1.5 text-right font-mono text-[var(--text-main)]"
                                          >
                                            {formatParam(trial.params[key])}
                                          </td>
                                        ))}
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="space-y-3">
                    <Section
                      icon={<ListOrdered size={14} />}
                      title="Tuned Models"
                      description="Each completed tuning is kept for standalone export."
                    >
                      {tunedModels.length === 0 ? (
                        <p className="text-xs text-[var(--text-muted)]">
                          No tuned models yet.
                        </p>
                      ) : (
                        <div className="space-y-1.5">
                          {tunedModels.map((model) => {
                            const key = tuningKey(model);
                            const version = promotedVersions[key];
                            const active =
                              tuningResult !== null && tuningKey(tuningResult) === key;
                            return (
                              <div
                                key={key}
                                className={`border-[length:var(--border-width)] p-2 rounded-[var(--border-radius)] ${
                                  active
                                    ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)]'
                                    : 'border-[var(--border-color)] bg-[var(--bg-input)]'
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setTuningAlgorithm(model.algorithm)}
                                    className="min-w-0 text-left"
                                  >
                                    <p className="truncate text-[11px] font-bold text-[var(--text-main)]">
                                      {model.algorithm}
                                    </p>
                                    <p className="mt-0.5 font-mono text-[10px] text-[var(--text-muted)]">
                                      #{model.best_trial_number} ·{' '}
                                      {formatMetricValue(model.primary_metric, model.best_cv_score)}
                                    </p>
                                  </button>
                                  <div className="flex shrink-0 items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => void handleExport(model)}
                                      disabled={isExporting || tuningBusy}
                                      className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                                      title="Export standalone ZIP for this tuned model"
                                    >
                                      {isExporting ? (
                                        <Loader2 size={11} className="animate-spin" />
                                      ) : (
                                        <Package size={11} />
                                      )}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => void handlePromote(model)}
                                      disabled={isPromoting || tuningBusy}
                                      className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                                      title="Promote this tuned model to Production Gateway"
                                    >
                                      {isPromoting ? (
                                        <Loader2 size={11} className="animate-spin" />
                                      ) : (
                                        <Rocket size={11} />
                                      )}
                                    </button>
                                  </div>
                                </div>
                                {(version || model.best_feature_importance) && (
                                  <div className="mt-1 flex flex-wrap items-center gap-1">
                                    {version !== undefined && (
                                      <span className={SMALL_BADGE}>
                                        <Rocket size={9} />
                                        v{version}
                                      </span>
                                    )}
                                    {Object.keys(model.best_feature_importance).length > 0 && (
                                      <span className={SMALL_BADGE}>
                                        <BarChart3 size={9} />
                                        FI ready
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </Section>

                    <Section
                      icon={<Gauge size={14} />}
                      title="Best Tuned Model"
                      description="Candidate selected by the primary metric."
                    >
                      {!tuningResult ? (
                        <p className="text-xs text-[var(--text-muted)]">
                          Waiting for a completed tuning job.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                                Algorithm
                              </p>
                              <p className="mt-0.5 truncate font-mono text-xs font-bold text-[var(--text-main)]">
                                {tuningResult.algorithm || tuningAlgorithm || '—'}
                              </p>
                            </div>
                            <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                              <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                                Best Trial
                              </p>
                              <p className="mt-0.5 font-mono text-xs font-bold text-[var(--text-main)]">
                                #{tuningResult.best_trial_number}
                              </p>
                            </div>
                          </div>
                          <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
                            <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                              {metricLabel(tuningResult.primary_metric)} · CV score
                            </p>
                            <p className="mt-0.5 font-mono text-lg font-bold text-[var(--accent-secondary)]">
                              {formatMetricValue(
                                tuningResult.primary_metric,
                                tuningResult.best_cv_score,
                              )}
                            </p>
                          </div>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className={SMALL_BADGE}>
                              <Timer size={10} />
                              {tuningResult.trials.length} trials
                            </span>
                            {promotedVersion !== null && (
                              <span className={SMALL_BADGE}>
                                <Rocket size={10} />
                                v{promotedVersion}
                              </span>
                            )}
                          </div>
                          {Object.keys(tuningResult.best_params).length > 0 && (
                            <div className="max-h-40 overflow-y-auto border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] p-2 rounded-[var(--border-radius)]">
                              {Object.entries(tuningResult.best_params).map(([key, value]) => (
                                <div
                                  key={key}
                                  className="flex items-center justify-between gap-2 border-b border-[var(--border-color)] py-0.5 text-[10px] last:border-b-0"
                                >
                                  <span className="truncate text-[var(--text-muted)]">{key}</span>
                                  <span className="font-mono font-bold text-[var(--text-main)]">
                                    {formatParam(value)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </Section>

                    <Section
                      icon={<Settings2 size={14} />}
                      title="Tuning Actions"
                      description="Inspect, iterate, export, or promote the tuned model."
                    >
                      <div className="space-y-2">
                        <button
                          type="button"
                          onClick={openTunedImportance}
                          disabled={!tuningResult}
                          className={`${SECONDARY_BUTTON} w-full justify-start`}
                        >
                          <BarChart3 size={13} />
                          Feature Importance
                        </button>
                        <button
                          type="button"
                          onClick={handleRunMoreTrials}
                          disabled={!tuningResult || tuningBusy || !selectedSession}
                          className={`${SECONDARY_BUTTON} w-full justify-start`}
                        >
                          {tuningBusy ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Plus size={13} />
                          )}
                          + Run {tuningTrialsToRun} More Trials
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleExport()}
                          disabled={!tuningResult || isExporting || tuningBusy}
                          className={`${SECONDARY_BUTTON} w-full justify-start`}
                          title="Creates a staged registry version if needed, then downloads the standalone ZIP."
                        >
                          {isExporting ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Package size={13} />
                          )}
                          Export Standalone
                        </button>
                        <button
                          type="button"
                          onClick={() => void handlePromote()}
                          disabled={!tuningResult || isPromoting || tuningBusy}
                          className={`${PRIMARY_BUTTON} w-full justify-start`}
                        >
                          {isPromoting ? (
                            <Loader2 size={13} className="animate-spin" />
                          ) : (
                            <Rocket size={13} />
                          )}
                          Promote to Production Gateway
                        </button>
                        <p className={HINT_CLASS}>
                          Export downloads a ZIP with the model, pinned requirements, and a runnable
                          Python script. Promotion freezes preprocessing and hyperparameters.
                        </p>
                        {!selectedSession && (
                          <p className="text-[10px] text-[var(--accent-warning)]">
                            Select a session in Tab 2 to enable iterative tuning.
                          </p>
                        )}
                      </div>
                    </Section>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
            <p className="text-[10px] text-[var(--text-muted)]">
              {screeningJob
                ? `Screening: ${screeningJob.status}`
                : 'Screening idle'}
              {tuningJob ? ` · Tuning: ${tuningJob.status}` : ''}
            </p>
            <button
              type="button"
              onClick={() => setActiveConfigNodeId(null)}
              className={SECONDARY_BUTTON}
            >
              Close
            </button>
          </footer>
        </div>
      </div>
      <FeatureImportanceModal />
      <HighCardinalityModal />
    </>
  );
}

