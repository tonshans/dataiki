import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import Editor from '@monaco-editor/react';
import type { Node } from '@xyflow/react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Combine,
  Database,
  Eye,
  FileText,
  FolderOpen,
  GitFork,
  Globe,
  Layers,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Server,
  Terminal,
  Upload,
  X,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import * as api from '../../api/client';
import type { UploadFileItem } from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type {
  CanvasNodeData,
  ConnectionItem,
  NodeConfig,
  PipelineDAG,
  RecipeActionType,
  RecipeStep,
  SqlSnippetItem,
} from '../../types/dataiki';
import { deobfuscateSecret } from '../../utils/projectDelimiter';

type CanvasFlowNode = Node<CanvasNodeData>;

interface ConfigProps {
  node: CanvasFlowNode;
}

interface ConfigModalProps {
  icon: LucideIcon;
  node: CanvasFlowNode;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}

interface TestOutcome {
  success: boolean;
  message: string;
}

const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)]';
const LABEL_CLASS =
  'mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const SECONDARY_BUTTON =
  'flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
const HINT_CLASS = 'text-[11px] text-[var(--text-muted)]';

const SOURCE_MODES = [
  { value: 'db', label: 'DB Query', icon: Database },
  { value: 'upload', label: 'File Upload', icon: Upload },
  { value: 'directory', label: 'Directory Scan', icon: FolderOpen },
  { value: 'api', label: 'REST API', icon: Globe },
] as const;
type SourceMode = (typeof SOURCE_MODES)[number]['value'];

const JOIN_TYPES = [
  { value: 'inner', label: 'INNER' },
  { value: 'left', label: 'LEFT' },
  { value: 'right', label: 'RIGHT' },
  { value: 'full', label: 'FULL OUTER' },
] as const;

const PYTHON_TEMPLATE = `import polars as pl

def transform(df: pl.DataFrame) -> pl.DataFrame:
    # Vault helper: dataiki_ctx.vault.get_secret("KEY_NAME")
    return df
`;

let localIdSequence = 0;
function makeLocalId(prefix: string): string {
  localIdSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${localIdSequence}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function currentDagFromStore(): PipelineDAG {
  const state = usePipelineStore.getState();
  const nodes: NodeConfig[] = state.nodes.map((node) => ({
    node_id: node.data.node_id,
    node_type: node.data.node_type,
    label: node.data.label,
    position: { x: node.position.x, y: node.position.y },
    params: { ...node.data.params },
    recipe_steps: node.data.recipe_steps ?? [],
  }));
  return {
    project_key: state.activeProjectKey,
    nodes,
    edges: state.edges.map((edge) => ({
      edge_id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
}

function persistNode(nodeId: string, patch: Partial<CanvasNodeData>): void {
  usePipelineStore.getState().updateNodeConfig(nodeId, patch);
}

async function syncDagToBackend(): Promise<void> {
  const state = usePipelineStore.getState();
  if (!state.activeProjectKey) throw new Error('No active project selected.');
  await api.saveDag(state.activeProjectKey, currentDagFromStore());
}

async function saveNodeToBackend(
  nodeId: string,
  patch: Partial<CanvasNodeData>,
): Promise<void> {
  persistNode(nodeId, patch);
  await syncDagToBackend();
}

async function executeAndPreview(
  nodeId: string,
  patch: Partial<CanvasNodeData>,
  splitBranch?: 'a' | 'b',
): Promise<void> {
  await saveNodeToBackend(nodeId, patch);

  const state = usePipelineStore.getState();
  if (!state.activeProjectKey) throw new Error('No active project selected.');

  state.setIsRawPreview(false);

  try {
    await api.runDag(
      state.activeProjectKey,
      nodeId,
      splitBranch ? { nodeId, branch: splitBranch } : null,
    );
    await usePipelineStore.getState().fetchNodePreview(nodeId);
  } finally {
    // runDag rewrites the persisted DAG when previewing a split branch; restore full DAG.
    if (splitBranch) {
      const latest = usePipelineStore.getState();
      if (latest.activeProjectKey) {
        await api.saveDag(latest.activeProjectKey, currentDagFromStore());
      }
    }
  }

  useUIStore.getState().setActiveBottomTab('preview');
}

async function previewRecipe(
  nodeId: string,
  steps: RecipeStep[],
  viewRaw: boolean,
): Promise<void> {
  const state = usePipelineStore.getState();
  state.updateNodeConfig(nodeId, { recipe_steps: steps });
  state.setIsRawPreview(viewRaw);
  await state.fetchNodePreview(nodeId);
  useUIStore.getState().setActiveBottomTab('preview');
}

function ConfigModal({
  icon: Icon,
  node,
  subtitle,
  children,
  footer,
}: ConfigModalProps) {
  const setActiveConfigNodeId = useUIStore((state) => state.setActiveConfigNodeId);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveConfigNodeId(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [setActiveConfigNodeId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setActiveConfigNodeId(null);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="node-config-title"
        className="relative z-[51] flex h-[min(880px,94vh)] w-[min(1120px,96vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-start gap-2">
            <Icon size={20} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
            <div className="min-w-0">
              <h2
                id="node-config-title"
                className="truncate text-lg font-bold text-[var(--text-main)]"
              >
                {node.data.label}
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">{subtitle}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setActiveConfigNodeId(null)}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
            aria-label="Close node configuration"
            title="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
          {footer}
        </div>
      </div>
    </div>
  );
}

/* =====================================================================
   1. DataSource
   ===================================================================== */

function modeFromParams(params: Record<string, any>): SourceMode {
  const declared = asText(params.source_mode) as SourceMode;
  if (SOURCE_MODES.some((mode) => mode.value === declared)) return declared;
  const sourceType = asText(params.source_type).toLowerCase();
  if (['db', 'database', 'db_query', 'sql'].includes(sourceType)) return 'db';
  if (['rest_api', 'api', 'http'].includes(sourceType)) return 'api';
  return params.scan_directory ? 'directory' : 'upload';
}

function parseHeadersJson(raw: string): Record<string, string> {
  const text = raw.trim();
  if (!text || text === '{}') return {};
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('REST headers must be a JSON object.');
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, String(value)]),
  );
}

function DataSourceConfig({ node }: ConfigProps) {
  const params = node.data.params ?? {};
  const addToast = useUIStore((state) => state.addToast);
  const close = useUIStore((state) => state.setActiveConfigNodeId);

  const initialMode = modeFromParams(params);
  const [mode, setMode] = useState<SourceMode>(initialMode);
  const [connectionId, setConnectionId] = useState(
    () => asText(params.conn_id) || asText(params.connection_id),
  );
  const [sqlText, setSqlText] = useState(
    () => asText(params.query) || asText(params.sql) || asText(params.sql_query),
  );
  const [snippetId, setSnippetId] = useState(() => asText(params.snippet_id));
  const [filePath, setFilePath] = useState(() =>
    initialMode === 'upload' || initialMode === 'directory'
      ? asText(params.file_path) || asText(params.query_or_path)
      : asText(params.file_path),
  );
  const [apiUrl, setApiUrl] = useState(() =>
    initialMode === 'api'
      ? asText(params.url) || asText(params.query_or_path)
      : asText(params.url),
  );
  const [headersJson, setHeadersJson] = useState(() => {
    const rawHeaders = params.headers;
    if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      return JSON.stringify(rawHeaders, null, 2);
    }
    return '{}';
  });

  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [snippets, setSnippets] = useState<SqlSnippetItem[]>([]);
  const [uploads, setUploads] = useState<UploadFileItem[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setAssetsLoading(true);
    void Promise.allSettled([
      api.fetchConnections(),
      api.fetchSnippets(),
      api.fetchUploads(),
    ]).then(([connectionResult, snippetResult, uploadResult]) => {
      if (cancelled) return;
      if (connectionResult.status === 'fulfilled') {
        setConnections(
          connectionResult.value.filter(
            (connection) => !connection.name.startsWith('__secret__'),
          ),
        );
      }
      if (snippetResult.status === 'fulfilled') setSnippets(snippetResult.value);
      if (uploadResult.status === 'fulfilled') setUploads(uploadResult.value);
      setAssetsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.conn_id === connectionId),
    [connectionId, connections],
  );

  const changeMode = (nextMode: SourceMode) => {
    setMode(nextMode);
    if (nextMode === 'db' && selectedConnection?.conn_type === 'rest_api') {
      setConnectionId('');
    }
    if (nextMode === 'api' && selectedConnection && selectedConnection.conn_type !== 'rest_api') {
      setConnectionId('');
    }
  };

  const buildParams = useCallback((): Record<string, any> => {
    let headers: Record<string, string> = {};
    if (mode === 'api') headers = parseHeadersJson(headersJson);

    const sourceType = mode === 'db' ? 'db' : mode === 'api' ? 'rest_api' : 'file';
    const query = mode === 'db' ? sqlText.trim() : '';
    const path = mode === 'db' ? sqlText.trim() : mode === 'api' ? apiUrl.trim() : filePath.trim();

    if (mode === 'db' && (!connectionId || !query)) {
      throw new Error('Vault connection and SQL query are required.');
    }
    if (mode === 'upload' && !path) {
      throw new Error('Choose or upload a file first.');
    }
    if (mode === 'directory' && !path) {
      throw new Error('Choose a file from storage/uploads/.');
    }
    if (mode === 'api' && !path) {
      throw new Error('REST API URL is required.');
    }

    return {
      source_type: sourceType,
      source_mode: mode,
      conn_id: mode === 'db' || mode === 'api' ? connectionId : '',
      connection_id: mode === 'db' || mode === 'api' ? connectionId : '',
      query,
      sql: query,
      query_or_path: path,
      file_path: mode === 'upload' || mode === 'directory' ? path : '',
      url: mode === 'api' ? path : '',
      headers: mode === 'api' ? headers : {},
      snippet_id: mode === 'db' ? snippetId : '',
      ...(mode === 'directory' ? { scan_directory: 'storage/uploads/' } : {}),
    };
  }, [
    apiUrl,
    connectionId,
    filePath,
    headersJson,
    mode,
    snippetId,
    sqlText,
  ]);

  const applySnippet = (nextSnippetId: string) => {
    setSnippetId(nextSnippetId);
    const snippet = snippets.find((item) => item.snippet_id === nextSnippetId);
    if (snippet) setSqlText(snippet.sql_text);
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setIsUploading(true);
    try {
      const uploaded = await api.uploadFile(file);
      setFilePath(uploaded.file_path);
      setUploads((current) => [
        {
          file_name: uploaded.file_name,
          file_path: uploaded.file_path,
          file_size_bytes: uploaded.file_size_bytes,
          file_size_mb: uploaded.file_size_mb,
        },
        ...current.filter((item) => item.file_path !== uploaded.file_path),
      ]);
      addToast('success', `Uploaded '${uploaded.file_name}'.`);
    } catch (error) {
      addToast('error', `Upload failed: ${messageOf(error)}`);
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleTestQuery = async () => {
    setTestOutcome(null);
    setIsTesting(true);
    try {
      let outcome: TestOutcome;
      if (mode === 'upload' || mode === 'directory') {
        if (!filePath.trim()) throw new Error('Choose a file first.');
        const list = await api.fetchUploads();
        const selected =
          list.find((item) => item.file_path === filePath.trim()) ??
          list.find(
            (item) =>
              item.file_name ===
              filePath.trim().split(/[\\/]/).filter(Boolean).pop(),
          );
        if (!selected) throw new Error(`File '${filePath.trim()}' was not found in uploads.`);
        outcome = {
          success: true,
          message: `${selected.file_name} is available (${selected.file_size_mb} MB).`,
        };
      } else {
        const headers = mode === 'api' ? parseHeadersJson(headersJson) : {};
        const connection = selectedConnection;
        if (mode === 'db' && !connection) {
          throw new Error('Choose a Vault connection first.');
        }
        const connectionUri =
          deobfuscateSecret(connection?.connection_uri ?? '') ||
          connection?.connection_uri ||
          '';
        const result = await api.testConnection({
          conn_type: connection?.conn_type ?? 'rest_api',
          connection_uri: mode === 'api' && !connection ? apiUrl.trim() : connectionUri,
          headers,
        });
        const success = Boolean(result.success ?? result.ok);
        const message =
          result.message ||
          result.detail ||
          (success ? 'Connection successful.' : 'Connection failed.');
        outcome = { success, message: String(message) };
      }
      setTestOutcome(outcome);
      addToast(outcome.success ? 'success' : 'error', outcome.message);
    } catch (error) {
      const message = messageOf(error);
      setTestOutcome({ success: false, message });
      addToast('error', `Connection test failed: ${message}`);
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async () => {
    try {
      const nextParams = buildParams();
      persistNode(node.id, { params: nextParams });
      await syncDagToBackend();
      addToast('success', `${node.data.label} saved.`);
      close(null);
    } catch (error) {
      addToast('error', `Failed to save node: ${messageOf(error)}`);
    }
  };

  const handlePreview = async () => {
    setIsPreviewing(true);
    try {
      await executeAndPreview(node.id, { params: buildParams() });
      addToast('success', 'DataSource preview loaded in the table drawer.');
      close(null);
    } catch (error) {
      addToast('error', `Preview failed: ${messageOf(error)}`);
    } finally {
      setIsPreviewing(false);
    }
  };

  const busy = isTesting || isPreviewing || isUploading;
  const presentConnections = connections.filter((connection) =>
    mode === 'db' ? connection.conn_type !== 'rest_api' : connection.conn_type === 'rest_api',
  );

  return (
    <ConfigModal
      icon={Database}
      node={node}
      subtitle="Read data from a Vault query, uploaded file, local directory scan, or REST API."
      footer={
        <>
          <button type="button" onClick={handleTestQuery} disabled={busy} className={SECONDARY_BUTTON}>
            {isTesting ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
            Test Query
          </button>
          <button type="button" onClick={() => void handlePreview()} disabled={busy} className={PRIMARY_BUTTON}>
            {isPreviewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
            Preview Data
          </button>
          <button type="button" onClick={() => close(null)} disabled={busy} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={busy} className={PRIMARY_BUTTON}>
            <Save size={13} />
            Save Node
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        {SOURCE_MODES.map((source) => {
          const Icon = source.icon;
          return (
            <button
              key={source.value}
              type="button"
              onClick={() => changeMode(source.value)}
              aria-pressed={mode === source.value}
              className={`flex items-center gap-2 border-[length:var(--border-width)] p-2.5 text-left text-xs font-bold rounded-[var(--border-radius)] ${
                mode === source.value
                  ? 'border-[var(--accent-primary)] bg-[var(--bg-hover)] text-[var(--text-main)]'
                  : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
              }`}
            >
              <Icon size={16} className="shrink-0 text-[var(--accent-primary)]" />
              {source.label}
            </button>
          );
        })}
      </div>

      <div className="mt-4 space-y-3">
        {mode === 'db' && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className={LABEL_CLASS}>Vault Connection Alias</span>
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Select Vault connection…</option>
                  {presentConnections.map((connection) => (
                    <option key={connection.conn_id} value={connection.conn_id}>
                      {connection.name} ({connection.conn_type})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL_CLASS}>SQL Snippet</span>
                <select
                  value={snippetId}
                  onChange={(event) => applySnippet(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Load from SQL snippets…</option>
                  {snippets.map((snippet) => (
                    <option key={snippet.snippet_id} value={snippet.snippet_id}>
                      {snippet.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className={LABEL_CLASS}>SQL Query</span>
              <textarea
                value={sqlText}
                onChange={(event) => setSqlText(event.target.value)}
                rows={8}
                spellCheck={false}
                placeholder="SELECT * FROM customers LIMIT 1000"
                className={`${INPUT_CLASS} resize-y font-mono`}
              />
            </label>
          </>
        )}

        {mode === 'upload' && (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <label className="block min-w-[240px] flex-1">
                <span className={LABEL_CLASS}>File Path</span>
                <input
                  value={filePath}
                  onChange={(event) => setFilePath(event.target.value)}
                  placeholder="storage/uploads/orders.csv"
                  className={`${INPUT_CLASS} font-mono`}
                />
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.tsv,.xlsx,.xls,.parquet,.json"
                onChange={(event) => void handleUpload(event)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploading}
                className={SECONDARY_BUTTON}
              >
                {isUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                Upload File
              </button>
            </div>
            <label className="block">
              <span className={LABEL_CLASS}>Existing Uploads</span>
              <select
                value={filePath}
                onChange={(event) => setFilePath(event.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">Select an uploaded file…</option>
                {uploads.map((file) => (
                  <option key={file.file_path} value={file.file_path}>
                    {file.file_name} ({file.file_size_mb} MB)
                  </option>
                ))}
              </select>
            </label>
          </>
        )}

        {mode === 'directory' && (
          <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] rounded-[var(--border-radius)]">
            <div className="flex items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2">
              <span className="text-xs font-bold text-[var(--text-main)]">
                storage/uploads/
              </span>
              <button
                type="button"
                onClick={() => {
                  setAssetsLoading(true);
                  void api
                    .fetchUploads()
                    .then(setUploads)
                    .catch((error) => addToast('error', `Scan failed: ${messageOf(error)}`))
                    .finally(() => setAssetsLoading(false));
                }}
                disabled={assetsLoading}
                className="flex items-center gap-1 text-[10px] font-bold text-[var(--text-muted)] hover:text-[var(--text-main)]"
              >
                <RefreshCw size={11} className={assetsLoading ? 'animate-spin' : ''} />
                Rescan
              </button>
            </div>
            <div className="max-h-64 overflow-y-auto">
              {assetsLoading ? (
                <p className={`${HINT_CLASS} p-3`}>Scanning directory…</p>
              ) : uploads.length === 0 ? (
                <p className={`${HINT_CLASS} p-3`}>No files found in storage/uploads/.</p>
              ) : (
                uploads.map((file) => (
                  <button
                    key={file.file_path}
                    type="button"
                    onClick={() => setFilePath(file.file_path)}
                    className={`flex w-full items-center justify-between gap-3 border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2 text-left last:border-b-0 ${
                      filePath === file.file_path
                        ? 'bg-[var(--bg-hover)]'
                        : 'bg-[var(--bg-card)] hover:bg-[var(--bg-hover)]'
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <FileText size={13} className="shrink-0 text-[var(--accent-primary)]" />
                      <span className="truncate font-mono text-xs text-[var(--text-main)]">
                        {file.file_name}
                      </span>
                    </span>
                    <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                      {file.file_size_mb} MB
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {mode === 'api' && (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block">
                <span className={LABEL_CLASS}>Vault REST Connection (optional)</span>
                <select
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                  className={INPUT_CLASS}
                >
                  <option value="">Use direct URL…</option>
                  {presentConnections.map((connection) => (
                    <option key={connection.conn_id} value={connection.conn_id}>
                      {connection.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className={LABEL_CLASS}>REST API URL</span>
                <input
                  value={apiUrl}
                  onChange={(event) => setApiUrl(event.target.value)}
                  placeholder="https://api.example.com/v1/records"
                  className={`${INPUT_CLASS} font-mono`}
                />
              </label>
            </div>
            <label className="block">
              <span className={LABEL_CLASS}>Headers (JSON)</span>
              <textarea
                value={headersJson}
                onChange={(event) => setHeadersJson(event.target.value)}
                rows={4}
                spellCheck={false}
                className={`${INPUT_CLASS} resize-y font-mono`}
              />
            </label>
          </>
        )}

        {testOutcome && (
          <div
            className={`flex items-start gap-2 border-[length:var(--border-width)] border-[var(--border-color)] p-2.5 text-xs rounded-[var(--border-radius)] ${
              testOutcome.success
                ? 'text-[var(--accent-secondary)]'
                : 'text-[var(--accent-danger)]'
            }`}
          >
            {testOutcome.success ? <Check size={14} className="mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="mt-0.5 shrink-0" />}
            <span className="break-words">{testOutcome.message}</span>
          </div>
        )}

        {assetsLoading && mode !== 'directory' && (
          <p className={`${HINT_CLASS} flex items-center gap-1.5`}>
            <Loader2 size={12} className="animate-spin" />
            Loading Vault aliases, snippets, and uploads…
          </p>
        )}
      </div>
    </ConfigModal>
  );
}

/* =====================================================================
   2. Recipe
   ===================================================================== */

interface RecipeField {
  key: string;
  label: string;
  placeholder?: string;
  kind?: 'text' | 'number' | 'select' | 'textarea' | 'list';
  options?: Array<{ value: string; label: string }>;
  required?: boolean;
  numeric?: boolean;
  defaultValue?: string;
}

interface RecipeActionMeta {
  label: string;
  fields: RecipeField[];
}

const RECIPE_ACTIONS: Record<RecipeActionType, RecipeActionMeta> = {
  drop_column: {
    label: 'Drop Column',
    fields: [
      { key: 'columns', label: 'Columns (comma separated)', kind: 'list', placeholder: 'col_a, col_b', required: true },
    ],
  },
  rename_column: {
    label: 'Rename Column',
    fields: [
      { key: 'old_name', label: 'Old Name', required: true },
      { key: 'new_name', label: 'New Name', required: true },
    ],
  },
  change_dtype: {
    label: 'Change Data Type',
    fields: [
      { key: 'column', label: 'Column', required: true },
      {
        key: 'target_dtype',
        label: 'Target Type',
        kind: 'select',
        required: true,
        options: ['int', 'float', 'str', 'bool', 'date', 'datetime'].map((value) => ({ value, label: value })),
      },
    ],
  },
  fill_na: {
    label: 'Fill Missing Values',
    fields: [
      { key: 'column', label: 'Column', required: true },
      {
        key: 'strategy',
        label: 'Strategy',
        kind: 'select',
        defaultValue: 'mean',
        options: ['constant', 'mean', 'median', 'mode', 'forward', 'backward'].map((value) => ({ value, label: value })),
      },
      { key: 'value', label: 'Constant Value', placeholder: '0 or text' },
    ],
  },
  filter_row: {
    label: 'Filter Rows',
    fields: [
      { key: 'column', label: 'Column', required: true },
      {
        key: 'operator',
        label: 'Operator',
        kind: 'select',
        defaultValue: '==',
        options: ['==', '!=', '>', '<', '>=', '<=', 'in', 'not_in', 'contains', 'regex', 'is_null', 'is_not_null'].map((value) => ({ value, label: value })),
      },
      { key: 'value', label: 'Value', placeholder: 'value or comma-separated list' },
    ],
  },
  formula_column: {
    label: 'Formula Column',
    fields: [
      { key: 'new_column', label: 'New Column', required: true },
      { key: 'formula', label: 'SQL Formula', kind: 'textarea', placeholder: '"price" * "qty"', required: true },
    ],
  },
  split_extract_text: {
    label: 'Split / Extract Text',
    fields: [
      { key: 'column', label: 'Column', required: true },
      { key: 'delimiter', label: 'Delimiter (split mode)', placeholder: ',' },
      { key: 'new_columns', label: 'New Columns', kind: 'list', placeholder: 'first, last' },
      { key: 'pattern', label: 'Regex Pattern (extract mode)', placeholder: '^(?<year>\\d{4})' },
      { key: 'new_column', label: 'Extracted Column' },
      { key: 'group_index', label: 'Regex Group Index', kind: 'number', defaultValue: '1' },
    ],
  },
  string_clean: {
    label: 'Clean Strings',
    fields: [
      { key: 'column', label: 'Column', required: true },
      { key: 'operations', label: 'Operations', kind: 'list', defaultValue: 'trim, lower', placeholder: 'trim, lower, upper' },
    ],
  },
  find_replace: {
    label: 'Find & Replace',
    fields: [
      { key: 'column', label: 'Column', required: true },
      { key: 'find', label: 'Find', required: true },
      { key: 'replace', label: 'Replace', required: true },
    ],
  },
  binning: {
    label: 'Binning',
    fields: [
      { key: 'column', label: 'Column', required: true },
      { key: 'new_column', label: 'New Column' },
      { key: 'bins', label: 'Bin Breaks (numeric list)', kind: 'list', numeric: true, placeholder: '0, 18, 35, 60' },
      { key: 'labels', label: 'Bin Labels', kind: 'list', placeholder: 'child, adult, senior' },
      { key: 'num_bins', label: 'Equal-Frequency Bins', kind: 'number', defaultValue: '5' },
    ],
  },
  clip_outliers: {
    label: 'Clip Outliers',
    fields: [
      { key: 'column', label: 'Column', required: true },
      { key: 'lower_quantile', label: 'Lower Quantile', kind: 'number', defaultValue: '0.05' },
      { key: 'upper_quantile', label: 'Upper Quantile', kind: 'number', defaultValue: '0.95' },
      { key: 'iqr_multiplier', label: 'IQR Multiplier (optional)', kind: 'number' },
    ],
  },
  datetime_extract: {
    label: 'Extract Datetime Features',
    fields: [
      { key: 'column', label: 'Datetime Column', required: true },
      {
        key: 'features',
        label: 'Features',
        kind: 'list',
        defaultValue: 'year, month, day, day_of_week, is_weekend',
        placeholder: 'year, month, day',
      },
    ],
  },
  auto_generate_features: {
    label: 'Auto Generate Features',
    fields: [
      { key: 'numeric_columns', label: 'Numeric Columns (empty = all)', kind: 'list', placeholder: 'amount, qty' },
      { key: 'operations', label: 'Operations', kind: 'list', defaultValue: 'interactions, squared, log' },
      { key: 'lags', label: 'Lag Steps', kind: 'list', numeric: true, placeholder: '1, 7, 30' },
      { key: 'group_by', label: 'Group By Column' },
      { key: 'aggregations', label: 'Aggregations', kind: 'list', defaultValue: 'mean, sum, count' },
    ],
  },
  augment_rows: {
    label: 'Augment Rows',
    fields: [
      {
        key: 'method',
        label: 'Method',
        kind: 'select',
        defaultValue: 'smote',
        options: [
          { value: 'smote', label: 'SMOTE Oversampling' },
          { value: 'jitter', label: 'Gaussian Jitter' },
        ],
      },
      { key: 'target_column', label: 'Target Column (SMOTE)', placeholder: 'target' },
      { key: 'k_neighbors', label: 'SMOTE Neighbors', kind: 'number', defaultValue: '5' },
      { key: 'numeric_columns', label: 'Numeric Columns (jitter)', kind: 'list' },
      { key: 'noise_scale', label: 'Noise Scale (jitter)', kind: 'number', defaultValue: '0.05' },
      { key: 'num_synthetic_rows', label: 'Synthetic Rows (jitter)', kind: 'number' },
    ],
  },
};

const RECIPE_LIST_KEYS = new Set([
  'columns',
  'new_columns',
  'operations',
  'bins',
  'labels',
  'features',
  'numeric_columns',
  'lags',
  'aggregations',
]);
const RECIPE_NUMBER_LIST_KEYS = new Set(['bins', 'lags']);
const RECIPE_NUMBER_KEYS = new Set([
  'group_index',
  'num_bins',
  'lower_quantile',
  'upper_quantile',
  'iqr_multiplier',
  'k_neighbors',
  'noise_scale',
  'num_synthetic_rows',
]);

interface RecipeFormStep {
  step_id: string;
  action: RecipeActionType;
  description: string;
  values: Record<string, string>;
}

function recipeDefaults(action: RecipeActionType): Record<string, string> {
  return Object.fromEntries(
    RECIPE_ACTIONS[action].fields
      .filter((field) => field.defaultValue !== undefined)
      .map((field) => [field.key, field.defaultValue ?? '']),
  );
}

function recipeStepToForm(step: RecipeStep): RecipeFormStep {
  const values: Record<string, string> = {};
  for (const field of RECIPE_ACTIONS[step.action]?.fields ?? []) {
    const raw = step.params?.[field.key];
    if (Array.isArray(raw)) values[field.key] = raw.join(', ');
    else if (raw !== undefined && raw !== null) values[field.key] = String(raw);
  }
  if (!values.column && step.column) values.column = step.column;

  return {
    step_id: step.step_id,
    action: step.action,
    description: step.description || RECIPE_ACTIONS[step.action]?.label || step.action,
    values,
  };
}

function formStepToRecipe(step: RecipeFormStep): RecipeStep {
  const params: Record<string, any> = {};
  for (const [key, raw] of Object.entries(step.values)) {
    const value = raw.trim();
    if (!value) continue;
    if (RECIPE_LIST_KEYS.has(key)) {
      const items = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      params[key] = RECIPE_NUMBER_LIST_KEYS.has(key)
        ? items.map(Number).filter((item) => Number.isFinite(item))
        : items;
    } else if (RECIPE_NUMBER_KEYS.has(key)) {
      const numberValue = Number(value);
      if (Number.isFinite(numberValue)) params[key] = numberValue;
    } else {
      params[key] = value;
    }
  }

  return {
    step_id: step.step_id,
    action: step.action,
    column: step.values.column?.trim() || undefined,
    params,
    train_only: step.action === 'augment_rows',
    description: step.description.trim() || RECIPE_ACTIONS[step.action].label,
  };
}

function validateRecipeSteps(steps: RecipeFormStep[]): string | null {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const meta = RECIPE_ACTIONS[step.action];
    for (const field of meta.fields) {
      if (field.required && !step.values[field.key]?.trim()) {
        return `Step ${index + 1} (${meta.label}) requires '${field.label}'.`;
      }
    }
    if (
      step.action === 'augment_rows' &&
      step.values.method === 'smote' &&
      !step.values.target_column?.trim()
    ) {
      return `Step ${index + 1} (Augment Rows) requires a target column for SMOTE.`;
    }
  }
  return null;
}

function RecipeConfig({ node }: ConfigProps) {
  const addToast = useUIStore((state) => state.addToast);
  const close = useUIStore((state) => state.setActiveConfigNodeId);
  const [steps, setSteps] = useState<RecipeFormStep[]>(() =>
    (node.data.recipe_steps ?? []).map(recipeStepToForm),
  );
  const [viewRaw, setViewRaw] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const updateStep = useCallback(
    (index: number, updater: (step: RecipeFormStep) => RecipeFormStep) => {
      setSteps((current) =>
        current.map((step, stepIndex) => (stepIndex === index ? updater(step) : step)),
      );
    },
    [],
  );

  const addStep = () => {
    const action: RecipeActionType = 'drop_column';
    setSteps((current) => [
      ...current,
      {
        step_id: makeLocalId('recipe'),
        action,
        description: RECIPE_ACTIONS[action].label,
        values: recipeDefaults(action),
      },
    ]);
  };

  const changeStepAction = (index: number, action: RecipeActionType) => {
    updateStep(index, (step) => ({
      ...step,
      action,
      description: RECIPE_ACTIONS[action].label,
      values: recipeDefaults(action),
    }));
  };

  const moveStep = (index: number, offset: number) => {
    setSteps((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const payloadSteps = () => steps.map(formStepToRecipe);

  const handlePreview = async () => {
    const validation = validateRecipeSteps(steps);
    if (validation) {
      addToast('warning', validation);
      return;
    }
    setIsPreviewing(true);
    try {
      await previewRecipe(node.id, payloadSteps(), viewRaw);
      addToast('success', `Recipe preview loaded (${steps.length} steps).`);
      close(null);
    } catch (error) {
      addToast('error', `Recipe preview failed: ${messageOf(error)}`);
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleSave = async () => {
    const validation = validateRecipeSteps(steps);
    if (validation) {
      addToast('warning', validation);
      return;
    }
    try {
      persistNode(node.id, { recipe_steps: payloadSteps() });
      await syncDagToBackend();
      addToast('success', `Recipe saved (${steps.length} steps).`);
      close(null);
    } catch (error) {
      addToast('error', `Failed to save recipe: ${messageOf(error)}`);
    }
  };

  return (
    <ConfigModal
      icon={Layers}
      node={node}
      subtitle="Stack wrangling steps in execution order. Train-only augmentation is skipped in testing and production."
      footer={
        <>
          <button type="button" onClick={addStep} disabled={isPreviewing} className={SECONDARY_BUTTON}>
            <Plus size={13} />
            Add Recipe Step
          </button>
          <button type="button" onClick={() => void handlePreview()} disabled={isPreviewing} className={PRIMARY_BUTTON}>
            {isPreviewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
            Preview Data
          </button>
          <button type="button" onClick={() => close(null)} disabled={isPreviewing} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={isPreviewing} className={PRIMARY_BUTTON}>
            <Save size={13} />
            Save Node
          </button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
        <div className="flex items-center gap-2">
          <Eye size={14} className="text-[var(--accent-primary)]" />
          <span className="text-xs font-bold text-[var(--text-main)]">View Mode</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setViewRaw(true)}
            className={`px-2.5 py-1 text-[11px] font-bold rounded-[var(--border-radius)] ${
              viewRaw
                ? 'bg-[var(--accent-primary)] text-[var(--bg-card)]'
                : 'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)]'
            }`}
          >
            View Raw
          </button>
          <button
            type="button"
            onClick={() => setViewRaw(false)}
            className={`px-2.5 py-1 text-[11px] font-bold rounded-[var(--border-radius)] ${
              !viewRaw
                ? 'bg-[var(--accent-primary)] text-[var(--bg-card)]'
                : 'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)]'
            }`}
          >
            View Processed
          </button>
        </div>
      </div>

      {steps.length === 0 ? (
        <div className="flex min-h-[180px] items-center justify-center border-[length:var(--border-width)] border-dashed border-[var(--border-color)] p-4 text-center text-xs text-[var(--text-muted)] rounded-[var(--border-radius)]">
          No recipe steps yet. Add a step to start wrangling.
        </div>
      ) : (
        <div className="space-y-2.5">
          {steps.map((step, index) => {
            const meta = RECIPE_ACTIONS[step.action];
            const trainOnly = step.action === 'augment_rows';
            return (
              <div
                key={step.step_id}
                className={trainOnly ? 'hazard-stripes p-1.5 rounded-[var(--border-radius)]' : ''}
              >
                <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-2.5 rounded-[var(--border-radius)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center bg-[var(--bg-canvas)] text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
                      {index + 1}
                    </span>
                    <select
                      value={step.action}
                      onChange={(event) =>
                        changeStepAction(index, event.target.value as RecipeActionType)
                      }
                      className={`${INPUT_CLASS} max-w-[280px] flex-1`}
                    >
                      {(Object.keys(RECIPE_ACTIONS) as RecipeActionType[]).map((action) => (
                        <option key={action} value={action}>
                          {RECIPE_ACTIONS[action].label}
                        </option>
                      ))}
                    </select>
                    {trainOnly && (
                      <span className="shrink-0 bg-[var(--accent-warning)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
                        🛠️ TRAIN-ONLY
                      </span>
                    )}
                    <div className="ml-auto flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                        className="flex h-7 w-7 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] disabled:opacity-40"
                        title="Move step up"
                      >
                        <ChevronUp size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveStep(index, 1)}
                        disabled={index === steps.length - 1}
                        className="flex h-7 w-7 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] disabled:opacity-40"
                        title="Move step down"
                      >
                        <ChevronDown size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSteps((current) =>
                            current.filter((item) => item.step_id !== step.step_id),
                          )
                        }
                        className="flex h-7 w-7 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--accent-danger)] rounded-[var(--border-radius)]"
                        title="Remove step"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <label className="block md:col-span-2">
                      <span className={LABEL_CLASS}>Step Description</span>
                      <input
                        value={step.description}
                        onChange={(event) =>
                          updateStep(index, (current) => ({
                            ...current,
                            description: event.target.value,
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </label>
                    {meta.fields.map((field) => {
                      const value = step.values[field.key] ?? '';
                      const setValue = (nextValue: string) =>
                        updateStep(index, (current) => ({
                          ...current,
                          values: { ...current.values, [field.key]: nextValue },
                        }));

                      if (field.kind === 'select') {
                        return (
                          <label key={field.key} className="block">
                            <span className={LABEL_CLASS}>
                              {field.label}
                              {field.required ? ' *' : ''}
                            </span>
                            <select
                              value={value}
                              onChange={(event) => setValue(event.target.value)}
                              className={INPUT_CLASS}
                            >
                              <option value="">Select…</option>
                              {field.options?.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        );
                      }

                      if (field.kind === 'textarea') {
                        return (
                          <label key={field.key} className="block md:col-span-2">
                            <span className={LABEL_CLASS}>
                              {field.label}
                              {field.required ? ' *' : ''}
                            </span>
                            <textarea
                              value={value}
                              onChange={(event) => setValue(event.target.value)}
                              rows={2}
                              spellCheck={false}
                              placeholder={field.placeholder}
                              className={`${INPUT_CLASS} resize-y font-mono`}
                            />
                          </label>
                        );
                      }

                      return (
                        <label key={field.key} className="block">
                          <span className={LABEL_CLASS}>
                            {field.label}
                            {field.required ? ' *' : ''}
                          </span>
                          <input
                            value={value}
                            onChange={(event) => setValue(event.target.value)}
                            inputMode={field.kind === 'number' ? 'decimal' : undefined}
                            placeholder={field.placeholder}
                            className={INPUT_CLASS}
                          />
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </ConfigModal>
  );
}

/* =====================================================================
   3. Split Data
   ===================================================================== */

function SplitDataConfig({ node }: ConfigProps) {
  const params = node.data.params ?? {};
  const addToast = useUIStore((state) => state.addToast);
  const close = useUIStore((state) => state.setActiveConfigNodeId);
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const tabularPreview = usePipelineStore((state) => state.tabularPreview);

  const initialPathA = Array.isArray(params.path_a_columns)
    ? params.path_a_columns.map(String)
    : [];
  const initialPathB = Array.isArray(params.path_b_columns)
    ? params.path_b_columns.map(String)
    : [];

  const [columns, setColumns] = useState<string[]>(() =>
    Array.from(new Set([...initialPathA, ...initialPathB])),
  );
  const [pathA, setPathA] = useState<string[]>(initialPathA);
  const [manualColumn, setManualColumn] = useState('');
  const [previewBranch, setPreviewBranch] = useState<'a' | 'b'>('a');
  const [isLoadingColumns, setIsLoadingColumns] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const loadColumns = useCallback(async () => {
    if (!projectKey) return;
    setIsLoadingColumns(true);
    try {
      const preview = await api.fetchNodePreview(projectKey, node.id);
      setColumns((current) =>
        Array.from(
          new Set([...current, ...preview.headers.map((header) => header.column_name)]),
        ),
      );
    } catch {
      // Schema is optional; users can add column names manually.
    } finally {
      setIsLoadingColumns(false);
    }
  }, [node.id, projectKey]);

  useEffect(() => {
    if (tabularPreview?.node_id === node.id) {
      setColumns((current) =>
        Array.from(
          new Set([
            ...current,
            ...tabularPreview.headers.map((header) => header.column_name),
          ]),
        ),
      );
      return;
    }
    void loadColumns();
  }, [loadColumns, node.id, tabularPreview]);

  const pathB = columns.filter((column) => !pathA.includes(column));
  const togglePathA = (column: string) => {
    setPathA((current) =>
      current.includes(column)
        ? current.filter((item) => item !== column)
        : [...current, column],
    );
  };

  const addManualColumn = () => {
    const next = manualColumn.trim();
    if (!next) return;
    setColumns((current) => (current.includes(next) ? current : [...current, next]));
    setPathA((current) => (current.includes(next) ? current : [...current, next]));
    setManualColumn('');
  };

  const buildParams = () => ({
    path_a_columns: pathA,
    path_b_columns: pathB,
  });

  const handleSave = async () => {
    try {
      persistNode(node.id, { params: { ...params, ...buildParams() } });
      await syncDagToBackend();
      addToast('success', 'Split Data saved.');
      close(null);
    } catch (error) {
      addToast('error', `Failed to save split: ${messageOf(error)}`);
    }
  };

  const handlePreview = async () => {
    setIsPreviewing(true);
    try {
      await executeAndPreview(
        node.id,
        { params: { ...params, ...buildParams() } },
        previewBranch,
      );
      addToast('success', `Split preview loaded for Path ${previewBranch.toUpperCase()}.`);
      close(null);
    } catch (error) {
      addToast('error', `Split preview failed: ${messageOf(error)}`);
    } finally {
      setIsPreviewing(false);
    }
  };

  return (
    <ConfigModal
      icon={GitFork}
      node={node}
      subtitle="Send checked columns to Path A. Unchecked columns automatically flow to Path B."
      footer={
        <>
          <button type="button" onClick={() => void handlePreview()} disabled={isPreviewing} className={PRIMARY_BUTTON}>
            {isPreviewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
            Preview Split
          </button>
          <button type="button" onClick={() => close(null)} disabled={isPreviewing} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={isPreviewing} className={PRIMARY_BUTTON}>
            <Save size={13} />
            Save Node
          </button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={HINT_CLASS}>Preview branch</span>
          {(['a', 'b'] as const).map((branch) => (
            <button
              key={branch}
              type="button"
              onClick={() => setPreviewBranch(branch)}
              className={`px-2.5 py-1 text-[11px] font-bold rounded-[var(--border-radius)] ${
                previewBranch === branch
                  ? 'bg-[var(--accent-primary)] text-[var(--bg-card)]'
                  : 'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)]'
              }`}
            >
              Path {branch.toUpperCase()}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void loadColumns()}
          disabled={isLoadingColumns}
          className={SECONDARY_BUTTON}
        >
          <RefreshCw size={13} className={isLoadingColumns ? 'animate-spin' : ''} />
          Refresh Columns
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
          <div className="flex items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
            <span className="text-xs font-bold text-[var(--text-main)]">Path A</span>
            <span className={HINT_CLASS}>{pathA.length} selected</span>
          </div>
          <div className="max-h-[360px] overflow-y-auto p-2">
            {isLoadingColumns && columns.length === 0 ? (
              <p className={`${HINT_CLASS} flex items-center gap-1.5 p-2`}>
                <Loader2 size={12} className="animate-spin" />
                Loading columns…
              </p>
            ) : columns.length === 0 ? (
              <p className={`${HINT_CLASS} p-2`}>No columns loaded yet.</p>
            ) : (
              columns.map((column) => (
                <label
                  key={column}
                  className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs text-[var(--text-main)] hover:bg-[var(--bg-hover)] rounded-[var(--border-radius)]"
                >
                  <input
                    type="checkbox"
                    checked={pathA.includes(column)}
                    onChange={() => togglePathA(column)}
                    className="h-4 w-4 accent-[var(--accent-primary)]"
                  />
                  <span className="truncate font-mono">{column}</span>
                </label>
              ))
            )}
          </div>
          <div className="flex items-center gap-1.5 border-t-[length:var(--border-width)] border-[var(--border-color)] p-2">
            <input
              value={manualColumn}
              onChange={(event) => setManualColumn(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addManualColumn();
                }
              }}
              placeholder="Add column…"
              className={`${INPUT_CLASS} font-mono`}
            />
            <button type="button" onClick={addManualColumn} className={SECONDARY_BUTTON}>
              <Plus size={13} />
            </button>
          </div>
        </div>

        <div className="border-[length:var(--border-width)] border-[var(--border-color)] rounded-[var(--border-radius)]">
          <div className="flex items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
            <span className="text-xs font-bold text-[var(--text-main)]">Path B (complement)</span>
            <span className={HINT_CLASS}>{pathB.length} columns</span>
          </div>
          <div className="max-h-[400px] overflow-y-auto p-2">
            {pathB.length === 0 ? (
              <p className={`${HINT_CLASS} p-2`}>All columns are assigned to Path A.</p>
            ) : (
              pathB.map((column) => (
                <div key={column} className="px-2 py-1.5 font-mono text-xs text-[var(--text-muted)]">
                  {column}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </ConfigModal>
  );
}

/* =====================================================================
   4. Joiner
   ===================================================================== */

function JoinVenn({ type }: { type: string }) {
  const leftActive = type === 'inner' || type === 'left' || type === 'full';
  const rightActive = type === 'inner' || type === 'right' || type === 'full';
  return (
    <span className="relative block h-7 w-12 shrink-0">
      <span
        className={`absolute left-0 top-0 h-7 w-7 rounded-full border-[length:var(--border-width)] border-[var(--border-color)] ${
          leftActive ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-card)]'
        }`}
      />
      <span
        className={`absolute right-0 top-0 h-7 w-7 rounded-full border-[length:var(--border-width)] border-[var(--border-color)] ${
          rightActive ? 'bg-[var(--accent-secondary)]' : 'bg-[var(--bg-card)]'
        }`}
      />
    </span>
  );
}

function JoinerConfig({ node }: ConfigProps) {
  const params = node.data.params ?? {};
  const addToast = useUIStore((state) => state.addToast);
  const close = useUIStore((state) => state.setActiveConfigNodeId);
  const projectKey = usePipelineStore((state) => state.activeProjectKey);
  const nodes = usePipelineStore((state) => state.nodes);
  const edges = usePipelineStore((state) => state.edges);

  const joinedEdge = useMemo(() => edges.filter((edge) => edge.target === node.id), [edges, node.id]);
  const leftEdge =
    joinedEdge.find((edge) => edge.targetHandle === 'input_left') ?? joinedEdge[0];
  const rightEdge =
    joinedEdge.find((edge) => edge.targetHandle === 'input_right') ?? joinedEdge[1];
  const leftNode = nodes.find((item) => item.id === leftEdge?.source);
  const rightNode = nodes.find((item) => item.id === rightEdge?.source);

  const [joinType, setJoinType] = useState(
    () => asText(params.join_type).toLowerCase() || 'inner',
  );
  const [leftOn, setLeftOn] = useState(() => asText(params.left_on));
  const [rightOn, setRightOn] = useState(() => asText(params.right_on));
  const [leftColumns, setLeftColumns] = useState<string[]>([]);
  const [rightColumns, setRightColumns] = useState<string[]>([]);
  const [isLoadingColumns, setIsLoadingColumns] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const loadColumns = useCallback(async () => {
    if (!projectKey) return;
    setIsLoadingColumns(true);
    try {
      const [leftPreview, rightPreview] = await Promise.allSettled([
        leftEdge ? api.fetchNodePreview(projectKey, leftEdge.source) : Promise.resolve(null),
        rightEdge ? api.fetchNodePreview(projectKey, rightEdge.source) : Promise.resolve(null),
      ]);
      if (leftPreview.status === 'fulfilled' && leftPreview.value) {
        setLeftColumns(leftPreview.value.headers.map((header) => header.column_name));
      }
      if (rightPreview.status === 'fulfilled' && rightPreview.value) {
        setRightColumns(rightPreview.value.headers.map((header) => header.column_name));
      }
    } finally {
      setIsLoadingColumns(false);
    }
  }, [leftEdge, projectKey, rightEdge]);

  useEffect(() => {
    void loadColumns();
  }, [loadColumns]);

  const buildParams = () => ({
    join_type: joinType,
    left_on: leftOn.trim(),
    right_on: rightOn.trim(),
    left_node_id: leftEdge?.source ?? '',
    right_node_id: rightEdge?.source ?? '',
  });

  const handleSave = async () => {
    if (!leftOn.trim() || !rightOn.trim()) {
      addToast('warning', 'Both left and right join keys are required.');
      return;
    }
    try {
      persistNode(node.id, { params: { ...params, ...buildParams() } });
      await syncDagToBackend();
      addToast('success', 'Joiner saved.');
      close(null);
    } catch (error) {
      addToast('error', `Failed to save joiner: ${messageOf(error)}`);
    }
  };

  const handlePreview = async () => {
    if (!leftOn.trim() || !rightOn.trim()) {
      addToast('warning', 'Both left and right join keys are required.');
      return;
    }
    setIsPreviewing(true);
    try {
      await executeAndPreview(
        node.id,
        { params: { ...params, ...buildParams() } },
      );
      addToast('success', 'Join preview loaded in the table drawer.');
      close(null);
    } catch (error) {
      addToast('error', `Join preview failed: ${messageOf(error)}`);
    } finally {
      setIsPreviewing(false);
    }
  };

  const renderKeyControl = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    columns: string[],
  ) => (
    <label className="block">
      <span className={LABEL_CLASS}>{label}</span>
      {columns.length > 0 ? (
        <select value={value} onChange={(event) => onChange(event.target.value)} className={INPUT_CLASS}>
          <option value="">Select key…</option>
          {columns.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="key_column"
          className={`${INPUT_CLASS} font-mono`}
        />
      )}
    </label>
  );

  return (
    <ConfigModal
      icon={Combine}
      node={node}
      subtitle="Join two incoming tables on matching keys."
      footer={
        <>
          <button type="button" onClick={() => void handlePreview()} disabled={isPreviewing} className={PRIMARY_BUTTON}>
            {isPreviewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
            Preview Join
          </button>
          <button type="button" onClick={() => close(null)} disabled={isPreviewing} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={isPreviewing} className={PRIMARY_BUTTON}>
            <Save size={13} />
            Save Node
          </button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        {[
          { label: 'Left Table', node: leftNode, handle: 'input_left' },
          { label: 'Right Table', node: rightNode, handle: 'input_right' },
        ].map((source) => (
          <div
            key={source.handle}
            className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-3 rounded-[var(--border-radius)]"
          >
            <p className={LABEL_CLASS}>{source.label}</p>
            <p className="truncate text-sm font-bold text-[var(--text-main)]">
              {source.node?.data.label ?? 'Not connected'}
            </p>
            <p className={`${HINT_CLASS} mt-1 font-mono`}>
              {source.node?.id ?? '—'}
            </p>
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>Join Type</span>
        <button
          type="button"
          onClick={() => void loadColumns()}
          disabled={isLoadingColumns}
          className={SECONDARY_BUTTON}
        >
          <RefreshCw size={13} className={isLoadingColumns ? 'animate-spin' : ''} />
          Refresh Columns
        </button>
      </div>

      <div className="mt-1 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {JOIN_TYPES.map((type) => (
          <button
            key={type.value}
            type="button"
            onClick={() => setJoinType(type.value)}
            aria-pressed={joinType === type.value}
            className={`flex items-center gap-2 border-[length:var(--border-width)] p-2 text-left text-[11px] font-bold rounded-[var(--border-radius)] ${
              joinType === type.value
                ? 'border-[var(--accent-primary)] bg-[var(--bg-hover)] text-[var(--text-main)]'
                : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <JoinVenn type={type.value} />
            {type.label}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {renderKeyControl('Left Key (left_on)', leftOn, setLeftOn, leftColumns)}
        {renderKeyControl('Right Key (right_on)', rightOn, setRightOn, rightColumns)}
      </div>

      <p className={`${HINT_CLASS} mt-2`}>
        Left key and right key are paired as `left_on = right_on`.
      </p>
    </ConfigModal>
  );
}

/* =====================================================================
   5. Python Script
   ===================================================================== */

function PythonScriptConfig({ node }: ConfigProps) {
  const params = node.data.params ?? {};
  const addToast = useUIStore((state) => state.addToast);
  const close = useUIStore((state) => state.setActiveConfigNodeId);
  const activeTheme = useUIStore((state) => state.activeTheme);
  const [code, setCode] = useState(() => asText(params.code) || PYTHON_TEMPLATE);
  const [isRunning, setIsRunning] = useState(false);

  const validateCode = (): boolean => {
    if (!/def\s+transform\s*\(\s*df\s*:\s*pl\.DataFrame\s*\)\s*->\s*pl\.DataFrame\s*:/.test(code)) {
      addToast(
        'warning',
        'Script must define: def transform(df: pl.DataFrame) -> pl.DataFrame:',
      );
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validateCode()) return;
    try {
      persistNode(node.id, { params: { ...params, code } });
      await syncDagToBackend();
      addToast('success', 'Python Script saved.');
      close(null);
    } catch (error) {
      addToast('error', `Failed to save script: ${messageOf(error)}`);
    }
  };

  const handleRun = async () => {
    if (!validateCode()) return;
    setIsRunning(true);
    try {
      await executeAndPreview(node.id, { params: { ...params, code } });
      addToast('success', 'Script output loaded in the table drawer.');
      close(null);
    } catch (error) {
      addToast('error', `Run Script failed: ${messageOf(error)}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <ConfigModal
      icon={Terminal}
      node={node}
      subtitle="Monaco Python editor with Polars DataFrame input and output."
      footer={
        <>
          <button type="button" onClick={() => void handleRun()} disabled={isRunning} className={PRIMARY_BUTTON}>
            {isRunning ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            Run Script
          </button>
          <button type="button" onClick={() => close(null)} disabled={isRunning} className={SECONDARY_BUTTON}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSave()} disabled={isRunning} className={PRIMARY_BUTTON}>
            <Save size={13} />
            Save Node
          </button>
        </>
      }
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2 rounded-[var(--border-radius)]">
        <div className="flex min-w-0 items-center gap-2">
          <Server size={14} className="shrink-0 text-[var(--accent-primary)]" />
          <span className="truncate font-mono text-[11px] text-[var(--text-main)]">
            dataiki_ctx.vault.get_secret(&quot;KEY_NAME&quot;)
          </span>
        </div>
        <span className={HINT_CLASS}>Required: def transform(df: pl.DataFrame) -&gt; pl.DataFrame</span>
      </div>

      <div className="h-[430px] overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] rounded-[var(--border-radius)]">
        <Editor
          height="100%"
          language="python"
          value={code}
          onChange={(value) => setCode(value ?? '')}
          theme={activeTheme === 'midnight' ? 'vs-dark' : 'light'}
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
    </ConfigModal>
  );
}

/* =====================================================================
   Dispatcher
   ===================================================================== */

export function NodeConfigModals() {
  const activeNodeId = useUIStore((state) => state.activeConfigNodeId);
  const node = usePipelineStore((state) =>
    state.nodes.find((item) => item.id === activeNodeId),
  );

  if (!activeNodeId || !node || node.data.is_ghost) return null;

  switch (node.data.ui_node_kind) {
    case 'datasource':
      return <DataSourceConfig key={node.id} node={node} />;
    case 'recipe':
      return <RecipeConfig key={node.id} node={node} />;
    case 'split_data':
      return <SplitDataConfig key={node.id} node={node} />;
    case 'joiner':
      return <JoinerConfig key={node.id} node={node} />;
    case 'python_script':
      return <PythonScriptConfig key={node.id} node={node} />;
    default:
      return null;
  }
}
