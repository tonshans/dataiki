import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  BarChart3,
  CornerDownRight,
  Info,
  Loader2,
  RefreshCw,
  Sigma,
  TrendingUp,
  X,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';

function formatValue(value: unknown, digits = 4): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return value.toLocaleString(undefined, {
      maximumFractionDigits: Math.abs(value) >= 1000 ? 2 : digits,
    });
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatPercent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${formatValue(value, digits)}%`;
}

function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value > 0 ? '+' : ''}${formatValue(value, 4)}`;
}

function Section({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
      <header className="flex items-center gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
        <span className="text-[var(--accent-primary)]">{icon}</span>
        <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
          {title}
        </h3>
      </header>
      <div className="p-3">{children}</div>
    </section>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: ReactNode;
  accent?: 'primary' | 'secondary' | 'warning' | 'danger';
}) {
  const color =
    accent === 'secondary'
      ? 'var(--accent-secondary)'
      : accent === 'warning'
        ? 'var(--accent-warning)'
        : accent === 'danger'
          ? 'var(--accent-danger)'
          : 'var(--text-main)';
  return (
    <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-2 rounded-[var(--border-radius)]">
      <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
        {label}
      </p>
      <p className="mt-0.5 break-words font-mono text-sm font-bold" style={{ color }}>
        {value}
      </p>
    </div>
  );
}

export function ColumnAnalysisModal() {
  const column = useUIStore((state) => state.activeAnalysisColumn);
  const setActiveAnalysisColumn = useUIStore((state) => state.setActiveAnalysisColumn);
  const tabularPreview = usePipelineStore((state) => state.tabularPreview);
  const selectedNodeId = usePipelineStore((state) => state.selectedNodeId);
  const columnAnalysisCache = usePipelineStore((state) => state.columnAnalysisCache);
  const fetchColumnAnalysis = usePipelineStore((state) => state.fetchColumnAnalysis);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const nodeId = tabularPreview?.node_id ?? selectedNodeId;
  const cacheKey = column && nodeId ? `${nodeId}::${column}::` : '';
  const analysis = cacheKey ? columnAnalysisCache[cacheKey] : undefined;

  useEffect(() => {
    if (!column) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveAnalysisColumn(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [column, setActiveAnalysisColumn]);

  useEffect(() => {
    if (!column || !nodeId) return;
    if (analysis) {
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetchColumnAnalysis(nodeId, column)
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [analysis, column, fetchColumnAnalysis, nodeId, reloadToken]);

  const maxBinCount = useMemo(
    () =>
      Math.max(
        1,
        ...(analysis?.histogram_bins ?? []).map((bin) => bin.count),
      ),
    [analysis],
  );

  const maxFrequencyCount = useMemo(
    () =>
      Math.max(
        1,
        ...(analysis?.top_frequencies ?? []).map((item) => item.count),
      ),
    [analysis],
  );

  const maxCorrelation = useMemo(
    () =>
      Math.max(
        0.0001,
        ...(analysis?.correlations ?? []).map((item) => Math.abs(item.correlation)),
      ),
    [analysis],
  );

  if (!column || !nodeId) return null;

  const zScorePct =
    analysis && analysis.total_rows > 0
      ? (analysis.zscore_outlier_count / analysis.total_rows) * 100
      : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setActiveAnalysisColumn(null);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="column-analysis-title"
        className="relative z-[51] flex h-[min(880px,94vh)] w-[min(1120px,96vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <Activity size={20} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
            <div className="min-w-0">
              <h2
                id="column-analysis-title"
                className="truncate text-lg font-bold text-[var(--text-main)]"
              >
                Column Analysis · <span className="font-mono">{column}</span>
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">
                {analysis
                  ? `${analysis.dtype || 'unknown'} · ${analysis.total_rows.toLocaleString()} rows · ${nodeId}`
                  : `Computing DuckDB/Polars statistics · ${nodeId}`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveAnalysisColumn(null)}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
            aria-label="Close column analysis"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading && !analysis ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Loader2 size={26} className="animate-spin text-[var(--accent-primary)]" />
              <p className="text-sm font-bold text-[var(--text-main)]">
                Analyzing column…
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Computing quantiles, outliers, distribution, and correlations.
              </p>
            </div>
          ) : error && !analysis ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <AlertCircle size={26} className="text-[var(--accent-danger)]" />
              <p className="text-sm font-bold text-[var(--text-main)]">
                Analysis failed
              </p>
              <p className="max-w-lg break-words text-xs text-[var(--accent-danger)]">
                {error}
              </p>
              <button
                type="button"
                onClick={() => setReloadToken((value) => value + 1)}
                className="flex items-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] hover:bg-[var(--bg-hover)]"
              >
                <RefreshCw size={13} />
                Retry
              </button>
            </div>
          ) : !analysis ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
              <Info size={24} className="text-[var(--accent-warning)]" />
              <p className="text-sm font-bold text-[var(--text-main)]">
                No analysis available
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                Run the node preview first, then analyze a column.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat
                  label="Nulls"
                  value={`${analysis.null_count.toLocaleString()} (${formatPercent(analysis.null_pct)})`}
                  accent={analysis.null_count > 0 ? 'warning' : 'secondary'}
                />
                <Stat
                  label="Zero Ratio"
                  value={`${formatPercent(analysis.zero_ratio_pct)} · ${analysis.zero_count.toLocaleString()}`}
                  accent={analysis.zero_ratio_pct > 0 ? 'warning' : 'secondary'}
                />
                <Stat
                  label="Negative Count"
                  value={analysis.negative_count.toLocaleString()}
                  accent={analysis.negative_count > 0 ? 'danger' : 'secondary'}
                />
                <Stat
                  label="Fill Rate"
                  value={`${formatPercent(analysis.fill_rate_pct)} · ${analysis.filled_count.toLocaleString()}`}
                  accent="secondary"
                />
                <Stat label="Unique Count" value={analysis.unique_count.toLocaleString()} />
                <Stat label="Total Rows" value={analysis.total_rows.toLocaleString()} />
              </div>

              <Section icon={<Sigma size={14} />} title="Central Tendency & Dispersion">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  <Stat label="Mean" value={formatValue(analysis.mean)} />
                  <Stat label="Median" value={formatValue(analysis.median)} />
                  <Stat label="Mode" value={formatValue(analysis.mode)} />
                  <Stat label="Std Dev" value={formatValue(analysis.std_dev)} />
                  <Stat label="Variance" value={formatValue(analysis.variance)} />
                  <Stat label="Min" value={formatValue(analysis.min_val)} />
                  <Stat label="Max" value={formatValue(analysis.max_val)} />
                  <Stat label="IQR" value={formatValue(analysis.iqr)} />
                  <Stat label="Q1 (25%)" value={formatValue(analysis.q25)} />
                  <Stat label="Q2 (50%)" value={formatValue(analysis.q50)} />
                  <Stat label="Q3 (75%)" value={formatValue(analysis.q75)} />
                  <Stat label="Skewness" value={formatValue(analysis.skewness)} />
                  <Stat label="Kurtosis" value={formatValue(analysis.kurtosis)} />
                </div>
              </Section>

              <Section icon={<AlertCircle size={14} />} title="Outlier Detection">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Stat
                    label="IQR Outliers (1.5 × IQR)"
                    value={`${analysis.iqr_outlier_count.toLocaleString()} (${formatPercent(analysis.iqr_outlier_pct)})`}
                    accent={analysis.iqr_outlier_count > 0 ? 'warning' : 'secondary'}
                  />
                  <Stat
                    label="Z-Score Outliers (|z| > 3)"
                    value={`${analysis.zscore_outlier_count.toLocaleString()} (${formatPercent(zScorePct)})`}
                    accent={analysis.zscore_outlier_count > 0 ? 'warning' : 'secondary'}
                  />
                </div>
              </Section>

              <div className="grid gap-3 lg:grid-cols-2">
                <Section icon={<BarChart3 size={14} />} title="Distribution">
                  {analysis.histogram_bins.length > 0 ? (
                    <ul className="space-y-1.5">
                      {analysis.histogram_bins.map((bin) => (
                        <li key={bin.bin_label} className="flex items-center gap-2">
                          <span className="w-28 shrink-0 truncate font-mono text-[10px] text-[var(--text-muted)]" title={bin.bin_label}>
                            {bin.bin_label}
                          </span>
                          <span className="h-3 min-w-0 flex-1 overflow-hidden bg-[var(--bg-canvas)]">
                            <span
                              className="block h-full bg-[var(--accent-primary)]"
                              style={{ width: `${(bin.count / maxBinCount) * 100}%` }}
                            />
                          </span>
                          <span className="w-14 shrink-0 text-right font-mono text-[10px] text-[var(--text-main)]">
                            {bin.count.toLocaleString()}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-[var(--text-muted)]">
                      No numeric histogram for this dtype. See frequent values.
                    </p>
                  )}
                </Section>

                <Section icon={<TrendingUp size={14} />} title="Top 5 Most Frequent Values">
                  {analysis.top_frequencies.length > 0 ? (
                    <ul className="space-y-1.5">
                      {analysis.top_frequencies.slice(0, 5).map((item, index) => {
                        const pct =
                          item.pct ??
                          (analysis.total_rows > 0
                            ? (item.count / analysis.total_rows) * 100
                            : 0);
                        return (
                          <li
                            key={`${String(item.value)}-${index}`}
                            className="flex items-center gap-2"
                          >
                            <span
                              className="w-28 shrink-0 truncate font-mono text-[10px] text-[var(--text-main)]"
                              title={formatValue(item.value)}
                            >
                              {formatValue(item.value)}
                            </span>
                            <span className="h-3 min-w-0 flex-1 overflow-hidden bg-[var(--bg-canvas)]">
                              <span
                                className="block h-full bg-[var(--accent-secondary)]"
                                style={{ width: `${(item.count / maxFrequencyCount) * 100}%` }}
                              />
                            </span>
                            <span className="w-24 shrink-0 text-right font-mono text-[10px] text-[var(--text-muted)]">
                              {item.count.toLocaleString()} · {formatPercent(pct, 1)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p className="text-xs text-[var(--text-muted)]">
                      No frequent value data returned.
                    </p>
                  )}
                </Section>
              </div>

              <Section icon={<CornerDownRight size={14} />} title="Correlations">
                {analysis.target_correlation !== null &&
                  analysis.target_correlation !== undefined && (
                    <div className="mb-2">
                      <Stat
                        label="Target Correlation"
                        value={formatSigned(analysis.target_correlation)}
                        accent={
                          Math.abs(analysis.target_correlation) >= 0.5
                            ? 'secondary'
                            : undefined
                        }
                      />
                    </div>
                  )}
                {analysis.correlations.length > 0 ? (
                  <ul className="space-y-1.5">
                    {analysis.correlations.map((item) => {
                      const positive = item.correlation >= 0;
                      return (
                        <li key={item.column} className="flex items-center gap-2">
                          <span
                            className="w-40 shrink-0 truncate font-mono text-[10px] text-[var(--text-main)]"
                            title={item.column}
                          >
                            {item.column}
                          </span>
                          <span className="flex h-3 min-w-0 flex-1 items-center overflow-hidden bg-[var(--bg-canvas)]">
                            <span
                              className={`h-full ${positive ? 'bg-[var(--accent-secondary)]' : 'bg-[var(--accent-danger)]'}`}
                              style={{
                                width: `${(Math.abs(item.correlation) / maxCorrelation) * 100}%`,
                              }}
                            />
                          </span>
                          <span
                            className="w-16 shrink-0 text-right font-mono text-[10px] font-bold"
                            style={{
                              color: positive
                                ? 'var(--accent-secondary)'
                                : 'var(--accent-danger)',
                            }}
                          >
                            {formatSigned(item.correlation)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="text-xs text-[var(--text-muted)]">
                    No numeric correlations returned for this column.
                  </p>
                )}
              </Section>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
          <button
            type="button"
            onClick={() => setActiveAnalysisColumn(null)}
            className="flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
