import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  Braces,
  ChevronDown,
  ChevronUp,
  Code2,
  Cpu,
  Database,
  FileText,
  Globe,
  Loader2,
  Play,
  Plus,
  Save,
  Target,
  Terminal,
  Trash2,
  Workflow,
} from 'lucide-react';
import * as api from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type {
  ConnectionItem,
  ProductionJobItem,
  PublishedModelItem,
} from '../../types/dataiki';

type ScriptTab = 'pre_map' | 'post_calc';
type ConsoleStatus = 'idle' | 'running' | 'success' | 'error';
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

const PRE_MAP_TEMPLATE = `import polars as pl

def pre_map(df: pl.DataFrame) -> pl.DataFrame:
    # print(df.schema)  # stdout appears in the Console Output drawer after Run
    return df
`;

const POST_CALC_TEMPLATE = `import polars as pl

def post_calc(pred_df: pl.DataFrame, raw_df: pl.DataFrame, dataiki) -> pl.DataFrame:
    # print(pred_df.head())  # stdout appears in the Console Output drawer after Run
    return pred_df
`;

const SCRIPT_META: Record<
  ScriptTab,
  { label: string; signature: string; icon: ReactNode }
> = {
  pre_map: {
    label: 'Pre-Mapper Script',
    signature: 'def pre_map(df: pl.DataFrame) -> pl.DataFrame:',
    icon: <Braces size={11} />,
  },
  post_calc: {
    label: 'Post-Calculator Script',
    signature: 'def post_calc(pred_df, raw_df, dataiki) -> pl.DataFrame:',
    icon: <Code2 size={11} />,
  },
};

function defaultJob(projectKey: string): ProductionJobItem {
  return {
    project_key: projectKey,
    job_name: 'daily_batch_prediction',
    model_id: '',
    model_name: '',
    source_config: {
      source_type: 'file',
      file_path: 'storage/uploads/dataset.csv',
    },
    pre_mapper_script: PRE_MAP_TEMPLATE,
    post_calc_script: POST_CALC_TEMPLATE,
    sink_config: {
      sink_type: 'file',
      file_format: 'parquet',
      output_dir: 'storage/exports',
    },
    schedule_config: {
      is_scheduled: false,
      schedule_type: 'unscheduled',
      interval_val: 60,
      daily_time: '08:00',
    },
    last_status: 'never_run',
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelNameOf(
  job: ProductionJobItem,
  models: PublishedModelItem[],
): string {
  if (job.model_name) return job.model_name;
  return models.find((model) => model.model_id === job.model_id)?.model_name ?? '';
}

function jobToForm(
  job: ProductionJobItem,
  models: PublishedModelItem[],
): ProductionJobItem {
  return { ...job, model_name: modelNameOf(job, models) };
}

function activeModelFor(
  models: PublishedModelItem[],
  projectKey: string,
  modelName: string,
): PublishedModelItem | undefined {
  return models.find(
    (model) =>
      model.project_key === projectKey &&
      model.model_name === modelName &&
      model.status === 'active',
  );
}

function statusLabel(status: ProductionJobItem['last_status']): string {
  if (status === 'completed') return 'completed';
  if (status === 'running') return 'running';
  if (status === 'warning') return 'warning';
  if (status === 'failed') return 'failed';
  return 'never run';
}

function statusColor(status: ProductionJobItem['last_status']): string {
  if (status === 'completed') return 'var(--accent-secondary)';
  if (status === 'running') return 'var(--accent-primary)';
  if (status === 'warning') return 'var(--accent-warning)';
  if (status === 'failed') return 'var(--accent-danger)';
  return 'var(--text-muted)';
}

function validateJob(
  form: ProductionJobItem,
  activeModel: PublishedModelItem | undefined,
): string | null {
  if (!form.job_name.trim()) return 'Job name is required.';
  if (!form.model_name) return 'Choose a model name (Active Model binding).';
  if (!activeModel) {
    return `No active model named '${form.model_name}'. Activate a version in Model Registry first.`;
  }

  const source = form.source_config;
  if (source.source_type === 'db') {
    if (!source.conn_id) return 'Source: choose a database connection.';
    if (!source.sql_query?.trim()) return 'Source: SQL query is required.';
  } else if (source.source_type === 'file') {
    if (!source.file_path?.trim()) return 'Source: file path is required.';
  } else if (!source.api_url?.trim()) {
    return 'Source: REST API URL is required.';
  }

  const preMap = form.pre_mapper_script.trim();
  if (preMap && !/def\s+pre_map\s*\(/.test(preMap)) {
    return "Pre-Mapper must define 'def pre_map(df: pl.DataFrame) -> pl.DataFrame:'.";
  }
  const postCalc = form.post_calc_script.trim();
  if (postCalc && !/def\s+post_calc\s*\(/.test(postCalc)) {
    return "Post-Calculator must define 'def post_calc(pred_df, raw_df, dataiki) -> pl.DataFrame:'.";
  }

  const sink = form.sink_config;
  if (sink.sink_type === 'db') {
    if (!sink.conn_id) return 'Target Sink: choose a database connection.';
    if (!sink.table_name?.trim()) return 'Target Sink: table name is required.';
  } else if (sink.sink_type === 'api') {
    if (!sink.api_url?.trim()) return 'Target Sink: REST API URL is required.';
  }

  return null;
}

function CarriageCard({
  step,
  title,
  icon,
  children,
}: {
  step: number;
  title: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-w-0 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] p-2 rounded-[var(--border-radius)]">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="flex h-4 w-4 shrink-0 items-center justify-center bg-[var(--accent-primary)] text-[9px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)]">
          {step}
        </span>
        <span className="shrink-0 text-[var(--text-muted)]">{icon}</span>
        <span className="break-words text-[10px] font-bold uppercase tracking-wide text-[var(--text-main)]">
          {title}
        </span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function JobScriptEditorTab() {
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const publishedModels = usePipelineStore((state) => state.publishedModels);
  const productionJobs = usePipelineStore((state) => state.productionJobs);
  const loadPublishedModels = usePipelineStore((state) => state.loadPublishedModels);
  const loadProductionJobs = usePipelineStore((state) => state.loadProductionJobs);
  const saveProductionJob = usePipelineStore((state) => state.saveProductionJob);
  const runProductionJobNow = usePipelineStore((state) => state.runProductionJobNow);
  const addToast = useUIStore((state) => state.addToast);
  const activeTheme = useUIStore((state) => state.activeTheme);

  const [form, setForm] = useState<ProductionJobItem>(() => defaultJob(''));
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [activeScript, setActiveScript] = useState<ScriptTab>('pre_map');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);

  const [consoleOpen, setConsoleOpen] = useState(true);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([]);
  const [consoleStatus, setConsoleStatus] = useState<ConsoleStatus>('idle');
  const [lastRows, setLastRows] = useState<number | null>(null);
  const consoleId = useRef(0);
  const consoleBodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setForm(defaultJob(projectKey));
    setConsoleLines([]);
    setConsoleStatus('idle');
    setLastRows(null);
    setActiveScript('pre_map');
  }, [projectKey]);

  useEffect(() => {
    if (!projectKey) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    void Promise.allSettled([
      loadPublishedModels(projectKey),
      loadProductionJobs(projectKey),
      api.fetchConnections(),
    ]).then(([modelResult, jobResult, connectionResult]) => {
      if (cancelled) return;

      const failures: string[] = [];
      if (modelResult.status === 'rejected') failures.push(messageOf(modelResult.reason));
      if (jobResult.status === 'rejected') failures.push(messageOf(jobResult.reason));
      if (connectionResult.status === 'rejected') {
        failures.push(messageOf(connectionResult.reason));
      }

      if (connectionResult.status === 'fulfilled') {
        setConnections(
          connectionResult.value.filter(
            (connection) => !connection.name.startsWith('__secret__'),
          ),
        );
      }

      const models =
        modelResult.status === 'fulfilled' ? modelResult.value : [];
      const jobs = jobResult.status === 'fulfilled' ? jobResult.value : [];

      if (jobs.length > 0) {
        setForm((current) =>
          current.job_script_id ? current : jobToForm(jobs[0], models),
        );
      }

      if (failures.length > 0) {
        const detail = failures.join(' · ');
        setLoadError(detail);
        addToast('error', `Failed to load Job Editor data: ${detail}`);
      }
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [addToast, loadProductionJobs, loadPublishedModels, projectKey]);

  useEffect(() => {
    const element = consoleBodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [consoleLines, consoleOpen]);

  const modelNames = useMemo(
    () =>
      Array.from(
        new Set(
          publishedModels
            .filter(
              (model) =>
                model.project_key === projectKey && model.status === 'active',
            )
            .map((model) => model.model_name),
        ),
      ),
    [publishedModels, projectKey],
  );

  const selectedModel = form.model_name
    ? activeModelFor(publishedModels, projectKey, form.model_name)
    : undefined;

  const projectJobs = useMemo(
    () => productionJobs.filter((job) => job.project_key === projectKey),
    [productionJobs, projectKey],
  );

  const dbConnections = useMemo(
    () => connections.filter((connection) => connection.conn_type !== 'rest_api'),
    [connections],
  );
  const apiConnections = useMemo(
    () => connections.filter((connection) => connection.conn_type === 'rest_api'),
    [connections],
  );

  const patchForm = (patch: Partial<ProductionJobItem>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const patchSource = (patch: Partial<ProductionJobItem['source_config']>) => {
    setForm((current) => ({
      ...current,
      source_config: { ...current.source_config, ...patch },
    }));
  };

  const patchSink = (patch: Partial<ProductionJobItem['sink_config']>) => {
    setForm((current) => ({
      ...current,
      sink_config: { ...current.sink_config, ...patch },
    }));
  };

  const resetConsole = (line?: ConsoleLine) => {
    consoleId.current = 1;
    setConsoleLines(line ? [line] : []);
    setLastRows(null);
  };

  const appendConsole = (kind: ConsoleKind, text: string) => {
    setConsoleLines((current) => [
      ...current,
      { id: consoleId.current++, kind, text },
    ]);
  };

  const selectJob = (jobId: string) => {
    const job = projectJobs.find((item) => item.job_script_id === jobId);
    if (!job) return;
    setForm(jobToForm(job, publishedModels));
    resetConsole();
    setConsoleStatus('idle');
  };

  const newJob = () => {
    setForm(defaultJob(projectKey));
    resetConsole();
    setConsoleStatus('idle');
    setActiveScript('pre_map');
  };

  const focusScript = (tab: ScriptTab) => {
    setActiveScript(tab);
    setConsoleOpen(false);
  };

  const handleSave = async () => {
    const validation = validateJob(form, selectedModel);
    if (validation) {
      addToast('warning', validation);
      return;
    }

    setIsSaving(true);
    try {
      const saved = await saveProductionJob({
        ...form,
        project_key: projectKey,
        model_name: form.model_name,
        model_id: selectedModel?.model_id ?? form.model_id,
      });
      setForm(saved);
      addToast('success', `Job '${saved.job_name}' saved.`);
    } catch (error) {
      addToast('error', `Save failed: ${messageOf(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRun = async () => {
    const validation = validateJob(form, selectedModel);
    if (validation) {
      setConsoleOpen(true);
      setConsoleStatus('error');
      resetConsole({
        id: 0,
        kind: 'error',
        text: `✖ ${validation}`,
      });
      addToast('warning', validation);
      return;
    }

    setConsoleOpen(true);
    setConsoleStatus('running');
    resetConsole({
      id: 0,
      kind: 'info',
      text: `▶ ${new Date().toLocaleString()} — Running '${form.job_name}'…`,
    });
    setIsRunning(true);

    try {
      const saved = await saveProductionJob({
        ...form,
        project_key: projectKey,
        model_name: form.model_name,
        model_id: selectedModel?.model_id ?? form.model_id,
      });
      setForm(saved);

      if (!saved.job_script_id) {
        throw new Error('Backend did not return a batch job id.');
      }

      const result = await runProductionJobNow(saved.job_script_id);
      setLastRows(result.rows_processed);
      setConsoleStatus('success');
      appendConsole(
        'success',
        `✔ Rows processed to Target Sink: ${result.rows_processed}`,
      );
      appendConsole('stdout', `Target Sink: ${result.sink_destination}`);
      appendConsole('stdout', `Executed at: ${result.executed_at}`);
      addToast(
        'success',
        `Job '${saved.job_name}' processed ${result.rows_processed} rows.`,
      );
    } catch (error) {
      const detail = messageOf(error);
      setConsoleStatus('error');
      appendConsole('error', `✖ ${detail}`);
      addToast('error', `Job run failed: ${detail}`);
    } finally {
      setIsRunning(false);
    }
  };

  const editorTheme = activeTheme === 'midnight' ? 'vs-dark' : 'light';
  const scriptValue =
    activeScript === 'pre_map'
      ? form.pre_mapper_script
      : form.post_calc_script;
  const scriptMeta = SCRIPT_META[activeScript];
  const source = form.source_config;
  const sink = form.sink_config;

  const consoleColor: Record<ConsoleKind, string> = {
    info: 'text-[var(--accent-primary)]',
    success: 'text-[var(--accent-secondary)]',
    error: 'text-[var(--accent-danger)]',
    stdout: 'text-[var(--accent-secondary)]',
  };

  return (
    <div className="space-y-3">
      <header className={`${CARD_CLASS} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <div className="flex min-w-0 items-start gap-2">
          <Workflow size={18} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
              Job Script Editor
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              5-carriage batch runner · pre_map → Active Model → post_calc → Target Sink
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {isLoading && (
            <Loader2 size={13} className="animate-spin text-[var(--text-muted)]" />
          )}
          <span
            className="inline-flex items-center border-[length:var(--border-width)] px-2 py-1 text-[9px] font-bold uppercase tracking-widest rounded-[var(--border-radius)]"
            style={{
              borderColor: statusColor(form.last_status),
              color: statusColor(form.last_status),
            }}
          >
            {statusLabel(form.last_status)}
          </span>
          <label className="flex min-w-0 items-center gap-1.5">
            <span className={LABEL_CLASS}>Job</span>
            <select
              value={form.job_script_id ?? ''}
              onChange={(event) =>
                event.target.value ? selectJob(event.target.value) : newJob()
              }
              className={`${INPUT_CLASS} min-w-[160px] max-w-[260px]`}
            >
              <option value="">+ New unsaved job</option>
              {projectJobs.map((job) => (
                <option key={job.job_script_id} value={job.job_script_id}>
                  {job.job_name} · {statusLabel(job.last_status)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={newJob}
            className={SECONDARY_BUTTON}
            title="Create a new batch job"
          >
            <Plus size={12} />
            New Job
          </button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-card)] px-3 py-2 rounded-[var(--border-radius)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
          <p className="break-words text-xs text-[var(--text-main)]">{loadError}</p>
        </div>
      )}

      {!projectKey && (
        <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-warning)] bg-[var(--bg-card)] px-3 py-2 rounded-[var(--border-radius)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-warning)]" />
          <p className="text-xs text-[var(--text-main)]">
            Select a project before configuring a batch job.
          </p>
        </div>
      )}

      <section className={`${CARD_CLASS} p-2`}>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          <CarriageCard step={1} title="Source Config" icon={<Database size={11} />}>
            <label className="block">
              <span className={LABEL_CLASS}>Source Type</span>
              <select
                value={source.source_type}
                onChange={(event) =>
                  patchSource({
                    source_type: event.target.value as 'db' | 'file' | 'api',
                  })
                }
                className={INPUT_CLASS}
              >
                <option value="db">DB Query</option>
                <option value="file">Local File</option>
                <option value="api">REST API</option>
              </select>
            </label>

            {source.source_type === 'db' && (
              <>
                <label className="block">
                  <span className={LABEL_CLASS}>Connection</span>
                  <select
                    value={source.conn_id ?? ''}
                    onChange={(event) => patchSource({ conn_id: event.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="">Select connection</option>
                    {dbConnections.map((connection) => (
                      <option key={connection.conn_id} value={connection.conn_id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={LABEL_CLASS}>SQL Query</span>
                  <textarea
                    value={source.sql_query ?? ''}
                    onChange={(event) => patchSource({ sql_query: event.target.value })}
                    className={`${INPUT_CLASS} min-h-[52px] resize-y font-mono`}
                    placeholder="SELECT * FROM raw_customers"
                  />
                </label>
              </>
            )}

            {source.source_type === 'file' && (
              <label className="block">
                <span className={LABEL_CLASS}>File Path</span>
                <input
                  value={source.file_path ?? ''}
                  onChange={(event) => patchSource({ file_path: event.target.value })}
                  className={INPUT_CLASS}
                  placeholder="storage/uploads/dataset.csv"
                />
              </label>
            )}

            {source.source_type === 'api' && (
              <>
                <label className="block">
                  <span className={LABEL_CLASS}>REST URL</span>
                  <input
                    value={source.api_url ?? ''}
                    onChange={(event) => patchSource({ api_url: event.target.value })}
                    className={INPUT_CLASS}
                    placeholder="https://api.example.com/rows"
                  />
                </label>
                <label className="block">
                  <span className={LABEL_CLASS}>Connection (headers)</span>
                  <select
                    value={source.conn_id ?? ''}
                    onChange={(event) => patchSource({ conn_id: event.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="">Optional</option>
                    {apiConnections.map((connection) => (
                      <option key={connection.conn_id} value={connection.conn_id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </CarriageCard>

          <CarriageCard step={2} title="Pre-Mapper" icon={<Braces size={11} />}>
            <p className="break-words font-mono text-[10px] text-[var(--text-main)]">
              def pre_map(df: pl.DataFrame)
            </p>
            <p className={HINT_CLASS}>
              {form.pre_mapper_script.split('\n').length} lines · runs before prediction
            </p>
            <button
              type="button"
              onClick={() => focusScript('pre_map')}
              className={`${SECONDARY_BUTTON} w-full`}
            >
              <Code2 size={11} />
              Edit pre_map
            </button>
          </CarriageCard>

          <CarriageCard step={3} title="Active Model" icon={<Cpu size={11} />}>
            <label className="block">
              <span className={LABEL_CLASS}>Model Name</span>
              <select
                value={form.model_name ?? ''}
                onChange={(event) => patchForm({ model_name: event.target.value })}
                className={INPUT_CLASS}
                disabled={modelNames.length === 0}
              >
                <option value="">
                  {modelNames.length === 0 ? 'No active model' : 'Select model'}
                </option>
                {modelNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {form.model_name && !modelNames.includes(form.model_name) && (
                  <option value={form.model_name}>
                    {form.model_name} (no active version)
                  </option>
                )}
              </select>
            </label>
            <p className={selectedModel ? HINT_CLASS : 'break-words text-[10px] text-[var(--accent-warning)]'}>
              {selectedModel
                ? `Auto-bound to v${selectedModel.version} (active).`
                : form.model_name
                  ? 'Activate this model name in Model Registry first.'
                  : 'Pick a model name; the Active version is resolved automatically.'}
            </p>
          </CarriageCard>

          <CarriageCard step={4} title="Post-Calculator" icon={<Cpu size={11} />}>
            <p className="break-words font-mono text-[10px] text-[var(--text-main)]">
              def post_calc(pred_df, raw_df, dataiki)
            </p>
            <p className={HINT_CLASS}>
              {form.post_calc_script.split('\n').length} lines · runs after prediction
            </p>
            <button
              type="button"
              onClick={() => focusScript('post_calc')}
              className={`${SECONDARY_BUTTON} w-full`}
            >
              <Code2 size={11} />
              Edit post_calc
            </button>
          </CarriageCard>

          <CarriageCard step={5} title="Target Sink" icon={<Target size={11} />}>
            <label className="block">
              <span className={LABEL_CLASS}>Sink Type</span>
              <select
                value={sink.sink_type}
                onChange={(event) =>
                  patchSink({
                    sink_type: event.target.value as 'db' | 'api' | 'file',
                  })
                }
                className={INPUT_CLASS}
              >
                <option value="db">DB Table</option>
                <option value="api">External API</option>
                <option value="file">File Export</option>
              </select>
            </label>

            {sink.sink_type === 'db' && (
              <>
                <label className="block">
                  <span className={LABEL_CLASS}>Connection</span>
                  <select
                    value={sink.conn_id ?? ''}
                    onChange={(event) => patchSink({ conn_id: event.target.value })}
                    className={INPUT_CLASS}
                  >
                    <option value="">Select connection</option>
                    {dbConnections.map((connection) => (
                      <option key={connection.conn_id} value={connection.conn_id}>
                        {connection.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={LABEL_CLASS}>Table Name</span>
                  <input
                    value={sink.table_name ?? ''}
                    onChange={(event) => patchSink({ table_name: event.target.value })}
                    className={INPUT_CLASS}
                    placeholder="batch_predictions"
                  />
                </label>
                <label className="block">
                  <span className={LABEL_CLASS}>Write Mode</span>
                  <select
                    value={sink.write_mode ?? 'append'}
                    onChange={(event) =>
                      patchSink({
                        write_mode: event.target.value as 'append' | 'replace' | 'upsert',
                      })
                    }
                    className={INPUT_CLASS}
                  >
                    <option value="append">Insert / Append</option>
                    <option value="replace">Replace</option>
                    <option value="upsert">Upsert</option>
                  </select>
                </label>
              </>
            )}

            {sink.sink_type === 'api' && (
              <label className="block">
                <span className={LABEL_CLASS}>POST URL</span>
                <input
                  value={sink.api_url ?? ''}
                  onChange={(event) => patchSink({ api_url: event.target.value })}
                  className={INPUT_CLASS}
                  placeholder="https://api.example.com/ingest"
                />
              </label>
            )}

            {sink.sink_type === 'file' && (
              <>
                <label className="block">
                  <span className={LABEL_CLASS}>Format</span>
                  <select
                    value={sink.file_format ?? 'parquet'}
                    onChange={(event) =>
                      patchSink({
                        file_format: event.target.value as 'xlsx' | 'csv' | 'parquet',
                      })
                    }
                    className={INPUT_CLASS}
                  >
                    <option value="xlsx">Excel (.xlsx)</option>
                    <option value="csv">CSV (.csv)</option>
                    <option value="parquet">Parquet (.parquet)</option>
                  </select>
                </label>
                <label className="block">
                  <span className={LABEL_CLASS}>Output Directory</span>
                  <input
                    value={sink.output_dir ?? ''}
                    onChange={(event) => patchSink({ output_dir: event.target.value })}
                    className={INPUT_CLASS}
                    placeholder="storage/exports"
                  />
                </label>
              </>
            )}
          </CarriageCard>
        </div>
      </section>

      <section className={`${CARD_CLASS} flex min-w-0 flex-col overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-1.5 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2.5 py-2">
          <label className="flex min-w-[150px] flex-1 items-center gap-1.5">
            <span className={LABEL_CLASS}>Job Name</span>
            <input
              value={form.job_name}
              onChange={(event) => patchForm({ job_name: event.target.value })}
              className={INPUT_CLASS}
              placeholder="daily_batch_prediction"
              autoComplete="off"
            />
          </label>

          <div className="flex overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
            {(['pre_map', 'post_calc'] as ScriptTab[]).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveScript(tab)}
                className={`flex min-w-0 items-center gap-1 border-r-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1.5 text-[10px] font-bold transition-colors last:border-r-0 ${
                  activeScript === tab
                    ? 'bg-[var(--bg-card)] text-[var(--accent-primary)]'
                    : 'bg-[var(--bg-input)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                <Braces size={11} className="shrink-0" />
                <span className="break-words">{tab}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={isRunning || isLoading || !projectKey}
            className={RUN_BUTTON}
          >
            {isRunning ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Play size={12} />
            )}
            {isRunning ? 'Running…' : '▶️ Run'}
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={isSaving || isLoading || !projectKey}
            className={PRIMARY_BUTTON}
          >
            {isSaving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            {isSaving ? 'Saving…' : '💾 Save Job'}
          </button>
          <button
            type="button"
            onClick={() => setConsoleOpen((current) => !current)}
            className={SECONDARY_BUTTON}
            aria-expanded={consoleOpen}
          >
            <Terminal size={12} />
            Console
            {consoleOpen ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5">
          <span className="flex min-w-0 items-center gap-1.5 break-words font-mono text-[10px] text-[var(--text-main)]">
            {scriptMeta.icon}
            {scriptMeta.signature}
          </span>
          <span className={HINT_CLASS}>
            {scriptMeta.label} · print() output is shown in Console Output after Run
          </span>
        </div>

        <div className="relative h-[560px] overflow-hidden bg-[var(--bg-input)]">
          <Editor
            height="100%"
            language="python"
            value={scriptValue}
            onChange={(value) =>
              patchForm(
                activeScript === 'pre_map'
                  ? { pre_mapper_script: value ?? '' }
                  : { post_calc_script: value ?? '' },
              )
            }
            theme={editorTheme}
            loading={
              <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
                <Loader2 size={14} className="animate-spin" />
                Loading Python editor…
              </div>
            }
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              automaticLayout: true,
              tabSize: 4,
            }}
          />

          <div
            aria-hidden={!consoleOpen}
            className={`absolute inset-x-0 bottom-0 z-10 flex h-[30%] flex-col border-t-[length:var(--border-width)] border-[var(--accent-primary)] bg-black font-mono shadow-[var(--shadow-card)] transition-transform duration-300 ${
              consoleOpen ? 'translate-y-0' : 'translate-y-full'
            }`}
          >
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-1.5 border-b border-[var(--accent-primary)] px-2.5 py-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Terminal size={11} className="shrink-0 text-[var(--accent-secondary)]" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--accent-secondary)]">
                  Console Output
                </span>
                <span
                  className={`border px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-widest ${
                    consoleStatus === 'error'
                      ? 'border-[var(--accent-danger)] text-[var(--accent-danger)]'
                      : consoleStatus === 'success'
                        ? 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]'
                        : consoleStatus === 'running'
                          ? 'border-[var(--accent-warning)] text-[var(--accent-warning)]'
                          : 'border-[var(--text-muted)] text-[var(--text-muted)]'
                  }`}
                >
                  {consoleStatus}
                </span>
                {lastRows !== null && (
                  <span className="text-[9px] text-[var(--accent-secondary)]">
                    {lastRows.toLocaleString()} rows → Target Sink
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {consoleLines.length > 0 && (
                  <button
                    type="button"
                    onClick={() => resetConsole()}
                    className="inline-flex items-center gap-1 border border-[var(--text-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--text-muted)] transition-colors hover:border-[var(--accent-secondary)] hover:text-[var(--accent-secondary)]"
                  >
                    <Trash2 size={9} />
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setConsoleOpen(false)}
                  className="inline-flex items-center border border-[var(--text-muted)] px-1.5 py-0.5 text-[var(--text-muted)] transition-colors hover:border-[var(--accent-secondary)] hover:text-[var(--accent-secondary)]"
                  aria-label="Close console output"
                >
                  <ChevronDown size={11} />
                </button>
              </div>
            </div>

            <div
              ref={consoleBodyRef}
              className="min-h-0 flex-1 overflow-auto px-2.5 py-1.5 text-[11px] leading-relaxed"
            >
              {consoleLines.length === 0 ? (
                <p className="text-[var(--text-muted)]">
                  Press ▶️ Run to execute the job. print() output, rows processed to the
                  Target Sink, and error tracebacks appear here.
                </p>
              ) : (
                consoleLines.map((line) => (
                  <pre
                    key={line.id}
                    className={`break-words whitespace-pre-wrap ${consoleColor[line.kind]}`}
                  >
                    {line.text}
                  </pre>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      <p className={HINT_CLASS}>
        Run saves the current definition first, then executes the backend batch job.
        {form.job_script_id
          ? ' Existing jobs keep their backend definition; editing an existing job updates this UI only.'
          : ' A new job row is created on the first save/run.'}
      </p>

      <div className="flex flex-wrap items-center gap-1.5">
        <FileText size={12} className="shrink-0 text-[var(--text-muted)]" />
        <span className={HINT_CLASS}>
          Carriage order: Source → pre_map → Active Model → post_calc → Target Sink
        </span>
        <Globe size={12} className="ml-2 shrink-0 text-[var(--text-muted)]" />
        <span className={HINT_CLASS}>
          External API sinks receive the full result set as JSON records.
        </span>
      </div>
    </div>
  );
}
