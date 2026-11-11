import { useState } from 'react';
import { CalendarClock, Terminal } from 'lucide-react';
import { SchedulerMasterDetailTab } from './SchedulerMasterDetailTab';
import { FreestyleSchedulesPanel } from './FreestyleSchedulesPanel';

interface SchedulerWorkspaceProps {
  allowFreestyle: boolean;
}

const MODE_BUTTON =
  'inline-flex items-center gap-1.5 border-[length:var(--border-width)] px-2.5 py-1.5 text-[10px] font-bold rounded-[var(--border-radius)] transition-colors';

export function SchedulerWorkspace({ allowFreestyle }: SchedulerWorkspaceProps) {
  const [mode, setMode] = useState<'batch' | 'freestyle'>('batch');

  return (
    <div className="space-y-3">
      {allowFreestyle && (
        <div
          role="tablist"
          aria-label="Scheduler job types"
          className="flex flex-wrap items-center gap-1.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'batch'}
            onClick={() => setMode('batch')}
            className={`${MODE_BUTTON} ${
              mode === 'batch'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--bg-card)]'
                : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <CalendarClock size={12} />
            Batch Jobs
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'freestyle'}
            onClick={() => setMode('freestyle')}
            className={`${MODE_BUTTON} ${
              mode === 'freestyle'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--bg-card)]'
                : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Terminal size={12} />
            Freestyle Scripts
          </button>
        </div>
      )}

      {mode === 'freestyle' && allowFreestyle ? (
        <FreestyleSchedulesPanel />
      ) : (
        <SchedulerMasterDetailTab />
      )}
    </div>
  );
}
