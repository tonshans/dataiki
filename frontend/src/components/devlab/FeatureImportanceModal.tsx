import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Gauge,
  Grid3x3,
  Info,
  X,
} from 'lucide-react';
import { useUIStore } from '../../store/useUIStore';

const METRIC_LABELS: Record<string, string> = {
  roc_auc: 'ROC AUC',
  f1: 'F1',
  f1_score: 'F1',
  accuracy: 'Accuracy',
  precision: 'Precision',
  recall: 'Recall',
  log_loss: 'Log Loss',
  mcc: 'MCC',
  rmse: 'RMSE',
  mae: 'MAE',
  mape: 'MAPE',
  r2: 'R²',
  r2_score: 'R²',
  pearson_r: 'Pearson R',
  fit_time_sec: 'Fit Time (s)',
  latency_ms: 'Latency (ms)',
};

function metricLabel(key: string): string {
  return (
    METRIC_LABELS[key.toLowerCase()] ??
    key.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
  );
}

function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (Math.abs(value) >= 1000) {
    return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function matrixShape(matrix: number[][]): { rows: number; columns: number } {
  return {
    rows: matrix.length,
    columns: matrix.reduce((max, row) => Math.max(max, row.length), 0),
  };
}

function matrixAccuracy(matrix: number[][]): number | null {
  let total = 0;
  let correct = 0;
  matrix.forEach((row, rowIndex) => {
    row.forEach((rawValue, columnIndex) => {
      const value = Number(rawValue);
      if (!Number.isFinite(value) || value <= 0) return;
      total += value;
      if (rowIndex === columnIndex) correct += value;
    });
  });
  return total > 0 ? correct / total : null;
}

function Panel({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
      <header className="flex items-start gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
        <span className="mt-0.5 text-[var(--accent-primary)]">{icon}</span>
        <div className="min-w-0">
          <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
            {title}
          </h3>
          {subtitle && (
            <p className="mt-0.5 text-[10px] text-[var(--text-muted)]">{subtitle}</p>
          )}
        </div>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function ConfusionMatrix({ matrix }: { matrix: number[][] }) {
  const [matrixMode, setMatrixMode] = useState<'percent' | 'count'>('percent');
  const { rows, columns } = matrixShape(matrix);
  if (rows === 0 || columns === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        No confusion matrix returned for this model.
      </p>
    );
  }

  const totalSamples = useMemo(() => {
    return matrix.reduce(
      (acc, row) => acc + row.reduce((rAcc, val) => rAcc + (Number(val) || 0), 0),
      0,
    );
  }, [matrix]);

  const maxCell = Math.max(
    1,
    ...matrix.flatMap((row) => row.map((value) => Number(value) || 0)),
  );
  const accuracy = matrixAccuracy(matrix);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold text-[var(--text-muted)] rounded-[var(--border-radius)]">
            Rows = actual · Columns = predicted
          </span>
          {accuracy !== null && (
            <>
              <span className="flex items-center gap-1 border-[length:var(--border-width)] border-[var(--accent-secondary)] bg-[var(--accent-secondary)]/10 px-2 py-1 text-[10px] font-bold text-[var(--accent-secondary)] rounded-[var(--border-radius)]">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-secondary)]" />
                True (Correct) {formatPercent(accuracy)}
              </span>
              <span className="flex items-center gap-1 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--accent-danger)]/10 px-2 py-1 text-[10px] font-bold text-[var(--accent-danger)] rounded-[var(--border-radius)]">
                <span className="inline-block h-2 w-2 rounded-full bg-[var(--accent-danger)]" />
                False (Error) {formatPercent(1 - accuracy)}
              </span>
            </>
          )}
        </div>

        {/* View Mode Switcher: Persentase (default) vs Record Count */}
        <div className="flex items-center rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-0.5 text-[10px]">
          <button
            type="button"
            onClick={() => setMatrixMode('percent')}
            className={`rounded px-2 py-0.5 font-bold transition-colors ${matrixMode === 'percent'
                ? 'bg-[var(--accent-primary)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            title="Tampilkan persentase terhadap total data (default)"
          >
            Persentase (%)
          </button>
          <button
            type="button"
            onClick={() => setMatrixMode('count')}
            className={`rounded px-2 py-0.5 font-bold transition-colors ${matrixMode === 'count'
                ? 'bg-[var(--accent-primary)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-main)]'
              }`}
            title="Tampilkan jumlah baris data riil"
          >
            Record Count
          </button>
        </div>
      </div>

      <div className="overflow-auto">
        <table className="border-collapse text-center text-[11px]">
          <thead>
            <tr>
              <th className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1 text-[9px] font-bold text-[var(--text-muted)]">
                Actual \ Predicted
              </th>
              {Array.from({ length: columns }, (_, columnIndex) => (
                <th
                  key={columnIndex}
                  className="min-w-[64px] border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)]"
                >
                  {columnIndex}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)]">
                  {rowIndex}
                </th>
                {Array.from({ length: columns }, (_, columnIndex) => {
                  const value = Number(row[columnIndex] ?? 0);
                  const isFinite = Number.isFinite(value);
                  const isCorrect = rowIndex === columnIndex;
                  const cellTag =
                    rows === 2 && columns === 2
                      ? rowIndex === 0 && columnIndex === 0
                        ? 'TN'
                        : rowIndex === 0 && columnIndex === 1
                          ? 'FP'
                          : rowIndex === 1 && columnIndex === 0
                            ? 'FN'
                            : 'TP'
                      : isCorrect
                        ? 'True'
                        : 'False';

                  const displayValue = !isFinite
                    ? '—'
                    : matrixMode === 'percent'
                      ? totalSamples > 0
                        ? `${((value / totalSamples) * 100).toFixed(2)}%`
                        : '0.00%'
                      : value.toLocaleString();

                  const cellTitle = isFinite
                    ? `${cellTag} (${isCorrect ? 'True / Correct' : 'False / Error'}): ${value.toLocaleString()} records (${totalSamples > 0 ? ((value / totalSamples) * 100).toFixed(2) : 0}%)`
                    : '—';

                  const overlayColor = isCorrect
                    ? 'var(--accent-secondary)'
                    : 'var(--accent-danger)';

                  const overlayOpacity = !isFinite || value === 0
                    ? 0.05
                    : 0.15 + (Math.max(value, 0) / maxCell) * 0.55;

                  return (
                    <td
                      key={columnIndex}
                      className="relative min-w-[76px] border-[length:var(--border-width)] border-[var(--border-color)] px-2.5 py-2"
                      title={cellTitle}
                    >
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                        style={{
                          backgroundColor: overlayColor,
                          opacity: overlayOpacity,
                        }}
                      />
                      <div className="relative flex items-center justify-center gap-1 font-mono text-[11px] font-bold">
                        <span
                          className={`text-[9px] font-semibold ${isCorrect
                              ? 'text-[var(--accent-secondary)]'
                              : value > 0
                                ? 'text-[var(--accent-danger)]'
                                : 'text-[var(--text-muted)]'
                            }`}
                        >
                          [{cellTag}]
                        </span>
                        <span className="text-[var(--text-main)]">{displayValue}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function FeatureImportanceModal() {
  const target = useUIStore((state) => state.featureImportanceTarget);
  const setFeatureImportanceTarget = useUIStore(
    (state) => state.setFeatureImportanceTarget,
  );

  useEffect(() => {
    if (!target) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFeatureImportanceTarget(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setFeatureImportanceTarget, target]);

  const features = useMemo(() => {
    const entries = Object.entries(target?.importance ?? {})
      .map(([name, rawValue]) => [name, Number(rawValue)] as const)
      .filter(([, value]) => Number.isFinite(value))
      .sort((left, right) => right[1] - left[1]);
    const maxImportance = Math.max(0.0001, ...entries.map(([, value]) => Math.abs(value)));
    return { entries, maxImportance };
  }, [target]);

  const metricEntries = useMemo(
    () =>
      Object.entries(target?.metrics ?? {}).filter(([, value]) =>
        Number.isFinite(Number(value)),
      ),
    [target],
  );

  if (!target) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setFeatureImportanceTarget(null);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="feature-importance-title"
        className="relative z-[51] flex h-[min(880px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <Activity size={20} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
            <div className="min-w-0">
              <h2
                id="feature-importance-title"
                className="truncate text-lg font-bold text-[var(--text-main)]"
              >
                {target.title || 'Model Metrics & Evaluation'}
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">
                Evaluation metrics, confusion matrix, and feature importance
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setFeatureImportanceTarget(null)}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
            aria-label="Close feature importance"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <Panel
              icon={<BarChart3 size={14} />}
              title="Feature Importance"
              subtitle="Sorted from highest to lowest contribution"
            >
              {features.entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                  <Info size={22} className="text-[var(--accent-warning)]" />
                  <p className="text-xs font-bold text-[var(--text-main)]">
                    No feature importance data
                  </p>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    This algorithm did not return feature importance, or the model uses
                    features that cannot be ranked.
                  </p>
                </div>
              ) : (
                <ul className="max-h-[540px] space-y-2 overflow-y-auto pr-1">
                  {features.entries.map(([name, value], index) => (
                    <li key={name} className="flex items-center gap-2">
                      <span className="w-5 shrink-0 text-right font-mono text-[10px] text-[var(--text-muted)]">
                        {index + 1}
                      </span>
                      <span
                        className="w-36 shrink-0 truncate font-mono text-[11px] text-[var(--text-main)]"
                        title={name}
                      >
                        {name}
                      </span>
                      <span className="h-3.5 min-w-0 flex-1 overflow-hidden bg-[var(--bg-canvas)]">
                        <span
                          className={`block h-full ${value < 0
                              ? 'bg-[var(--accent-danger)]'
                              : 'bg-[var(--accent-primary)]'
                            }`}
                          style={{
                            width: `${(Math.abs(value) / features.maxImportance) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="w-20 shrink-0 text-right font-mono text-[10px] font-bold text-[var(--text-main)]">
                        {formatMetric(value)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            <div className="space-y-3">
              <Panel
                icon={<Gauge size={14} />}
                title="Evaluation Metrics"
                subtitle="Accuracy and error indicators returned by the model"
              >
                {metricEntries.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">
                    No evaluation metrics returned.
                  </p>
                ) : (
                  <div className="rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-1.5">
                    <ul className="divide-y divide-[var(--border-color)] font-mono text-xs">
                      {metricEntries.map(([key, value]) => (
                        <li
                          key={key}
                          className="flex items-center justify-between px-2.5 py-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]"
                        >
                          <span className="font-sans text-[11px] font-medium text-[var(--text-muted)]">
                            {metricLabel(key)}
                          </span>
                          <span className="text-[11px] font-bold text-[var(--text-main)]">
                            {formatMetric(Number(value))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Panel>

              <Panel
                icon={<Grid3x3 size={14} />}
                title="Confusion Matrix"
                subtitle="Classification evaluation; regression models show error metrics only"
              >
                {target.confusionMatrix && target.confusionMatrix.length > 0 ? (
                  <ConfusionMatrix matrix={target.confusionMatrix} />
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">
                    No confusion matrix for this model. Use the error metrics above for
                    regression evaluation.
                  </p>
                )}
              </Panel>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
          <button
            type="button"
            onClick={() => setFeatureImportanceTarget(null)}
            className="flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
