import { useEffect, useState } from 'react';
import {
  Columns3,
  Loader2,
  Play,
  ShieldAlert,
  X,
  XCircle,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';

type CardinalityAction = 'continue' | 'drop_column' | 'stop';

const ACTION_LABEL: Record<CardinalityAction, string> = {
  continue: 'CONTINUE',
  drop_column: 'DROP COLUMN',
  stop: 'STOP & EDIT',
};

export function HighCardinalityModal() {
  const warning = useUIStore((state) => state.highCardinalityWarning);
  const setHighCardinalityWarning = useUIStore(
    (state) => state.setHighCardinalityWarning,
  );
  const addToast = useUIStore((state) => state.addToast);
  const resolveHighCardinality = usePipelineStore(
    (state) => state.resolveHighCardinality,
  );

  const [pendingAction, setPendingAction] = useState<CardinalityAction | null>(null);

  useEffect(() => {
    if (!warning) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setHighCardinalityWarning(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setHighCardinalityWarning, warning]);

  if (!warning) return null;

  const handleDecision = async (action: CardinalityAction) => {
    setPendingAction(action);
    try {
      const response = await resolveHighCardinality(warning.jobId, action);
      setHighCardinalityWarning(null);
      addToast(
        action === 'stop' ? 'warning' : 'success',
        response.message ??
          (action === 'stop'
            ? 'Screening stopped. Adjust the features and run screening again.'
            : `Screening resumed with action: ${ACTION_LABEL[action]}.`),
      );
    } catch (cause) {
      addToast(
        'error',
        `Failed to resolve high cardinality: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    } finally {
      setPendingAction(null);
    }
  };

  const dismiss = () => {
    setHighCardinalityWarning(null);
    addToast(
      'warning',
      'Screening is still paused. Resolve the cardinality warning to resume.',
    );
  };

  const isBusy = pendingAction !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="high-cardinality-title"
        className="relative z-[51] flex max-h-[94vh] w-[min(860px,96vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <ShieldAlert
              size={20}
              className="mt-0.5 shrink-0 text-[var(--accent-warning)]"
            />
            <div className="min-w-0">
              <h2
                id="high-cardinality-title"
                className="truncate text-lg font-bold text-[var(--text-main)]"
              >
                High Cardinality Warning
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">
                Screening paused · job <span className="font-mono">{warning.jobId}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={dismiss}
            disabled={isBusy}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Dismiss high cardinality warning"
            title="Dismiss; screening stays paused"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-3 rounded-[var(--border-radius)]">
            <p className="text-xs text-[var(--text-main)]">
              These categorical columns exceed{' '}
              <span className="font-bold">50 unique values</span> and are configured for
              one-hot encoding. Encoding them can create a very wide, memory-heavy matrix.
            </p>
            <div className="mt-2 overflow-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr>
                    <th className="border-b-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                      Offending Column
                    </th>
                    <th className="border-b-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 text-right text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                      Unique Values
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {warning.offendingColumns.length === 0 ? (
                    <tr>
                      <td
                        colSpan={2}
                        className="px-2 py-2 text-xs text-[var(--text-muted)]"
                      >
                        No offending columns were provided by the screening job.
                      </td>
                    </tr>
                  ) : (
                    warning.offendingColumns.map((column) => (
                      <tr key={column.column}>
                        <td className="border-b border-[var(--border-color)] px-2 py-1.5 font-mono font-bold text-[var(--text-main)]">
                          {column.column}
                        </td>
                        <td className="border-b border-[var(--border-color)] px-2 py-1.5 text-right font-mono font-bold text-[var(--accent-warning)]">
                          {column.unique_count.toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="border-[length:var(--border-width)] border-[var(--border-color)] p-2.5 rounded-[var(--border-radius)]">
              <p className="flex items-center gap-1.5 text-[10px] font-bold text-[var(--accent-secondary)]">
                <Play size={12} />
                CONTINUE
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Keep the columns and resume screening with one-hot encoding.
              </p>
            </div>
            <div className="border-[length:var(--border-width)] border-[var(--border-color)] p-2.5 rounded-[var(--border-radius)]">
              <p className="flex items-center gap-1.5 text-[10px] font-bold text-[var(--accent-warning)]">
                <Columns3 size={12} />
                DROP COLUMN
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Drop the listed columns, then resume screening automatically.
              </p>
            </div>
            <div className="border-[length:var(--border-width)] border-[var(--border-color)] p-2.5 rounded-[var(--border-radius)]">
              <p className="flex items-center gap-1.5 text-[10px] font-bold text-[var(--accent-danger)]">
                <XCircle size={12} />
                STOP &amp; EDIT
              </p>
              <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                Stop this screening job and return to adjust features or encoders.
              </p>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
          <button
            type="button"
            onClick={() => void handleDecision('continue')}
            disabled={isBusy}
            className="flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === 'continue' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Play size={13} />
            )}
            CONTINUE
          </button>
          <button
            type="button"
            onClick={() => void handleDecision('drop_column')}
            disabled={isBusy}
            className="flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--accent-warning)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--accent-warning)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === 'drop_column' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Columns3 size={13} />
            )}
            DROP COLUMN
          </button>
          <button
            type="button"
            onClick={() => void handleDecision('stop')}
            disabled={isBusy}
            className="flex items-center justify-center gap-1.5 bg-[var(--accent-danger)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pendingAction === 'stop' ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <XCircle size={13} />
            )}
            STOP &amp; EDIT
          </button>
        </div>
      </div>
    </div>
  );
}
