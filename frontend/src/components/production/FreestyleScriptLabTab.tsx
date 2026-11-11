import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  Code2,
  Loader2,
  Play,
  Plus,
  Save,
  Terminal,
  Trash2,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { FreestyleScriptItem } from '../../types/dataiki';

type ConsoleKind = 'info' | 'success' | 'error' | 'stdout';

interface ConsoleLine {
  id: number;
  kind: ConsoleKind;
  text: string;
}

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';
const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1 text-[11px] text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50';
const LABEL_CLASS =
  'mb-0.5 block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const HINT_CLASS = 'text-[10px] leading-relaxed text-[var(--text-muted)]';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
const RUN_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-secondary)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';

const TEMPLATE = `import polars as pl

# dataiki.model() loads the active published model of this project.
# Pick another published version by name: dataiki.model("churn_model", version=3)
model = dataiki.model()

# Reference sample captured at training time
df = model.get_training_data().head(20)

result = dataiki.predict_frame(df)   # adds prediction_<target> (+ probability)
print(result)

# Other helpers:
#   dataiki.models()                                  -> list published versions
#   dataiki.vault.get_connection("warehouse").query_df("SELECT ...")
`;

function defaultScript(projectKey: string): FreestyleScriptItem {
  return {
    project_key: projectKey,
    script_name: 'my_script',
    code: TEMPLATE,
    schedule_config: {
      is_scheduled: false,
      schedule_type: 'unscheduled',
      interval_val: 1,
      daily_time: '08:00',
    },
    last_status: 'never_run',
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusColor(status?: FreestyleScriptItem['last_status']): string {
  if (status === 'success') return 'text-[var(--accent-secondary)]';
  if (status === 'failed') return 'text-[var(--accent-danger)]';
  return 'text-[var(--text-muted)]';
}

export function FreestyleScriptLabTab() {
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const scripts = usePipelineStore((state) => state.freestyleScripts);
  const loadFreestyleScripts = usePipelineStore((state) => state.loadFreestyleScripts);
  const saveFreestyleScript = usePipelineStore((state) => state.saveFreestyleScript);
  const deleteFreestyleScript = usePipelineStore((state) => state.deleteFreestyleScript);
  const runFreestyleCode = usePipelineStore((state) => state.runFreestyleCode);
  const addToast = useUIStore((state) => state.addToast);
  const activeTheme = useUIStore((state) => state.activeTheme);

  const [form, setForm] = useState<FreestyleScriptItem>(() => defaultScript(''));
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const consoleId = useRef(0);

  useEffect(() => {
    setForm(defaultScript(projectKey));
    setConsoleLines([]);
  }, [projectKey]);

  useEffect(() => {
    if (!projectKey) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    void loadFreestyleScripts(projectKey)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded.length > 0) setForm(loaded[0]);
        setIsLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        const detail = messageOf(error);
        setLoadError(detail);
        addToast('error', `Failed to load scripts: ${detail}`);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [addToast, loadFreestyleScripts, projectKey]);

  const patchForm = (patch: Partial<FreestyleScriptItem>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const resetConsole = (line?: ConsoleLine) => {
    consoleId.current = 1;
    setConsoleLines(line ? [line] : []);
  };

  const appendConsole = (kind: ConsoleKind, text: string) => {
    setConsoleLines((current) => [...current, { id: consoleId.current++, kind, text }]);
  };

  const selectScript = (scriptId: string) => {
    const script = scripts.find((item) => item.script_id === scriptId);
    if (!script) return;
    setForm(script);
    resetConsole();
  };

  const newScript = () => {
    setForm(defaultScript(projectKey));
    resetConsole();
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await saveFreestyleScript(form);
      setForm(saved);
      addToast('success', `Script '${saved.script_name}' saved.`);
    } catch (error) {
      addToast('error', `Save failed: ${messageOf(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!form.script_id) {
      addToast('warning', 'Save the script before deleting it.');
      return;
    }
    if (!window.confirm(`Delete script '${form.script_name}'? This cannot be undone.`)) return;
    try {
      await deleteFreestyleScript(form.script_id);
      const remaining = scripts.filter((item) => item.script_id !== form.script_id);
      setForm(remaining.length > 0 ? remaining[0] : defaultScript(projectKey));
      resetConsole();
      addToast('success', 'Script deleted.');
    } catch (error) {
      addToast('error', `Delete failed: ${messageOf(error)}`);
    }
  };

  const handleRun = async () => {
    if (!projectKey) return;
    resetConsole({ id: 0, kind: 'info', text: `▶ ${new Date().toLocaleString()} — running…` });
    setIsRunning(true);
    try {
      const result = await runFreestyleCode(form.code);
      if (result.stdout.trim()) appendConsole('stdout', result.stdout.trimEnd());
      if (result.result_preview) appendConsole('info', `[result] ${result.result_preview}`);
      if (result.status === 'success') {
        appendConsole('success', `✔ Finished in ${result.duration_ms} ms`);
      } else {
        appendConsole('error', result.error.trimEnd() || 'Script failed.');
        addToast('error', 'Script failed. See Console Output.');
      }
    } catch (error) {
      appendConsole('error', `✖ ${messageOf(error)}`);
      addToast('error', `Run failed: ${messageOf(error)}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleScheduleHint = () => {
    if (!form.script_id) {
      addToast('warning', 'Save the script first, then schedule it in Scheduler & Logs.');
      return;
    }
    addToast(
      'info',
      'Open Production Gateway → Scheduler & Logs → Freestyle Scripts to set the schedule.',
    );
  };

  const consoleColor: Record<ConsoleKind, string> = {
    info: 'text-[var(--accent-primary)]',
    success: 'text-[var(--accent-secondary)]',
    error: 'text-[var(--accent-danger)]',
    stdout: 'text-[var(--text-main)]',
  };
  const editorTheme = activeTheme === 'midnight' ? 'vs-dark' : 'light';

  return (
    <div className="space-y-3">
      <header className={`${CARD_CLASS} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <div className="flex min-w-0 items-start gap-2">
          <Terminal size={18} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
              Freestyle Script Editor
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Free-form Python · dataiki SDK · schedule from Scheduler &amp; Logs
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {isLoading && <Loader2 size={13} className="animate-spin text-[var(--text-muted)]" />}
          <span className="inline-flex items-center border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            {scripts.length} script{scripts.length === 1 ? '' : 's'}
          </span>
        </div>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-card)] px-3 py-2 rounded-[var(--border-radius)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
          <p className="break-words text-xs text-[var(--text-main)]">{loadError}</p>
        </div>
      )}

      <div className="grid items-start gap-3 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className={`${CARD_CLASS} flex min-w-0 flex-col overflow-hidden`}>
          <div className="border-b-[length:var(--border-width)] border-[var(--border-color)] p-2">
            <button type="button" onClick={newScript} disabled={!projectKey} className={`${PRIMARY_BUTTON} w-full py-2`}>
              <Plus size={13} />
              + New Script
            </button>
          </div>
          <div className="max-h-[600px] overflow-y-auto p-1.5">
            {scripts.length === 0 ? (
              <p className="px-1.5 py-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
                No scripts yet. Write one on the right and press Save.
              </p>
            ) : (
              <ul className="space-y-1">
                {scripts.map((script) => (
                  <li key={script.script_id}>
                    <button
                      type="button"
                      onClick={() => selectScript(script.script_id ?? '')}
                      className={`w-full border-[length:var(--border-width)] px-2 py-1.5 text-left rounded-[var(--border-radius)] transition-colors ${
                        form.script_id === script.script_id
                          ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)]'
                          : 'border-transparent hover:bg-[var(--bg-hover)]'
                      }`}
                    >
                      <p className="truncate text-[11px] font-bold text-[var(--text-main)]">
                        {script.script_name}
                      </p>
                      <p className={`mt-0.5 truncate text-[9px] font-bold ${statusColor(script.last_status)}`}>
                        {script.last_status ?? 'never_run'}
                        {script.schedule_config.is_scheduled ? ' · scheduled' : ''}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className="min-w-0 space-y-3">
          <div className={`${CARD_CLASS} space-y-2 p-3`}>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <label className={LABEL_CLASS} htmlFor="script-name">
                  Script name
                </label>
                <input
                  id="script-name"
                  value={form.script_name}
                  onChange={(event) => patchForm({ script_name: event.target.value })}
                  className={INPUT_CLASS}
                  placeholder="daily_customer_scoring"
                />
              </div>
              <button type="button" onClick={handleRun} disabled={!projectKey || isRunning} className={RUN_BUTTON}>
                {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
                Run
              </button>
              <button type="button" onClick={() => void handleSave()} disabled={isSaving} className={PRIMARY_BUTTON}>
                {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                Save
              </button>
              <button type="button" onClick={() => void handleDelete()} disabled={!form.script_id} className={SECONDARY_BUTTON}>
                <Trash2 size={13} />
                Delete
              </button>
              <button type="button" onClick={handleScheduleHint} className={SECONDARY_BUTTON}>
                Schedule…
              </button>
            </div>
            <p className={HINT_CLASS}>
              <Code2 size={10} className="mr-1 inline" />
              Inject: <span className="font-mono">dataiki</span>, <span className="font-mono">pl</span>,{' '}
              <span className="font-mono">np</span>, <span className="font-mono">duckdb</span>,{' '}
              <span className="font-mono">json</span>. Set <span className="font-mono">result</span> to preview a value.
              Schedules live in Scheduler &amp; Logs.
            </p>
          </div>

          <div className={`${CARD_CLASS} overflow-hidden`}>
            <div className="h-[320px]">
              <Editor
                height="100%"
                language="python"
                theme={editorTheme}
                value={form.code}
                onChange={(value) => patchForm({ code: value ?? '' })}
                options={{
                  fontSize: 12,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  tabSize: 4,
                }}
              />
            </div>
          </div>

          <div className={`${CARD_CLASS} overflow-hidden`}>
            <div className="flex items-center justify-between border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-1.5">
              <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                Console Output
              </span>
              <button type="button" onClick={() => resetConsole()} className="text-[9px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)]">
                Clear
              </button>
            </div>
            <div className="max-h-[220px] overflow-y-auto p-2 font-mono text-[10px] leading-relaxed">
              {consoleLines.length === 0 ? (
                <p className="text-[var(--text-muted)]">Run the script to see stdout and errors.</p>
              ) : (
                consoleLines.map((line) => (
                  <pre key={line.id} className={`whitespace-pre-wrap break-words ${consoleColor[line.kind]}`}>
                    {line.text}
                  </pre>
                ))
              )}
            </div>
          </div>

          {form.script_id && (
            <p className={HINT_CLASS}>
              Last run: {form.last_run_at ?? 'never'} · status: {form.last_status ?? 'never_run'}
              {form.schedule_config.is_scheduled
                ? ` · schedule: ${form.schedule_config.schedule_type}${
                  form.schedule_config.daily_time ? ` ${form.schedule_config.daily_time}` : ''
                }`
                : ' · unscheduled'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
