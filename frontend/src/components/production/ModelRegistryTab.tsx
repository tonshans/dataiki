import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  Loader2,
  Package,
  RefreshCw,
  Rocket,
  Trash2,
  Trophy,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { PublishedModelItem } from '../../types/dataiki';

type RowAction = 'activate' | 'retrain' | 'delete';

interface BusyState {
  modelId: string;
  action: RowAction;
}

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';
const TABLE_HEAD_CLASS =
  'border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2 text-left text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
const STATUS_BADGE =
  'inline-flex items-center border-[length:var(--border-width)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest rounded-[var(--border-radius)]';

const CLASSIFICATION_METRIC_KEYS = ['roc_auc', 'f1', 'accuracy', 'precision', 'recall'];
const REGRESSION_METRIC_KEYS = ['rmse', 'mae', 'r2', 'mape'];

const METRIC_LABELS: Record<string, string> = {
  roc_auc: 'ROC AUC',
  f1: 'F1',
  accuracy: 'Acc',
  precision: 'Precision',
  recall: 'Recall',
  rmse: 'RMSE',
  mae: 'MAE',
  r2: 'R2',
  mape: 'MAPE',
  log_loss: 'Log Loss',
  mcc: 'MCC',
  average_precision: 'Avg Precision',
  pearson_r: 'Pearson R',
  explained_variance: 'Explained Var',
  rmsle: 'RMSLE',
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDateTime(value: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatMetricValue(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(Number(value.toFixed(4)));
}

function metricLabel(key: string): string {
  return (
    METRIC_LABELS[key.toLowerCase()] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function evaluationMatrix(model: PublishedModelItem): Array<{ label: string; value: string }> {
  const classification =
    model.prediction_type === 'binary_classification' ||
    model.prediction_type === 'multiclass_classification';
  const ordered = classification ? CLASSIFICATION_METRIC_KEYS : REGRESSION_METRIC_KEYS;
  const available = ordered.filter((key) => Number.isFinite(model.metrics[key]));
  const keys =
    available.length > 0
      ? available
      : Object.keys(model.metrics).filter((key) => Number.isFinite(model.metrics[key]));
  return keys.slice(0, 4).map((key) => ({
    label: metricLabel(key),
    value: formatMetricValue(Number(model.metrics[key])),
  }));
}

function statusStyle(status: PublishedModelItem['status']): string {
  if (status === 'active') {
    return 'border-[var(--accent-secondary)] bg-[var(--accent-secondary)] text-[var(--bg-card)]';
  }
  if (status === 'staged') {
    return 'border-[var(--accent-warning)] text-[var(--accent-warning)]';
  }
  return 'border-[var(--border-color)] text-[var(--text-muted)]';
}

export function ModelRegistryTab() {
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const publishedModels = usePipelineStore((state) => state.publishedModels);
  const loadPublishedModels = usePipelineStore((state) => state.loadPublishedModels);
  const activateModelVersion = usePipelineStore((state) => state.activateModelVersion);
  const retrainModel = usePipelineStore((state) => state.retrainModel);
  const deleteModelVersion = usePipelineStore((state) => state.deleteModelVersion);
  const addToast = useUIStore((state) => state.addToast);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyState | null>(null);

  useEffect(() => {
    if (!projectKey) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    loadPublishedModels(projectKey)
      .catch((loadError: unknown) => {
        if (cancelled) return;
        const detail = messageOf(loadError);
        setError(detail);
        addToast('error', `Failed to load model registry: ${detail}`);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [addToast, loadPublishedModels, projectKey]);

  const models = useMemo(
    () =>
      [...publishedModels].sort(
        (left, right) =>
          left.model_name.localeCompare(right.model_name) || right.version - left.version,
      ),
    [publishedModels],
  );

  const activeCount = models.filter((model) => model.status === 'active').length;

  const refresh = async () => {
    if (!projectKey) return;
    setIsLoading(true);
    setError(null);
    try {
      await loadPublishedModels(projectKey);
    } catch (refreshError) {
      const detail = messageOf(refreshError);
      setError(detail);
      addToast('error', `Failed to refresh model registry: ${detail}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleActivate = async (model: PublishedModelItem) => {
    setBusy({ modelId: model.model_id, action: 'activate' });
    try {
      await activateModelVersion(model.model_id);
      addToast(
        'success',
        `${model.model_name} v${model.version} is now the Active Model. API and job bindings were updated.`,
      );
    } catch (activateError) {
      addToast('error', `Activation failed: ${messageOf(activateError)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleRetrain = async (model: PublishedModelItem) => {
    setBusy({ modelId: model.model_id, action: 'retrain' });
    try {
      const result = await retrainModel(model.model_id);
      const nextVersion = Number(result?.version ?? 0);
      addToast(
        'success',
        nextVersion
          ? `Retrain finished: ${model.model_name} v${nextVersion} is staged for review.`
          : `Retrain finished for ${model.model_name}; the new version is staged for review.`,
      );
    } catch (retrainError) {
      addToast('error', `Retrain failed: ${messageOf(retrainError)}`);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (model: PublishedModelItem) => {
    const confirmed = window.confirm(
      `Delete ${model.model_name} v${model.version}? This cannot be undone.`,
    );
    if (!confirmed) return;
    setBusy({ modelId: model.model_id, action: 'delete' });
    try {
      await deleteModelVersion(model.model_id);
      addToast('success', `Deleted ${model.model_name} v${model.version}.`);
    } catch (deleteError) {
      addToast('error', `Delete failed: ${messageOf(deleteError)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <header className={`${CARD_CLASS} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <div className="flex min-w-0 items-start gap-2">
          <Package size={18} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
              Model Registry &amp; Versioning
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              One Active Model per name. Activate any staged version for an instant rollback.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            <Trophy size={11} className="text-[var(--accent-secondary)]" />
            {activeCount} active
          </span>
          <span className="inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            {models.length} version{models.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={isLoading || !projectKey}
            className={SECONDARY_BUTTON}
            title="Refresh model registry"
          >
            <RefreshCw size={12} className={isLoading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-card)] px-3 py-2 rounded-[var(--border-radius)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
          <p className="text-xs text-[var(--text-main)]">{error}</p>
        </div>
      )}

      {!projectKey ? (
        <div className={`${CARD_CLASS} px-4 py-10 text-center`}>
          <p className="text-xs font-bold text-[var(--text-main)]">No active project</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Select a project before opening the Model Registry.
          </p>
        </div>
      ) : isLoading && models.length === 0 ? (
        <div className={`${CARD_CLASS} flex items-center justify-center gap-2 px-4 py-10 text-xs text-[var(--text-muted)]`}>
          <Loader2 size={15} className="animate-spin" />
          Loading model versions…
        </div>
      ) : models.length === 0 ? (
        <div className={`${CARD_CLASS} px-4 py-10 text-center`}>
          <Package size={24} className="mx-auto text-[var(--text-muted)]" />
          <p className="mt-2 text-xs font-bold text-[var(--text-main)]">No published models yet</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            Promote a tuned model from ML Studio to create the first registry version.
          </p>
        </div>
      ) : (
        <div className={`${CARD_CLASS} overflow-hidden`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] border-collapse text-[11px]">
              <thead>
                <tr className="bg-[var(--bg-canvas)]">
                  <th className={TABLE_HEAD_CLASS}>Model Name</th>
                  <th className={TABLE_HEAD_CLASS}>Version</th>
                  <th className={TABLE_HEAD_CLASS}>Status</th>
                  <th className={TABLE_HEAD_CLASS}>Training Date</th>
                  <th className={TABLE_HEAD_CLASS}>Algorithm</th>
                  <th className={TABLE_HEAD_CLASS}>Evaluation Matrix</th>
                  <th className={`${TABLE_HEAD_CLASS} text-right`}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model) => {
                  const active = model.status === 'active';
                  const matrix = evaluationMatrix(model);
                  const rowBusy = busy?.modelId === model.model_id;
                  return (
                    <tr
                      key={model.model_id}
                      className={`border-b-[length:var(--border-width)] border-[var(--border-color)] last:border-b-0 ${
                        active
                          ? 'bg-[var(--bg-canvas)] shadow-[inset_6px_0_0_var(--accent-secondary)]'
                          : 'bg-[var(--bg-card)] hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <td className="px-3 py-2">
                        <p className="truncate font-bold text-[var(--text-main)]">{model.model_name}</p>
                        <p className="truncate font-mono text-[10px] text-[var(--text-muted)]">
                          {model.target_column || '—'} · {model.feature_columns.length} features
                        </p>
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-mono text-xs font-bold text-[var(--text-main)]">
                          v{model.version}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`${STATUS_BADGE} ${statusStyle(model.status)}`}>
                          {active ? '🟢 ACTIVE MODEL' : model.status}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className="inline-flex items-center gap-1.5 font-mono text-[10px] text-[var(--text-main)]"
                          title={model.created_at}
                        >
                          <CalendarClock size={11} className="shrink-0 text-[var(--text-muted)]" />
                          {formatDateTime(model.created_at)}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-bold text-[var(--text-main)]">
                        {model.algorithm || '—'}
                      </td>
                      <td className="px-3 py-2">
                        {matrix.length === 0 ? (
                          <span className="text-[var(--text-muted)]">—</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1">
                            {matrix.map((metric) => (
                              <span
                                key={metric.label}
                                className="inline-flex items-baseline gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-1.5 py-0.5 font-mono text-[10px] rounded-[var(--border-radius)]"
                              >
                                <span className="font-bold uppercase tracking-wide text-[var(--text-muted)]">
                                  {metric.label}
                                </span>
                                <span className="font-bold text-[var(--text-main)]">{metric.value}</span>
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center justify-end gap-1">
                          {active ? (
                            <button
                              type="button"
                              onClick={() => void handleRetrain(model)}
                              disabled={rowBusy || isLoading}
                              className={PRIMARY_BUTTON}
                              title="Retrain with the newest source data using frozen recipe and hyperparameters"
                            >
                              {rowBusy && busy?.action === 'retrain' ? (
                                <Loader2 size={11} className="animate-spin" />
                              ) : (
                                <RefreshCw size={11} />
                              )}
                              Retrain with New Data
                            </button>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() => void handleActivate(model)}
                                disabled={rowBusy}
                                className={PRIMARY_BUTTON}
                                title="Activate this version and rebind API/job references"
                              >
                                {rowBusy && busy?.action === 'activate' ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <Rocket size={11} />
                                )}
                                Activate
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleDelete(model)}
                                disabled={rowBusy || isLoading}
                                className={SECONDARY_BUTTON}
                                title="Delete this model version"
                              >
                                {rowBusy && busy?.action === 'delete' ? (
                                  <Loader2 size={11} className="animate-spin" />
                                ) : (
                                  <Trash2 size={11} />
                                )}
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
