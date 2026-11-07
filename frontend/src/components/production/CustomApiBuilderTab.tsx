import { useEffect, useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Play,
  Plug,
  Plus,
  Save,
  ShieldCheck,
  Trash2,
  Zap,
} from 'lucide-react';
import type { ApiTestResult } from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { CustomEndpointConfig, PublishedModelItem } from '../../types/dataiki';

type SubTab = 'script' | 'tester';

interface FormState {
  endpoint_id?: string;
  model_name: string;
  http_method: 'POST' | 'GET';
  custom_path: string;
  function_name: string;
  api_logic_script: string;
  is_enabled: boolean;
  require_api_key: boolean;
}

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';
const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)] disabled:cursor-not-allowed disabled:opacity-50';
const LABEL_CLASS =
  'mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const HINT_CLASS = 'text-[10px] leading-relaxed text-[var(--text-muted)]';
const HINT_HELP =
  'mt-1 flex items-center gap-1 text-[9px] leading-relaxed text-[var(--text-muted)]';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';

const PYTHON_TEMPLATE = `# The gateway injects the runtime SDK as \`dataiki\`.
# Alias it so the script matches Dataiki docs naming (dataiki_ctx).
dataiki_ctx = dataiki

def handle_request(payload: dict) -> dict:
    features = payload.get("features", payload)
    model = dataiki_ctx.get_published_model()  # binds to the Active Model
    prediction = model.predict(features)
    # conn = dataiki_ctx.vault.get_connection("warehouse")
    return {"prediction": prediction}
`;

const DEFAULT_PAYLOAD = `{
  "features": {
    "feature_1": 0
  }
}`;

function defaultForm(): FormState {
  return {
    model_name: '',
    http_method: 'POST',
    custom_path: 'predict',
    function_name: 'handle_request',
    api_logic_script: PYTHON_TEMPLATE,
    is_enabled: true,
    require_api_key: false,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePath(value: string): string {
  return value.trim().replace(/^\/+|\/+$/g, '');
}

function activeModelFor(
  models: PublishedModelItem[],
  modelName: string,
): PublishedModelItem | undefined {
  return models.find((model) => model.model_name === modelName && model.status === 'active');
}

function endpointModelName(
  endpoint: CustomEndpointConfig,
  models: PublishedModelItem[],
): string {
  if (endpoint.model_name) return endpoint.model_name;
  return models.find((model) => model.model_id === endpoint.model_id)?.model_name ?? '';
}

function formFromEndpoint(
  endpoint: CustomEndpointConfig,
  models: PublishedModelItem[],
): FormState {
  return {
    endpoint_id: endpoint.endpoint_id,
    model_name: endpointModelName(endpoint, models),
    http_method: endpoint.http_method,
    custom_path: endpoint.custom_path.replace(/^\/+/, ''),
    function_name: endpoint.function_name || 'handle_request',
    api_logic_script: endpoint.api_logic_script || PYTHON_TEMPLATE,
    is_enabled: endpoint.is_enabled,
    require_api_key: endpoint.require_api_key === true,
  };
}

function statusLabel(result: ApiTestResult): string {
  if (result.status === 422) return '422 Rejected by Data Recipe Fail-Fast Contract';
  if (result.status === 401) return '401 Unauthorized';
  if (result.status === 500) return '500 Error';
  if (result.status === 200) return `200 ${result.statusText || 'OK'}`;
  return `${result.status} ${result.statusText || (result.ok ? 'OK' : 'Error')}`.trim();
}

function statusColor(result: ApiTestResult): string {
  if (result.ok) return 'var(--accent-secondary)';
  if (result.status === 422) return 'var(--accent-warning)';
  return 'var(--accent-danger)';
}

function prettyBody(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function copyText(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable. Select and copy the snippet manually.');
  }
  await navigator.clipboard.writeText(text);
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
      className="flex w-full items-start justify-between gap-2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1.5 text-left rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
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

export function CustomApiBuilderTab() {
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const publishedModels = usePipelineStore((state) => state.publishedModels);
  const customEndpoints = usePipelineStore((state) => state.customEndpoints);
  const apiKeys = usePipelineStore((state) => state.apiKeys);
  const loadPublishedModels = usePipelineStore((state) => state.loadPublishedModels);
  const loadCustomEndpoints = usePipelineStore((state) => state.loadCustomEndpoints);
  const saveCustomEndpoint = usePipelineStore((state) => state.saveCustomEndpoint);
  const deleteCustomEndpoint = usePipelineStore((state) => state.deleteCustomEndpoint);
  const testCustomEndpoint = usePipelineStore((state) => state.testCustomEndpoint);
  const addToast = useUIStore((state) => state.addToast);
  const activeTheme = useUIStore((state) => state.activeTheme);

  const [activeSubTab, setActiveSubTab] = useState<SubTab>('script');
  const [form, setForm] = useState<FormState>(defaultForm);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [testPayload, setTestPayload] = useState(DEFAULT_PAYLOAD);
  const [testApiKey, setTestApiKey] = useState('');
  const [showTestKey, setShowTestKey] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<ApiTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectKey) return;
    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    void Promise.allSettled([
      loadPublishedModels(projectKey),
      loadCustomEndpoints(projectKey),
    ]).then((results) => {
      if (cancelled) return;
      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failures.length > 0) {
        const detail = failures.map((failure) => messageOf(failure.reason)).join(' · ');
        setLoadError(detail);
        addToast('error', `Failed to load API Builder data: ${detail}`);
      }
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [addToast, loadCustomEndpoints, loadPublishedModels, projectKey]);

  const modelNames = useMemo(
    () =>
      Array.from(
        new Set(
          publishedModels
            .filter((model) => model.status === 'active')
            .map((model) => model.model_name),
        ),
      ),
    [publishedModels],
  );

  const selectedModel = activeModelFor(publishedModels, form.model_name);
  const pathValue = normalizePath(form.custom_path);

  const endpointUrl = useMemo(() => {
    if (!projectKey || !pathValue) return '';
    const encodedPath = pathValue
      .split('/')
      .filter(Boolean)
      .map((part) => encodeURIComponent(part))
      .join('/');
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    return `${origin}/api/v1/${encodeURIComponent(projectKey)}/${encodedPath}`;
  }, [pathValue, projectKey]);

  const curlSnippet = useMemo(() => {
    const url = endpointUrl || `/api/v1/${projectKey || '{project_key}'}/${pathValue || '{custom_path}'}`;
    if (form.http_method === 'GET') {
      return `curl -X GET "${url}" \\\n  -H "x-api-key: $DATAIKI_API_KEY"`;
    }
    return `curl -X POST "${url}" \\\n  -H "Content-Type: application/json" \\\n  -H "x-api-key: $DATAIKI_API_KEY" \\\n  -d '${JSON.stringify(JSON.parse(DEFAULT_PAYLOAD))}'`;
  }, [endpointUrl, form.http_method, pathValue, projectKey]);

  const jupyterSnippet = useMemo(() => {
    const url = endpointUrl || `http://localhost:8000/api/v1/${projectKey || '{project_key}'}/${pathValue || '{custom_path}'}`;
    const request =
      form.http_method === 'GET'
        ? `response = requests.get(url, headers=headers)`
        : `response = requests.post(url, json=payload, headers=headers)`;
    return `import requests\n\nurl = "${url}"\nheaders = {"x-api-key": "dki_live_..."}\n${
      form.http_method === 'GET' ? '' : 'payload = {"features": {"feature_1": 0}}\n'
    }${request}\nprint(response.status_code)\nprint(response.json())`;
  }, [endpointUrl, form.http_method, pathValue, projectKey]);

  const patchForm = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
  };

  const resetForm = () => {
    setForm(defaultForm());
    setTestResult(null);
    setTestError(null);
  };

  useEffect(() => {
    setForm(defaultForm());
    setTestResult(null);
    setTestError(null);
    setActiveSubTab('script');
  }, [projectKey]);

  const selectEndpoint = (endpoint: CustomEndpointConfig) => {
    setForm(formFromEndpoint(endpoint, publishedModels));
    setTestResult(null);
    setTestError(null);
  };

  const handleCopy = async (text: string, message: string) => {
    try {
      await copyText(text);
      addToast('success', message);
    } catch (error) {
      addToast('error', messageOf(error));
    }
  };

  const validateForm = (): string | null => {
    if (!projectKey) return 'Select a project first.';
    if (!form.model_name) return 'Choose a model name.';
    if (!selectedModel) {
      return `No active model named '${form.model_name}'. Activate a version in Model Registry first.`;
    }
    if (!pathValue) return 'Custom path is required.';
    const functionName = form.function_name.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(functionName)) {
      return 'Function name must be a valid Python identifier.';
    }
    if (!new RegExp(`def\\s+${functionName}\\s*\\(`).test(form.api_logic_script)) {
      return `Handler script must define 'def ${functionName}(...)'.`;
    }
    return null;
  };

  const handleSave = async () => {
    const validationError = validateForm();
    if (validationError) {
      addToast('warning', validationError);
      return;
    }
    if (!projectKey || !selectedModel) return;

    setIsSaving(true);
    try {
      const saved = await saveCustomEndpoint({
        endpoint_id: form.endpoint_id,
        project_key: projectKey,
        model_id: selectedModel.model_id,
        model_name: form.model_name,
        http_method: form.http_method,
        custom_path: `/${pathValue}`,
        function_name: form.function_name.trim(),
        api_logic_script: form.api_logic_script,
        is_enabled: form.is_enabled,
        require_api_key: form.require_api_key,
      });
      setForm((current) => ({
        ...current,
        endpoint_id: saved.endpoint_id,
        custom_path: saved.custom_path.replace(/^\/+/, ''),
        model_name: saved.model_name ?? current.model_name,
      }));
      addToast('success', `Endpoint ${saved.http_method} ${saved.custom_path} saved.`);
    } catch (error) {
      addToast('error', `Save failed: ${messageOf(error)}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!form.endpoint_id) return;
    const confirmed = window.confirm(
      `Delete endpoint ${form.http_method} ${form.custom_path}? This cannot be undone.`,
    );
    if (!confirmed) return;
    setIsDeleting(true);
    try {
      await deleteCustomEndpoint(form.endpoint_id);
      addToast('success', 'Endpoint deleted.');
      resetForm();
    } catch (error) {
      addToast('error', `Delete failed: ${messageOf(error)}`);
    } finally {
      setIsDeleting(false);
    }
  };

  const unauthorizedResult = (detail: string): ApiTestResult => ({
    ok: false,
    status: 401,
    statusText: 'Unauthorized',
    duration_ms: 0,
    data: { detail },
  });

  const handleTest = async () => {
    if (!projectKey) {
      addToast('warning', 'Select a project before testing.');
      return;
    }
    if (!pathValue) {
      addToast('warning', 'Custom path is required before testing.');
      return;
    }

    setTestError(null);
    setTestResult(null);

    if (form.require_api_key) {
      const provided = testApiKey.trim();
      if (!provided) {
        setTestResult(
          unauthorizedResult(
            'Missing x-api-key header. This endpoint has Require API Key enabled.',
          ),
        );
        addToast('warning', 'This endpoint requires an API key.');
        return;
      }
      const validKeys = new Set(
        apiKeys.filter((key) => key.is_active).map((key) => key.token),
      );
      if (!validKeys.has(provided)) {
        setTestResult(
          unauthorizedResult('Invalid or disabled API key for this Dataiki project.'),
        );
        addToast('error', 'API key is invalid or disabled.');
        return;
      }
    }

    let payload: unknown = undefined;
    if (form.http_method === 'POST') {
      try {
        payload = JSON.parse(testPayload);
      } catch (error) {
        const detail = `Invalid JSON payload: ${messageOf(error)}`;
        setTestError(detail);
        addToast('error', detail);
        return;
      }
    }

    setIsTesting(true);
    try {
      const result = await testCustomEndpoint({
        projectKey,
        httpMethod: form.http_method,
        customPath: pathValue,
        payload,
        apiKey: testApiKey.trim() || undefined,
      });
      setTestResult(result);
      addToast(result.ok ? 'success' : 'warning', statusLabel(result));
    } catch (error) {
      const detail = messageOf(error);
      setTestError(detail);
      addToast('error', `Test request failed: ${detail}`);
    } finally {
      setIsTesting(false);
    }
  };

  const editorTheme = activeTheme === 'midnight' ? 'vs-dark' : 'light';

  return (
    <div className="space-y-3">
      <header className={`${CARD_CLASS} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <div className="flex min-w-0 items-start gap-2">
          <Plug size={18} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
              Custom REST API Builder
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Bind a route to a model name; the gateway always resolves the Active Model version.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            {customEndpoints.length} endpoint{customEndpoints.length === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={resetForm}
            className={SECONDARY_BUTTON}
            title="Start a new endpoint form"
          >
            <Plus size={12} />
            New Endpoint
          </button>
        </div>
      </header>

      {loadError && (
        <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-card)] px-3 py-2 rounded-[var(--border-radius)]">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
          <p className="text-xs text-[var(--text-main)]">{loadError}</p>
        </div>
      )}

      <div className="grid gap-3 lg:grid-cols-[28fr_72fr]">
        <aside className="min-w-0 space-y-2">
          <section className={CARD_CLASS}>
            <header className="flex items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2.5 py-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <Plug size={13} className="shrink-0 text-[var(--accent-primary)]" />
                <h3 className="break-words text-[11px] font-bold uppercase tracking-wide text-[var(--text-main)]">
                  Active Endpoints
                </h3>
              </div>
              {isLoading && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />}
            </header>
            <div className="max-h-44 overflow-y-auto p-1.5">
              {customEndpoints.length === 0 ? (
                <p className="px-1.5 py-3 text-[11px] text-[var(--text-muted)]">
                  No endpoints yet. Fill the form below and save the first route.
                </p>
              ) : (
                <ul className="space-y-1">
                  {customEndpoints.map((endpoint) => {
                    const selected = form.endpoint_id === endpoint.endpoint_id;
                    return (
                      <li key={endpoint.endpoint_id}>
                        <button
                          type="button"
                          onClick={() => selectEndpoint(endpoint)}
                          className={`w-full border-[length:var(--border-width)] px-2 py-1.5 text-left rounded-[var(--border-radius)] transition-colors ${
                            selected
                              ? 'border-[var(--accent-primary)] bg-[var(--bg-canvas)]'
                              : 'border-[var(--border-color)] bg-[var(--bg-input)] hover:bg-[var(--bg-hover)]'
                          }`}
                        >
                          <div className="flex flex-wrap items-center gap-1">
                            <span className="font-mono text-[9px] font-bold text-[var(--accent-primary)]">
                              {endpoint.http_method}
                            </span>
                            <span className="min-w-0 break-all font-mono text-[10px] font-bold text-[var(--text-main)]">
                              /{endpoint.custom_path.replace(/^\/+/, '')}
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1">
                            <span className="break-words text-[9px] text-[var(--text-muted)]">
                              {endpointModelName(endpoint, publishedModels) || 'No model name'}
                            </span>
                            <span
                              className={`border-[length:var(--border-width)] px-1 text-[8px] font-bold uppercase tracking-widest rounded-[var(--border-radius)] ${
                                endpoint.is_enabled
                                  ? 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]'
                                  : 'border-[var(--border-color)] text-[var(--text-muted)]'
                              }`}
                            >
                              {endpoint.is_enabled ? 'enabled' : 'disabled'}
                            </span>
                            {endpoint.require_api_key && (
                              <Lock size={9} className="text-[var(--accent-warning)]" />
                            )}
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>

          <section className={CARD_CLASS}>
            <header className="flex items-center gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2.5 py-2">
              <Code2 size={13} className="shrink-0 text-[var(--accent-primary)]" />
              <h3 className="break-words text-[11px] font-bold uppercase tracking-wide text-[var(--text-main)]">
                Route Configuration
              </h3>
            </header>
            <div className="space-y-2 p-2.5">
              <label className="block">
                <span className={LABEL_CLASS}>Model Name (Active Model)</span>
                <select
                  value={form.model_name}
                  onChange={(event) => patchForm({ model_name: event.target.value })}
                  className={INPUT_CLASS}
                  disabled={modelNames.length === 0}
                >
                  <option value="">
                    {modelNames.length === 0 ? 'No active model available' : 'Select model name'}
                  </option>
                  {modelNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              {form.model_name && (
                <p className={HINT_CLASS}>
                  {selectedModel
                    ? `Binds to ${form.model_name} v${selectedModel.version} (active).`
                    : `No active version for '${form.model_name}'.`}
                </p>
              )}
              {modelNames.length === 0 && !isLoading && (
                <p className="break-words text-[10px] text-[var(--accent-warning)]">
                  Activate a model in Model Registry before publishing an endpoint.
                </p>
              )}

              <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
                <label className="block">
                  <span className={LABEL_CLASS}>Method</span>
                  <select
                    value={form.http_method}
                    onChange={(event) =>
                      patchForm({ http_method: event.target.value === 'GET' ? 'GET' : 'POST' })
                    }
                    className={INPUT_CLASS}
                  >
                    <option value="POST">POST</option>
                    <option value="GET">GET</option>
                  </select>
                </label>
                <label className="block min-w-0">
                  <span className={LABEL_CLASS}>Function Name</span>
                  <input
                    value={form.function_name}
                    onChange={(event) => patchForm({ function_name: event.target.value })}
                    className={INPUT_CLASS}
                    placeholder="handle_request"
                    autoComplete="off"
                  />
                </label>
              </div>

              <label className="block">
                <span className={LABEL_CLASS}>Custom Path</span>
                <span className="mb-1 block break-all font-mono text-[9px] text-[var(--text-muted)]">
                  /api/v1/{projectKey || '{project_key}'}/
                </span>
                <input
                  value={form.custom_path}
                  onChange={(event) => patchForm({ custom_path: event.target.value })}
                  className={`${INPUT_CLASS} min-w-0`}
                  placeholder="predict"
                  autoComplete="off"
                />
                {pathValue && (
                  <span className="mt-1 block break-all font-mono text-[9px] text-[var(--text-muted)]">
                    Resolves to /api/v1/{projectKey || '{project_key}'}/{pathValue}
                  </span>
                )}
              </label>

              <Toggle
                checked={form.require_api_key}
                onChange={(checked) => patchForm({ require_api_key: checked })}
                label="🔒 Require API Key"
                description="Caller must send a valid dki_live_ key in x-api-key or Authorization: Bearer."
              />
              <Toggle
                checked={form.is_enabled}
                onChange={(checked) => patchForm({ is_enabled: checked })}
                label="Enable Endpoint"
                description="Disabled routes return 404 from the production gateway."
              />

              <div className="flex flex-wrap gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => void handleSave()}
                  disabled={isSaving || isLoading || !projectKey}
                  className={`${PRIMARY_BUTTON} flex-1`}
                >
                  {isSaving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Save size={12} />
                  )}
                  {isSaving ? 'Saving…' : 'Save Endpoint'}
                </button>
                {form.endpoint_id && (
                  <button
                    type="button"
                    onClick={() => void handleDelete()}
                    disabled={isDeleting || isSaving}
                    className={SECONDARY_BUTTON}
                    title="Delete endpoint"
                  >
                    {isDeleting ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <Trash2 size={12} />
                    )}
                    Delete
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className={CARD_CLASS}>
            <header className="flex items-center gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2.5 py-2">
              <KeyRound size={13} className="shrink-0 text-[var(--accent-primary)]" />
              <h3 className="break-words text-[11px] font-bold uppercase tracking-wide text-[var(--text-main)]">
                Snippet Generator
              </h3>
            </header>
            <div className="space-y-2 p-2.5">
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                    cURL
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopy(curlSnippet, 'cURL snippet copied.')}
                    className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                    aria-label="Copy cURL snippet"
                  >
                    <Copy size={10} />
                  </button>
                </div>
                <pre className="max-h-36 overflow-auto break-words whitespace-pre-wrap border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] p-2 font-mono text-[9px] leading-relaxed text-[var(--text-main)] rounded-[var(--border-radius)]">
                  {curlSnippet}
                </pre>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                    Jupyter Notebook
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleCopy(jupyterSnippet, 'Jupyter snippet copied.')}
                    className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                    aria-label="Copy Jupyter snippet"
                  >
                    <Copy size={10} />
                  </button>
                </div>
                <pre className="max-h-44 overflow-auto break-words whitespace-pre-wrap border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] p-2 font-mono text-[9px] leading-relaxed text-[var(--text-main)] rounded-[var(--border-radius)]">
                  {jupyterSnippet}
                </pre>
              </div>
            </div>
          </section>
        </aside>

        <section className={`${CARD_CLASS} flex min-w-0 flex-col overflow-hidden`}>
          <nav className="flex shrink-0 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)]">
            <button
              type="button"
              onClick={() => setActiveSubTab('script')}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 border-r-[length:var(--border-width)] border-[var(--border-color)] px-2 py-2 text-[11px] font-bold transition-colors ${
                activeSubTab === 'script'
                  ? 'bg-[var(--bg-card)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <Code2 size={12} className="shrink-0" />
              <span className="break-words">🐍 Python Handler Script</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('tester')}
              className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 py-2 text-[11px] font-bold transition-colors ${
                activeSubTab === 'tester'
                  ? 'bg-[var(--bg-card)] text-[var(--accent-primary)]'
                  : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <Zap size={12} className="shrink-0" />
              <span className="break-words">⚡ Test Endpoint</span>
            </button>
          </nav>

          {activeSubTab === 'script' ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex flex-wrap items-center justify-between gap-1.5 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5">
                <span className="break-words font-mono text-[10px] text-[var(--text-main)]">
                  def {form.function_name.trim() || 'handle_request'}(payload)
                </span>
                <span className={HINT_CLASS}>
                  dataiki_ctx = dataiki · get_published_model() · vault.get_connection()
                </span>
              </div>
              <div className="h-[560px] overflow-hidden bg-[var(--bg-input)]">
                <Editor
                  height="100%"
                  language="python"
                  value={form.api_logic_script}
                  onChange={(value) => patchForm({ api_logic_script: value ?? '' })}
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
            </div>
          ) : (
            <div className="min-h-0 flex-1 space-y-2 p-2.5">
              <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <span className={LABEL_CLASS}>Request Payload (JSON)</span>
                  <div className="h-[180px] overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
                    <Editor
                      height="100%"
                      language="json"
                      value={testPayload}
                      onChange={(value) => setTestPayload(value ?? '')}
                      theme={editorTheme}
                      options={{
                        minimap: { enabled: false },
                        fontSize: 12,
                        scrollBeyondLastLine: false,
                        wordWrap: 'on',
                        automaticLayout: true,
                        tabSize: 2,
                      }}
                    />
                  </div>
                </div>
                <div className="flex min-w-[200px] flex-col justify-end gap-1.5">
                  <label className="block">
                    <span className={LABEL_CLASS}>API Key (optional)</span>
                    <div className="flex items-stretch">
                      <input
                        type={showTestKey ? 'text' : 'password'}
                        value={testApiKey}
                        onChange={(event) => setTestApiKey(event.target.value)}
                        className={`${INPUT_CLASS} min-w-0 rounded-r-none`}
                        placeholder="dki_live_..."
                        autoComplete="off"
                      />
                      <button
                        type="button"
                        onClick={() => setShowTestKey((current) => !current)}
                        className={`${SECONDARY_BUTTON} shrink-0 rounded-l-none px-2`}
                        aria-label={showTestKey ? 'Hide API key' : 'Show API key'}
                      >
                        {showTestKey ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                    </div>
                  </label>
                  <button
                    type="button"
                    onClick={() => void handleTest()}
                    disabled={isTesting || !projectKey || !pathValue}
                    className={`${PRIMARY_BUTTON} w-full py-2`}
                  >
                    {isTesting ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Play size={13} />
                    )}
                    {isTesting ? 'Sending…' : 'Send Test Request'}
                  </button>
                  <p className={HINT_HELP}>
                    <ShieldCheck size={10} className="shrink-0" />
                    <span>
                      {form.require_api_key
                        ? 'Require API Key is on for this route.'
                        : 'This route does not require an API key.'}
                    </span>
                  </p>
                </div>
              </div>

              <p className={HINT_CLASS}>
                The gateway dispatches saved and enabled endpoints only. Save changes before
                testing a new route.
              </p>

              {testError && (
                <div className="flex items-start gap-2 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--bg-canvas)] px-2.5 py-2 rounded-[var(--border-radius)]">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--accent-danger)]" />
                  <p className="break-words text-[11px] text-[var(--text-main)]">{testError}</p>
                </div>
              )}

              {testResult ? (
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="inline-flex items-center gap-1 border-[length:var(--border-width)] px-2 py-1 font-mono text-[10px] font-bold rounded-[var(--border-radius)]"
                      style={{
                        borderColor: statusColor(testResult),
                        color: statusColor(testResult),
                      }}
                    >
                      <Check size={11} />
                      {statusLabel(testResult)}
                    </span>
                    <span className="inline-flex items-center border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
                      {testResult.duration_ms.toLocaleString(undefined, {
                        maximumFractionDigits: 1,
                      })}{' '}
                      ms
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        void handleCopy(prettyBody(testResult.data), 'Response body copied.')
                      }
                      className={`${SECONDARY_BUTTON} ml-auto px-1.5 py-1`}
                      title="Copy response body"
                    >
                      <Copy size={10} />
                    </button>
                  </div>
                  <pre className="max-h-[260px] overflow-auto break-words whitespace-pre-wrap border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 font-mono text-[10px] leading-relaxed text-[var(--text-main)] rounded-[var(--border-radius)]">
                    {prettyBody(testResult.data)}
                  </pre>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-8 text-center rounded-[var(--border-radius)]">
                  <Zap size={20} className="text-[var(--text-muted)]" />
                  <p className="text-xs font-bold text-[var(--text-main)]">No response yet</p>
                  <p className="max-w-sm text-[10px] text-[var(--text-muted)]">
                    Send a test request to see the HTTP status, response time, and JSON body here.
                  </p>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
