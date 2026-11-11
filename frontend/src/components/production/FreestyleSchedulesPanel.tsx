import { useEffect, useMemo, useState } from 'react';
import {
  CalendarClock,
  Loader2,
  Play,
  Save,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { FreestyleScriptItem, ScheduleConfig } from '../../types/dataiki';

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';
const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1 text-[11px] text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50';
const LABEL_CLASS =
  'mb-0.5 block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const HINT_CLASS = 'text-[10px] leading-relaxed text-[var(--text-muted)]';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
const RUN_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-secondary)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';

const SCHEDULE_TYPES: Array<{ value: ScheduleConfig['schedule_type']; label: string }> = [
  { value: 'unscheduled', label: 'Unscheduled' },
  { value: 'every_minute', label: 'Every minute' },
  { value: 'every_hour', label: 'Every hour' },
  { value: 'daily_at', label: 'Daily at (HH:MM)' },
  { value: 'specific_date', label: 'Specific date (YYYY-MM-DD HH:MM)' },
];

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptySchedule(): ScheduleConfig {
  return {
    is_scheduled: false,
    schedule_type: 'unscheduled',
    interval_val: 1,
    daily_time: '08:00',
    run_date: null,
  };
}

function scheduleFromScript(script: FreestyleScriptItem | undefined): ScheduleConfig {
  return script?.schedule_config ?? emptySchedule();
}

function describeSchedule(schedule: ScheduleConfig): string {
  if (!schedule.is_scheduled || schedule.schedule_type === 'unscheduled') return 'Unscheduled';
  if (schedule.schedule_type === 'daily_at') return `Daily at ${schedule.daily_time || '--:--'}`;
  if (schedule.schedule_type === 'specific_date') return `Once at ${schedule.run_date || '—'}`;
  return schedule.schedule_type === 'every_minute' ? 'Every minute' : 'Every hour';
}

export function FreestyleSchedulesPanel() {
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const scripts = usePipelineStore((state) => state.freestyleScripts);
  const loadFreestyleScripts = usePipelineStore((state) => state.loadFreestyleScripts);
  const updateFreestyleSchedule = usePipelineStore((state) => state.updateFreestyleSchedule);
  const runFreestyleScriptNow = usePipelineStore((state) => state.runFreestyleScriptNow);
  const addToast = useUIStore((state) => state.addToast);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleConfig>(emptySchedule);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [output, setOutput] = useState<string>('');

  const projectScripts = useMemo(
    () => scripts.filter((script) => script.project_key === projectKey),
    [scripts, projectKey],
  );
  const selected = projectScripts.find((script) => script.script_id === selectedId);

  useEffect(() => {
    if (!projectKey) return;
    void loadFreestyleScripts(projectKey).catch((error) => {
      addToast('error', `Failed to load scripts: ${messageOf(error)}`);
    });
  }, [addToast, loadFreestyleScripts, projectKey]);

  useEffect(() => {
    if (projectScripts.length === 0) {
      setSelectedId(null);
      setSchedule(emptySchedule());
      setOutput('');
      return;
    }
    if (!selected) {
      const first = projectScripts[0];
      setSelectedId(first.script_id ?? null);
      setSchedule(scheduleFromScript(first));
      setOutput(first.last_output ?? '');
    }
  }, [projectScripts, selected]);

  const selectScript = (script: FreestyleScriptItem) => {
    setSelectedId(script.script_id ?? null);
    setSchedule(scheduleFromScript(script));
    setOutput(script.last_output ?? '');
  };

  const patchSchedule = (patch: Partial<ScheduleConfig>) => {
    setSchedule((current) => ({ ...current, ...patch }));
  };

  const changeType = (type: ScheduleConfig['schedule_type']) => {
    patchSchedule({ schedule_type: type, is_scheduled: type !== 'unscheduled' });
  };

  const handleSave = async () => {
    if (!selected?.script_id) {
      addToast('warning', 'Pick a saved script first.');
      return;
    }
    setIsSaving(true);
    try {
      await updateFreestyleSchedule(selected.script_id, schedule);
      addToast('success', `Schedule saved for '${selected.script_name}'.`);
    } catch (error) {
      addToast('error', `Save failed: ${messageOf(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRun = async () => {
    if (!selected?.script_id) return;
    setIsRunning(true);
    try {
      const result = await runFreestyleScriptNow(selected.script_id);
      const text = [
        result.stdout.trimEnd(),
        result.result_preview ? `[result] ${result.result_preview}` : '',
        result.status === 'success'
          ? `✔ Finished in ${result.duration_ms} ms`
          : result.error.trimEnd(),
      ]
        .filter(Boolean)
        .join('\n');
      setOutput(text);
      if (result.status === 'success') {
        addToast('success', `Script '${selected.script_name}' finished.`);
      } else {
        addToast('error', `Script '${selected.script_name}' failed.`);
      }
    } catch (error) {
      setOutput(messageOf(error));
      addToast('error', `Run failed: ${messageOf(error)}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="grid items-start gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className={`${CARD_CLASS} overflow-hidden`}>
        <div className="border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
            Freestyle Scripts
          </p>
          <p className={HINT_CLASS}>{projectScripts.length} script(s) in this project</p>
        </div>
        <div className="max-h-[600px] overflow-y-auto p-1.5">
          {projectScripts.length === 0 ? (
            <p className="px-1.5 py-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
              No scripts yet. Create one in Production Gateway → Freestyle Script Editor.
            </p>
          ) : (
            <ul className="space-y-1">
              {projectScripts.map((script) => (
                <li key={script.script_id}>
                  <button
                    type="button"
                    onClick={() => selectScript(script)}
                    className={`w-full border-[length:var(--border-width)] px-2 py-1.5 text-left rounded-[var(--border-radius)] transition-colors ${
                      selectedId === script.script_id
                        ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)]'
                        : 'border-transparent hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <p className="truncate text-[11px] font-bold text-[var(--text-main)]">
                      {script.script_name}
                    </p>
                    <p className="mt-0.5 truncate text-[9px] font-bold text-[var(--text-muted)]">
                      {describeSchedule(script.schedule_config)} · {script.last_status ?? 'never_run'}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <div className="min-w-0 space-y-3">
        {!selected ? (
          <div className={`${CARD_CLASS} px-4 py-6 text-center`}>
            <CalendarClock size={22} className="mx-auto text-[var(--text-muted)]" />
            <p className="mt-2 text-xs text-[var(--text-muted)]">
              Select a freestyle script to manage its schedule.
            </p>
          </div>
        ) : (
          <>
            <div className={`${CARD_CLASS} space-y-2 p-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[var(--text-main)]">
                    {selected.script_name}
                  </p>
                  <p className={HINT_CLASS}>
                    {describeSchedule(schedule)} · edit code in Freestyle Script Editor
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button type="button" onClick={() => void handleRun()} disabled={isRunning} className={RUN_BUTTON}>
                    {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                    Run now
                  </button>
                  <button type="button" onClick={() => void handleSave()} disabled={isSaving} className={PRIMARY_BUTTON}>
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    Save schedule
                  </button>
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <label className={LABEL_CLASS}>Mode</label>
                  <select
                    value={schedule.schedule_type}
                    onChange={(event) =>
                      changeType(event.target.value as ScheduleConfig['schedule_type'])
                    }
                    className={INPUT_CLASS}
                  >
                    {SCHEDULE_TYPES.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
                {schedule.schedule_type === 'daily_at' && (
                  <div>
                    <label className={LABEL_CLASS}>Time (HH:MM)</label>
                    <input
                      value={schedule.daily_time}
                      onChange={(event) => patchSchedule({ daily_time: event.target.value })}
                      className={INPUT_CLASS}
                      placeholder="08:00"
                    />
                  </div>
                )}
                {schedule.schedule_type === 'specific_date' && (
                  <div>
                    <label className={LABEL_CLASS}>Run date</label>
                    <input
                      value={schedule.run_date ?? ''}
                      onChange={(event) => patchSchedule({ run_date: event.target.value })}
                      className={INPUT_CLASS}
                      placeholder="2026-12-31 08:00"
                    />
                  </div>
                )}
              </div>
              <p className={HINT_CLASS}>
                Schedules run server-side through APScheduler. Unsaved code is not scheduled — press
                Save in the editor first.
              </p>
            </div>

            <div className={`${CARD_CLASS} overflow-hidden`}>
              <div className="flex items-center justify-between border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-1.5">
                <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  Last Output
                </span>
                <button
                  type="button"
                  onClick={() => setOutput('')}
                  className="text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)]"
                >
                  Clear
                </button>
              </div>
              <div className="max-h-[320px] overflow-y-auto p-2 font-mono text-[10px] leading-relaxed">
                {output ? (
                  <pre className="whitespace-pre-wrap break-words text-[var(--text-main)]">{output}</pre>
                ) : (
                  <p className="text-[var(--text-muted)]">
                    No output yet. Scheduled runs write stdout here; failures include the traceback.
                  </p>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
