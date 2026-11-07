import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  Code2,
  Database,
  Eye,
  EyeOff,
  History,
  Loader2,
  Mail,
  Play,
  Plus,
  Save,
  Settings2,
  Target,
  Trash2,
} from 'lucide-react';
import * as api from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type {
  ConnectionItem,
  ProductionJobItem,
  PublishedModelItem,
  SmtpAlertConfig,
} from '../../types/dataiki';

type ScheduleTab = 'setting' | 'script' | 'log';
type ScriptTab = 'pre_map' | 'post_calc';
type OutputKind = 'info' | 'success' | 'error';
type ClearRange = 1 | 3 | 12;

interface OutputLine {
  id: number;
  kind: OutputKind;
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
    # print(df.schema)  # stdout appears in the Script Output panel after Test Run
    return df
`;

const POST_CALC_TEMPLATE = `import polars as pl

def post_calc(pred_df: pl.DataFrame, raw_df: pl.DataFrame, dataiki) -> pl.DataFrame:
    # print(pred_df.head())  # stdout appears in the Script Output panel after Test Run
    return pred_df
`;

const DEFAULT_BODY = `Schedule '{schedule_name}' failed at {timestamp}.

Error:
{error_message}`;

const CLEAR_RANGES: Array<{ months: ClearRange; label: string }> = [
  { months: 1, label: '> 1 Bulan' },
  { months: 3, label: '> 3 Bulan' },
  { months: 12, label: '> 1 Tahun' },
];

function defaultSmtp(): SmtpAlertConfig {
  return {
    enabled: false,
    smtp_host: '',
    smtp_port: 587,
    smtp_user: '',
    smtp_password_secret_key: '',
    mail_to: '',
    mail_cc: '',
    subject: '[ALERT] Dataiki Schedule Failed: {schedule_name}',
    body_message: DEFAULT_BODY,
  };
}

function defaultScheduleJob(projectKey: string): ProductionJobItem {
  return {
    project_key: projectKey,
    job_name: 'scheduled_batch_prediction',
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
      interval_val: 1,
      daily_time: '08:00',
      run_date: '',
      smtp_alert: defaultSmtp(),
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
  return {
    ...job,
    model_name: modelNameOf(job, models),
    schedule_config: {
      ...job.schedule_config,
      smtp_alert: { ...defaultSmtp(), ...(job.schedule_config.smtp_alert ?? {}) },
    },
  };
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

function formatDateTime(value?: string): string {
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

function describeSchedule(job: ProductionJobItem): string {
  const schedule = job.schedule_config;
  if (schedule.schedule_type === 'unscheduled') return 'Unscheduled';
  const suffix = schedule.is_scheduled ? '' : ' · disabled';
  if (schedule.schedule_type === 'every_minute') {
    return `Every ${schedule.interval_val || 1} minute(s)${suffix}`;
  }
  if (schedule.schedule_type === 'every_hour') {
    return `Every ${schedule.interval_val || 1} hour(s)${suffix}`;
  }
  if (schedule.schedule_type === 'daily_at') {
    return `Daily at ${schedule.daily_time || '--:--'}${suffix}`;
  }
  return `Once at ${schedule.run_date || '—'}${suffix}`;
}

function scheduleBadge(job: ProductionJobItem): { text: string; color: string } {
  const status = job.last_status;
  if (status === 'running') return { text: 'Running...', color: 'var(--accent-primary)' };
  if (status === 'completed') return { text: '🟢', color: 'var(--accent-secondary)' };
  if (status === 'warning') return { text: '🟡', color: 'var(--accent-warning)' };
  if (status === 'failed') return { text: '🔴', color: 'var(--accent-danger)' };
  return { text: '—', color: 'var(--text-muted)' };
}

function validateSchedule(
  form: ProductionJobItem,
  activeModel: PublishedModelItem | undefined,
): string | null {
  if (!form.job_name.trim()) return 'Schedule name is required.';
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

  const schedule = form.schedule_config;
  if (schedule.is_scheduled) {
    if (schedule.schedule_type === 'unscheduled') {
      return 'Choose a schedule frequency or disable the schedule.';
    }
    if (
      (schedule.schedule_type === 'every_minute' ||
        schedule.schedule_type === 'every_hour') &&
      (!Number.isFinite(schedule.interval_val) || schedule.interval_val < 1)
    ) {
      return 'Interval must be at least 1.';
    }
    if (
      schedule.schedule_type === 'daily_at' &&
      !/^\d{2}:\d{2}$/.test(schedule.daily_time)
    ) {
      return 'Daily time must use HH:MM.';
    }
    if (schedule.schedule_type === 'specific_date' && !schedule.run_date) {
      return 'Specific date & time is required.';
    }
  }

  const smtp = form.schedule_config.smtp_alert;
  if (smtp?.enabled) {
    if (!smtp.smtp_host.trim()) return 'SMTP Alert: SMTP host is required.';
    if (!Number.isFinite(smtp.smtp_port) || smtp.smtp_port <= 0) {
      return 'SMTP Alert: SMTP port is invalid.';
    }
    if (!smtp.mail_to.trim()) return 'SMTP Alert: Mail To is required.';
  }

  return null;
}

function SettingSection({
  title,
  icon,
  actions,
  children,
}: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] rounded-[var(--border-radius)]">
      <header className="flex flex-wrap items-center justify-between gap-1.5 border-b-[length:var(--border-width)] border-[var(--border-color)] px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0 text-[var(--accent-primary)]">{icon}</span>
          <h3 className="break-words text-[10px] font-bold uppercase tracking-widest text-[var(--text-main)]">
            {title}
          </h3>
        </div>
        {actions}
      </header>
      <div className="space-y-2 p-2.5">{children}</div>
    </section>
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
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex w-full items-start justify-between gap-2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1.5 text-left rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
    >
      <span className="min-w-0 flex-1">
        <span className="block break-words text-[11px] font-bold text-[var(--text-main)]">
          {label}
        </span>
        <span className="mt-0.5 block break-words text-[10px] text-[var(--text-muted)]">
          {description}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`relative mt-0.5 h-5 w-9 shrink-0 border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)] ${
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

export function SchedulerMasterDetailTab() {
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const publishedModels = usePipelineStore((state) => state.publishedModels);
  const productionJobs = usePipelineStore((state) => state.productionJobs);
  const jobExecutionLogs = usePipelineStore((state) => state.jobExecutionLogs);
  const loadPublishedModels = usePipelineStore((state) => state.loadPublishedModels);
  const loadProductionJobs = usePipelineStore((state) => state.loadProductionJobs);
  const saveProductionJob = usePipelineStore((state) => state.saveProductionJob);
  const deleteProductionJob = usePipelineStore((state) => state.deleteProductionJob);
  const runProductionJobNow = usePipelineStore((state) => state.runProductionJobNow);
  const clearSchedulerLogsOlderThan = usePipelineStore(
    (state) => state.clearSchedulerLogsOlderThan,
  );
  const addToast = useUIStore((state) => state.addToast);
  const activeTheme = useUIStore((state) => state.activeTheme);

  const [form, setForm] = useState<ProductionJobItem>(() => defaultScheduleJob(''));
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [activeTab, setActiveTab] = useState<ScheduleTab>('setting');
  const [activeScript, setActiveScript] = useState<ScriptTab>('pre_map');
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [showSmtpSecret, setShowSmtpSecret] = useState(false);
  const [clearMenuOpen, setClearMenuOpen] = useState(false);
  const [openLogId, setOpenLogId] = useState<string | null>(null);
  const [output, setOutput] = useState<OutputLine[]>([]);
  const outputId = useRef(0);

  useEffect(() => {
    setForm(defaultScheduleJob(projectKey));
    setActiveTab('setting');
    setActiveScript('pre_map');
    setOutput([]);
    setOpenLogId(null);
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

      const models = modelResult.status === 'fulfilled' ? modelResult.value : [];
      const jobs = jobResult.status === 'fulfilled' ? jobResult.value : [];

      if (jobs.length > 0) {
        setForm((current) =>
          current.job_script_id ? current : jobToForm(jobs[0], models),
        );
      }

      if (failures.length > 0) {
        const detail = failures.join(' · ');
        setLoadError(detail);
        addToast('error', `Failed to load Scheduler data: ${detail}`);
      }
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [addToast, loadProductionJobs, loadPublishedModels, projectKey]);

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

  const logs = form.job_script_id
    ? jobExecutionLogs[form.job_script_id] ?? []
    : [];

  const smtp = form.schedule_config.smtp_alert ?? defaultSmtp();
  const schedule = form.schedule_config;
  const source = form.source_config;
  const sink = form.sink_config;
  const editorTheme = activeTheme === 'midnight' ? 'vs-dark' : 'light';

  const patchForm = (patch: Partial<ProductionJobItem>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const patchSchedule = (patch: Partial<ProductionJobItem['schedule_config']>) => {
    setForm((current) => ({
      ...current,
      schedule_config: { ...current.schedule_config, ...patch },
    }));
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

  const patchSmtp = (patch: Partial<SmtpAlertConfig>) => {
    setForm((current) => ({
      ...current,
      schedule_config: {
        ...current.schedule_config,
        smtp_alert: {
          ...defaultSmtp(),
          ...(current.schedule_config.smtp_alert ?? {}),
          ...patch,
        },
      },
    }));
  };

  const resetOutput = (line?: OutputLine) => {
    outputId.current = 1;
    setOutput(line ? [line] : []);
  };

  const appendOutput = (kind: OutputKind, text: string) => {
    setOutput((current) => [...current, { id: outputId.current++, kind, text }]);
  };

  const selectSchedule = (jobId: string) => {
    const job = projectJobs.find((item) => item.job_script_id === jobId);
    if (!job) return;
    setForm(jobToForm(job, publishedModels));
    resetOutput();
    setOpenLogId(null);
    setClearMenuOpen(false);
  };

  const addSchedule = () => {
    setForm(defaultScheduleJob(projectKey));
    setActiveTab('setting');
    setActiveScript('pre_map');
    setOpenLogId(null);
    setClearMenuOpen(false);
    resetOutput();
  };

  const scheduleEnabled = schedule.is_scheduled && schedule.schedule_type !== 'unscheduled';

  const toggleSchedule = () => {
    if (scheduleEnabled) {
      patchSchedule({ is_scheduled: false });
      return;
    }
    patchSchedule({
      is_scheduled: true,
      schedule_type:
        schedule.schedule_type === 'unscheduled' ? 'daily_at' : schedule.schedule_type,
    });
  };

  const changeScheduleType = (type: ProductionJobItem['schedule_config']['schedule_type']) => {
    patchSchedule({
      schedule_type: type,
      is_scheduled: type !== 'unscheduled',
      interval_val: schedule.interval_val > 0 ? schedule.interval_val : 1,
    });
  };

  const saveCurrent = async (): Promise<ProductionJobItem | null> => {
    const validation = validateSchedule(form, selectedModel);
    if (validation) {
      addToast('warning', validation);
      return null;
    }

    const saved = await saveProductionJob({
      ...form,
      project_key: projectKey,
      model_name: form.model_name,
      model_id: selectedModel?.model_id ?? form.model_id,
    });
    setForm(saved);
    return saved;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await saveCurrent();
      if (saved) addToast('success', `Schedule '${saved.job_name}' saved.`);
    } catch (error) {
      addToast('error', `Save failed: ${messageOf(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const jobId = form.job_script_id;
    if (!jobId) {
      addToast('warning', 'Save the schedule before deleting it.');
      return;
    }
    const confirmed = window.confirm(
      `Delete schedule '${form.job_name}'? This also deletes the backend batch job.`,
    );
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      await deleteProductionJob(jobId);
      const remaining = projectJobs.filter(
        (job) => job.job_script_id !== jobId,
      );
      if (remaining.length > 0) {
        setForm(jobToForm(remaining[0], publishedModels));
      } else {
        setForm(defaultScheduleJob(projectKey));
      }
      resetOutput();
      setOpenLogId(null);
      addToast('success', "Schedule deleted.");
    } catch (error) {
      addToast('error', `Delete failed: ${messageOf(error)}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleTestRun = async () => {
    setActiveTab('script');
    setOpenLogId(null);

    const validation = validateSchedule(form, selectedModel);
    if (validation) {
      resetOutput({ id: 0, kind: 'error', text: `✖ ${validation}` });
      addToast('warning', validation);
      return;
    }

    resetOutput();
    setIsRunning(true);

    try {
      const saved = await saveCurrent();
      if (!saved) return;
      if (!saved.job_script_id) {
        throw new Error('Backend did not return a batch job id.');
      }

      appendOutput(
        'info',
        `▶ ${new Date().toLocaleString()} — Test Run '${saved.job_name}'…`,
      );
      const result = await runProductionJobNow(saved.job_script_id);
      appendOutput('success', `✔ Rows processed to Target Sink: ${result.rows_processed}`);
      appendOutput('info', `Target Sink: ${result.sink_destination}`);
      appendOutput('info', `Executed at: ${result.executed_at}`);
      addToast(
        'success',
        `Test Run '${saved.job_name}' processed ${result.rows_processed} rows.`,
      );
    } catch (error) {
      const detail = messageOf(error);
      appendOutput('error', `✖ ${detail}`);
      addToast('error', `Test Run failed: ${detail}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleClearLogs = (months: ClearRange) => {
    if (!form.job_script_id) return;
    clearSchedulerLogsOlderThan(form.job_script_id, months);
    setClearMenuOpen(false);
    addToast(
      'success',
      `Cleared logs ${CLEAR_RANGES.find((range) => range.months === months)?.label ?? ''} for '${form.job_name}'.`,
    );
  };

  const scriptValue =
    activeScript === 'pre_map'
      ? form.pre_mapper_script
      : form.post_calc_script;
  const scriptSignature =
    activeScript === 'pre_map'
      ? 'def pre_map(df: pl.DataFrame) -> pl.DataFrame:'
      : 'def post_calc(pred_df, raw_df, dataiki) -> pl.DataFrame:';

  const outputColor: Record<OutputKind, string> = {
    info: 'text-[var(--accent-primary)]',
    success: 'text-[var(--accent-secondary)]',
    error: 'text-[var(--accent-danger)]',
  };

  return (
    <div className="space-y-3">
      <header className={`${CARD_CLASS} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <div className="flex min-w-0 items-start gap-2">
          <CalendarClock size={18} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
              Scheduler &amp; Logs
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Master schedule list · human-friendly timing · SMTP failure alerts
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {isLoading && (
            <Loader2 size={13} className="animate-spin text-[var(--text-muted)]" />
          )}
          <span className="inline-flex items-center border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            {projectJobs.length} schedule{projectJobs.length === 1 ? '' : 's'}
          </span>
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
            Select a project before managing schedules.
          </p>
        </div>
      )}

      <div className="grid items-start gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className={`${CARD_CLASS} flex min-w-0 flex-col overflow-hidden`}>
          <div className="border-b-[length:var(--border-width)] border-[var(--border-color)] p-2">
            <button
              type="button"
              onClick={addSchedule}
              disabled={!projectKey}
              className={`${PRIMARY_BUTTON} w-full py-2`}
            >
              <Plus size={13} />
              + Add Schedule
            </button>
          </div>

          <div className="max-h-[600px] overflow-y-auto p-1.5">
            {projectJobs.length === 0 ? (
              <p className="px-1.5 py-4 text-[11px] leading-relaxed text-[var(--text-muted)]">
                No schedules yet. Use [+ Add Schedule] to create the first batch schedule.
              </p>
            ) : (
              <ul className="space-y-1">
                {projectJobs.map((job) => {
                  const selected = form.job_script_id === job.job_script_id;
                  const badge = scheduleBadge(job);
                  return (
                    <li key={job.job_script_id}>
                      <button
                        type="button"
                        onClick={() => selectSchedule(job.job_script_id ?? '')}
                        className={`w-full border-[length:var(--border-width)] px-2 py-1.5 text-left rounded-[var(--border-radius)] transition-colors ${
                          selected
                            ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)]'
                            : 'border-[var(--border-color)] bg-[var(--bg-input)] hover:bg-[var(--bg-hover)]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-1.5">
                          <span className="min-w-0 break-words text-[11px] font-bold text-[var(--text-main)]">
                            {job.job_name}
                          </span>
                          <span
                            className={`shrink-0 text-[10px] font-bold ${
                              job.last_status === 'running' ? 'italic' : ''
                            }`}
                            style={{ color: badge.color }}
                          >
                            {badge.text}
                          </span>
                        </div>
                        <p className="mt-0.5 break-words text-[9px] text-[var(--text-muted)]">
                          {describeSchedule(job)}
                        </p>
                        <p className="mt-0.5 break-words font-mono text-[8px] text-[var(--text-muted)]">
                          {job.last_run_at
                            ? `Last: ${formatDateTime(job.last_run_at)}`
                            : 'Never run'}
                        </p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        <section className={`${CARD_CLASS} flex min-w-0 flex-col overflow-hidden`}>
          <nav className="flex shrink-0 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)]">
            {(
              [
                { key: 'setting', label: 'Setting', icon: <Settings2 size={12} /> },
                { key: 'script', label: 'Script', icon: <Code2 size={12} /> },
                { key: 'log', label: 'Log', icon: <History size={12} /> },
              ] as Array<{ key: ScheduleTab; label: string; icon: ReactNode }>
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => {
                  setActiveTab(tab.key);
                  setClearMenuOpen(false);
                }}
                className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 border-r-[length:var(--border-width)] border-[var(--border-color)] px-2 py-2 text-[11px] font-bold transition-colors last:border-r-0 ${
                  activeTab === tab.key
                    ? 'bg-[var(--bg-card)] text-[var(--accent-primary)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                }`}
              >
                {tab.icon}
                <span className="break-words">[{tab.label}]</span>
              </button>
            ))}
          </nav>

          <div className="min-h-0 flex-1">
            {activeTab === 'setting' && (
              <div className="space-y-2.5 p-2.5">
                <SettingSection
                  title="Status & Control"
                  icon={<Settings2 size={12} />}
                  actions={
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={toggleSchedule}
                        className={SECONDARY_BUTTON}
                      >
                        {scheduleEnabled ? 'Disable Schedule' : 'Enable Schedule'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete()}
                        disabled={isDeleting || !form.job_script_id}
                        className={SECONDARY_BUTTON}
                      >
                        {isDeleting ? (
                          <Loader2 size={11} className="animate-spin" />
                        ) : (
                          <Trash2 size={11} />
                        )}
                        Delete
                      </button>
                    </div>
                  }
                >
                  <div className="grid gap-2 md:grid-cols-2">
                    <label className="block min-w-0">
                      <span className={LABEL_CLASS}>Schedule Name</span>
                      <input
                        value={form.job_name}
                        onChange={(event) => patchForm({ job_name: event.target.value })}
                        className={INPUT_CLASS}
                        placeholder="nightly_churn_batch"
                        autoComplete="off"
                      />
                    </label>
                    <label className="block min-w-0">
                      <span className={LABEL_CLASS}>Model Name (Active Model)</span>
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
                  </div>
                  <p className={selectedModel ? HINT_CLASS : 'break-words text-[10px] text-[var(--accent-warning)]'}>
                    {selectedModel
                      ? `Auto-bound to v${selectedModel.version} (active).`
                      : form.model_name
                        ? 'Activate this model name in Model Registry first.'
                        : 'Pick a model name; the Active version is resolved automatically.'}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center border-[length:var(--border-width)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest rounded-[var(--border-radius)] ${
                        scheduleEnabled
                          ? 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]'
                          : 'border-[var(--border-color)] text-[var(--text-muted)]'
                      }`}
                    >
                      {scheduleEnabled ? 'Enabled' : 'Disabled'}
                    </span>
                    <span className={HINT_CLASS}>{describeSchedule(form)}</span>
                  </div>
                </SettingSection>

                <SettingSection title="Human-Friendly Schedule" icon={<CalendarClock size={12} />}>
                  <div className="grid gap-2 md:grid-cols-3">
                    <label className="block min-w-0">
                      <span className={LABEL_CLASS}>Frequency</span>
                      <select
                        value={schedule.schedule_type}
                        onChange={(event) =>
                          changeScheduleType(
                            event.target
                              .value as ProductionJobItem['schedule_config']['schedule_type'],
                          )
                        }
                        className={INPUT_CLASS}
                      >
                        <option value="unscheduled">Unscheduled</option>
                        <option value="every_minute">Every X Minutes</option>
                        <option value="every_hour">Every X Hours</option>
                        <option value="daily_at">Daily at HH:MM</option>
                        <option value="specific_date">Specific Date &amp; Time</option>
                      </select>
                    </label>

                    {(schedule.schedule_type === 'every_minute' ||
                      schedule.schedule_type === 'every_hour') && (
                      <label className="block min-w-0">
                        <span className={LABEL_CLASS}>
                          Every{' '}
                          {schedule.schedule_type === 'every_minute' ? 'Minutes' : 'Hours'}
                        </span>
                        <input
                          type="number"
                          min={1}
                          value={schedule.interval_val}
                          onChange={(event) =>
                            patchSchedule({
                              interval_val: Number(event.target.value) || 1,
                            })
                          }
                          className={INPUT_CLASS}
                        />
                      </label>
                    )}

                    {schedule.schedule_type === 'daily_at' && (
                      <label className="block min-w-0">
                        <span className={LABEL_CLASS}>Daily Time (HH:MM)</span>
                        <input
                          type="time"
                          value={schedule.daily_time}
                          onChange={(event) =>
                            patchSchedule({ daily_time: event.target.value })
                          }
                          className={INPUT_CLASS}
                        />
                      </label>
                    )}

                    {schedule.schedule_type === 'specific_date' && (
                      <label className="block min-w-0">
                        <span className={LABEL_CLASS}>Run Once At</span>
                        <input
                          type="datetime-local"
                          value={(schedule.run_date ?? '').replace(' ', 'T')}
                          onChange={(event) =>
                            patchSchedule({
                              run_date: event.target.value.replace('T', ' '),
                            })
                          }
                          className={INPUT_CLASS}
                        />
                      </label>
                    )}
                  </div>
                  <p className={HINT_CLASS}>
                    No raw cron syntax. Backend interval modes run every 1 minute/hour;
                    the X value is kept in the schedule definition.
                  </p>
                </SettingSection>

                <SettingSection title="Source & Target Sink" icon={<Database size={12} />}>
                  <div className="grid gap-2.5 md:grid-cols-2">
                    <div className="space-y-1.5 border-[length:var(--border-width)] border-[var(--border-color)] p-2 rounded-[var(--border-radius)]">
                      <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--accent-primary)]">
                        Source
                      </p>
                      <label className="block">
                        <span className={LABEL_CLASS}>Type</span>
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
                              onChange={(event) =>
                                patchSource({ conn_id: event.target.value })
                              }
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
                              onChange={(event) =>
                                patchSource({ sql_query: event.target.value })
                              }
                              className={`${INPUT_CLASS} min-h-[56px] resize-y font-mono`}
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
                            onChange={(event) =>
                              patchSource({ file_path: event.target.value })
                            }
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
                              onChange={(event) =>
                                patchSource({ api_url: event.target.value })
                              }
                              className={INPUT_CLASS}
                              placeholder="https://api.example.com/rows"
                            />
                          </label>
                          <label className="block">
                            <span className={LABEL_CLASS}>Connection (headers)</span>
                            <select
                              value={source.conn_id ?? ''}
                              onChange={(event) =>
                                patchSource({ conn_id: event.target.value })
                              }
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
                    </div>

                    <div className="space-y-1.5 border-[length:var(--border-width)] border-[var(--border-color)] p-2 rounded-[var(--border-radius)]">
                      <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--accent-primary)]">
                        Target Sink
                      </p>
                      <label className="block">
                        <span className={LABEL_CLASS}>Type</span>
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
                              onChange={(event) =>
                                patchSink({ conn_id: event.target.value })
                              }
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
                              onChange={(event) =>
                                patchSink({ table_name: event.target.value })
                              }
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
                                  write_mode: event.target.value as
                                    | 'append'
                                    | 'replace'
                                    | 'upsert',
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
                            onChange={(event) =>
                              patchSink({ api_url: event.target.value })
                            }
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
                                  file_format: event.target.value as
                                    | 'xlsx'
                                    | 'csv'
                                    | 'parquet',
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
                              onChange={(event) =>
                                patchSink({ output_dir: event.target.value })
                              }
                              className={INPUT_CLASS}
                              placeholder="storage/exports"
                            />
                          </label>
                        </>
                      )}
                    </div>
                  </div>
                </SettingSection>

                <SettingSection title="Email Failure Alert (SMTP)" icon={<Mail size={12} />}>
                  <Toggle
                    checked={smtp.enabled}
                    onChange={(checked) => patchSmtp({ enabled: checked })}
                    label="📧 Send Email on Failure"
                    description="Sends the alert template when this schedule run fails."
                  />

                  {smtp.enabled && (
                    <>
                      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_120px]">
                        <label className="block min-w-0">
                          <span className={LABEL_CLASS}>SMTP Host</span>
                          <input
                            value={smtp.smtp_host}
                            onChange={(event) =>
                              patchSmtp({ smtp_host: event.target.value })
                            }
                            className={INPUT_CLASS}
                            placeholder="smtp.gmail.com"
                          />
                        </label>
                        <label className="block min-w-0">
                          <span className={LABEL_CLASS}>Port</span>
                          <input
                            type="number"
                            min={1}
                            max={65535}
                            value={smtp.smtp_port}
                            onChange={(event) =>
                              patchSmtp({
                                smtp_port: Number(event.target.value) || 0,
                              })
                            }
                            className={INPUT_CLASS}
                            placeholder="587"
                          />
                        </label>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="block min-w-0">
                          <span className={LABEL_CLASS}>Username / Sender Email</span>
                          <input
                            value={smtp.smtp_user}
                            onChange={(event) =>
                              patchSmtp({ smtp_user: event.target.value })
                            }
                            className={INPUT_CLASS}
                            placeholder="alerts@example.com"
                            autoComplete="off"
                          />
                        </label>
                        <label className="block min-w-0">
                          <span className={LABEL_CLASS}>Password / Vault Secret Key</span>
                          <div className="flex items-stretch">
                            <input
                              type={showSmtpSecret ? 'text' : 'password'}
                              value={smtp.smtp_password_secret_key}
                              onChange={(event) =>
                                patchSmtp({
                                  smtp_password_secret_key: event.target.value,
                                })
                              }
                              className={`${INPUT_CLASS} min-w-0 rounded-r-none`}
                              placeholder="SMTP_PASSWORD"
                              autoComplete="off"
                            />
                            <button
                              type="button"
                              onClick={() => setShowSmtpSecret((current) => !current)}
                              className={`${SECONDARY_BUTTON} shrink-0 rounded-l-none px-2`}
                              aria-label={
                                showSmtpSecret ? 'Hide SMTP secret' : 'Show SMTP secret'
                              }
                            >
                              {showSmtpSecret ? <EyeOff size={11} /> : <Eye size={11} />}
                            </button>
                          </div>
                        </label>
                      </div>

                      <div className="grid gap-2 md:grid-cols-2">
                        <label className="block min-w-0">
                          <span className={LABEL_CLASS}>Mail To</span>
                          <input
                            value={smtp.mail_to}
                            onChange={(event) =>
                              patchSmtp({ mail_to: event.target.value })
                            }
                            className={INPUT_CLASS}
                            placeholder="ops@example.com, owner@example.com"
                          />
                        </label>
                        <label className="block min-w-0">
                          <span className={LABEL_CLASS}>Mail CC (optional)</span>
                          <input
                            value={smtp.mail_cc}
                            onChange={(event) =>
                              patchSmtp({ mail_cc: event.target.value })
                            }
                            className={INPUT_CLASS}
                            placeholder="manager@example.com"
                          />
                        </label>
                      </div>

                      <label className="block">
                        <span className={LABEL_CLASS}>Subject</span>
                        <input
                          value={smtp.subject}
                          onChange={(event) =>
                            patchSmtp({ subject: event.target.value })
                          }
                          className={INPUT_CLASS}
                          placeholder="[ALERT] Dataiki Schedule Failed: {schedule_name}"
                        />
                      </label>

                      <label className="block">
                        <span className={LABEL_CLASS}>Body Message</span>
                        <textarea
                          value={smtp.body_message}
                          onChange={(event) =>
                            patchSmtp({ body_message: event.target.value })
                          }
                          className={`${INPUT_CLASS} min-h-[90px] resize-y font-mono`}
                          placeholder="Placeholders: {schedule_name}, {error_message}, {timestamp}"
                        />
                      </label>
                      <p className={HINT_CLASS}>
                        Placeholders: {'{schedule_name}'} · {'{error_message}'} ·{' '}
                        {'{timestamp}'}. The password field accepts a Global Secret key
                        name or a raw password; it is stored in local schedule config.
                      </p>
                    </>
                  )}
                </SettingSection>
              </div>
            )}

            {activeTab === 'script' && (
              <div className="flex min-h-0 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-1.5 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5">
                  <div className="flex overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
                    {(['pre_map', 'post_calc'] as ScriptTab[]).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveScript(tab)}
                        className={`flex items-center gap-1 border-r-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1.5 text-[10px] font-bold transition-colors last:border-r-0 ${
                          activeScript === tab
                            ? 'bg-[var(--bg-canvas)] text-[var(--accent-primary)]'
                            : 'bg-[var(--bg-input)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
                        }`}
                      >
                        <Code2 size={11} />
                        {tab}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="break-words font-mono text-[10px] text-[var(--text-main)]">
                      {scriptSignature}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleTestRun()}
                      disabled={isRunning || isSaving || isLoading || !projectKey}
                      className={RUN_BUTTON}
                    >
                      {isRunning ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Play size={12} />
                      )}
                      {isRunning ? 'Running…' : '▶️ Test Run'}
                    </button>
                  </div>
                </div>

                <div className="h-[440px] overflow-hidden bg-[var(--bg-input)]">
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
                </div>

                <div className="border-t-[length:var(--border-width)] border-[var(--accent-primary)] bg-black">
                  <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-[var(--accent-primary)] px-2.5 py-1">
                    <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-[var(--accent-secondary)]">
                      Script Output
                    </span>
                    {output.length > 0 && (
                      <button
                        type="button"
                        onClick={() => resetOutput()}
                        className="inline-flex items-center gap-1 border border-[var(--text-muted)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--text-muted)] transition-colors hover:border-[var(--accent-secondary)] hover:text-[var(--accent-secondary)]"
                      >
                        <Trash2 size={9} />
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="h-[150px] overflow-auto px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                    {output.length === 0 ? (
                      <p className="text-[var(--text-muted)]">
                        Press ▶️ Test Run to execute the schedule. print() output, rows
                        processed, and error tracebacks appear here.
                      </p>
                    ) : (
                      output.map((line) => (
                        <pre
                          key={line.id}
                          className={`break-words whitespace-pre-wrap ${outputColor[line.kind]}`}
                        >
                          {line.text}
                        </pre>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'log' && (
              <div className="flex min-h-0 flex-col">
                <div className="flex flex-wrap items-center justify-between gap-1.5 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2.5 py-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <History size={12} className="shrink-0 text-[var(--accent-primary)]" />
                    <span className="break-words text-[10px] font-bold uppercase tracking-widest text-[var(--text-main)]">
                      Execution History
                    </span>
                    <span className={HINT_CLASS}>
                      {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}
                    </span>
                  </div>

                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setClearMenuOpen((current) => !current)}
                      disabled={!form.job_script_id || logs.length === 0}
                      className={SECONDARY_BUTTON}
                      aria-expanded={clearMenuOpen}
                    >
                      <Trash2 size={11} />
                      🗑️ Clear Logs
                      <ChevronDown size={11} />
                    </button>
                    {clearMenuOpen && (
                      <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]">
                        {CLEAR_RANGES.map((range) => (
                          <button
                            key={range.months}
                            type="button"
                            onClick={() => handleClearLogs(range.months)}
                            className="block w-full border-b-[length:var(--border-width)] border-[var(--border-color)] px-2.5 py-1.5 text-left text-[10px] font-bold text-[var(--text-main)] transition-colors last:border-b-0 hover:bg-[var(--bg-hover)]"
                          >
                            Hapus Log {range.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="max-h-[560px] overflow-y-auto p-2">
                  {!form.job_script_id ? (
                    <div className="flex flex-col items-center justify-center gap-1.5 px-3 py-10 text-center">
                      <History size={22} className="text-[var(--text-muted)]" />
                      <p className="text-xs font-bold text-[var(--text-main)]">
                        No log history yet
                      </p>
                      <p className="max-w-sm text-[10px] text-[var(--text-muted)]">
                        Save the schedule and press ▶️ Test Run. Execution results are
                        stored locally in jobExecutionLogs.
                      </p>
                    </div>
                  ) : logs.length === 0 ? (
                    <div className="flex flex-col items-center justify-center gap-1.5 px-3 py-10 text-center">
                      <History size={22} className="text-[var(--text-muted)]" />
                      <p className="text-xs font-bold text-[var(--text-main)]">
                        No execution history
                      </p>
                      <p className="max-w-sm text-[10px] text-[var(--text-muted)]">
                        Run this schedule to create the first log entry.
                      </p>
                    </div>
                  ) : (
                    <ul className="space-y-1.5">
                      {logs.map((entry) => {
                        const detailOpen = openLogId === entry.log_id;
                        const indicator =
                          entry.status === 'success'
                            ? '🟢'
                            : entry.status === 'warning'
                              ? '🟡'
                              : entry.status === 'error'
                                ? '🔴'
                                : '⏳';
                        const when = entry.finished_at ?? entry.started_at;
                        return (
                          <li
                            key={entry.log_id}
                            className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] rounded-[var(--border-radius)]"
                          >
                            <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
                              <span className="shrink-0 text-[13px] leading-none">
                                {indicator}
                              </span>
                              <span className="min-w-0 break-words text-[11px] font-bold text-[var(--text-main)]">
                                {entry.schedule_name || form.job_name}
                              </span>
                              {entry.status === 'running' ? (
                                <span className="italic text-[10px] text-[var(--accent-primary)]">
                                  Running...
                                </span>
                              ) : (
                                <span className="text-[9px] uppercase tracking-widest text-[var(--text-muted)]">
                                  {entry.status}
                                </span>
                              )}
                              <span className="break-words font-mono text-[9px] text-[var(--text-muted)]">
                                {formatDateTime(when)}
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setOpenLogId(detailOpen ? null : entry.log_id)
                                }
                                className={`${SECONDARY_BUTTON} ml-auto`}
                              >
                                📄 View Log
                              </button>
                            </div>
                            {detailOpen && (
                              <div className="space-y-1.5 border-t-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1.5">
                                {entry.stdout_text && (
                                  <div>
                                    <p className="mb-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                                      stdout
                                    </p>
                                    <pre className="max-h-40 overflow-auto break-words whitespace-pre-wrap border-[length:var(--border-width)] border-[var(--border-color)] bg-black p-1.5 font-mono text-[10px] leading-relaxed text-[var(--accent-secondary)] rounded-[var(--border-radius)]">
                                      {entry.stdout_text}
                                    </pre>
                                  </div>
                                )}
                                {entry.error_detail && (
                                  <div>
                                    <p className="mb-0.5 text-[9px] font-bold uppercase tracking-widest text-[var(--accent-danger)]">
                                      error / traceback
                                    </p>
                                    <pre className="max-h-40 overflow-auto break-words whitespace-pre-wrap border-[length:var(--border-width)] border-[var(--accent-danger)] bg-black p-1.5 font-mono text-[10px] leading-relaxed text-[var(--accent-danger)] rounded-[var(--border-radius)]">
                                      {entry.error_detail}
                                    </pre>
                                  </div>
                                )}
                                {!entry.stdout_text && !entry.error_detail && (
                                  <p className={HINT_CLASS}>
                                    This log has no stdout or error detail stored.
                                  </p>
                                )}
                              </div>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2.5 py-2">
            <p className={HINT_CLASS}>
              {form.job_script_id
                ? `Editing '${form.job_name}' · Save updates the schedule binding.`
                : 'New schedule · Save creates a backend batch job.'}
            </p>
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
              {isSaving ? 'Saving…' : '💾 Save Changes'}
            </button>
          </footer>
        </section>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Target size={12} className="shrink-0 text-[var(--text-muted)]" />
        <span className={HINT_CLASS}>
          Logs are persisted in jobExecutionLogs (localStorage). Clear Logs removes entries
          older than the chosen range.
        </span>
      </div>
    </div>
  );
}
