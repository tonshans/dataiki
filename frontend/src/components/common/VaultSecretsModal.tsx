import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Editor from '@monaco-editor/react';
import {
  Code2,
  Database,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Trash2,
  X,
} from 'lucide-react';
import * as api from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { ConnectionItem, VaultSecretItem } from '../../types/dataiki';
import {
  deobfuscateSecret,
  maskConnectionString,
  obfuscateSecret,
} from '../../utils/projectDelimiter';

type VaultTab = 'connections' | 'secrets' | 'snippets';
type ConnectionType = ConnectionItem['conn_type'];

const CONNECTION_TYPES: Array<{ value: ConnectionType; label: string }> = [
  { value: 'postgres', label: 'PostgreSQL' },
  { value: 'mysql', label: 'MySQL' },
  { value: 'mssql', label: 'Microsoft SQL Server' },
  { value: 'oracle', label: 'Oracle' },
  { value: 'sqlite', label: 'SQLite' },
  { value: 'rest_api', label: 'REST API' },
];

const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)]';

const LABEL_CLASS =
  'mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]';

let localIdSequence = 0;

function makeLocalId(prefix: string): string {
  localIdSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${localIdSequence}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function secureConnection(connection: ConnectionItem): ConnectionItem {
  return {
    ...connection,
    // The persisted store is display-only; keep credentials out of plain localStorage.
    connection_uri: obfuscateSecret(connection.connection_uri),
    headers_json:
      connection.headers_json && connection.headers_json !== '{}'
        ? obfuscateSecret(connection.headers_json)
        : '{}',
  };
}

function maskedConnectionUri(connection: ConnectionItem): string {
  const plain = deobfuscateSecret(connection.connection_uri) || connection.connection_uri;
  return maskConnectionString(plain);
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

export function VaultSecretsModal() {
  const isOpen = useUIStore((state) => state.isVaultModalOpen);
  const setVaultModalOpen = useUIStore((state) => state.setVaultModalOpen);
  const addToast = useUIStore((state) => state.addToast);
  const activeTheme = useUIStore((state) => state.activeTheme);

  const connections = usePipelineStore((state) => state.connections);
  const vaultSecrets = usePipelineStore((state) => state.vaultSecrets);
  const sqlSnippets = usePipelineStore((state) => state.sqlSnippets);

  const [activeTab, setActiveTab] = useState<VaultTab>('connections');
  const [isLoading, setIsLoading] = useState(false);

  const [connectionName, setConnectionName] = useState('');
  const [connectionType, setConnectionType] = useState<ConnectionType>('postgres');
  const [connectionUri, setConnectionUri] = useState('');
  const [headersJson, setHeadersJson] = useState('{}');
  const [isSavingConnection, setIsSavingConnection] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [deletingConnectionId, setDeletingConnectionId] = useState<string | null>(null);

  const [secretKeyName, setSecretKeyName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [revealSecretValue, setRevealSecretValue] = useState(false);
  const [secretDescription, setSecretDescription] = useState('');

  const [snippetTitle, setSnippetTitle] = useState('');
  const [snippetSql, setSnippetSql] = useState('');
  const [isSavingSnippet, setIsSavingSnippet] = useState(false);
  const [deletingSnippetId, setDeletingSnippetId] = useState<string | null>(null);

  const visibleConnections = connections.filter(
    (connection) => !connection.name.startsWith('__secret__'),
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setIsLoading(true);

    void Promise.allSettled([api.fetchConnections(), api.fetchSnippets()]).then(
      ([connectionsResult, snippetsResult]) => {
        if (cancelled) return;

        if (connectionsResult.status === 'fulfilled') {
          usePipelineStore.setState({
            connections: connectionsResult.value
              .filter((connection) => !connection.name.startsWith('__secret__'))
              .map(secureConnection),
          });
        } else {
          addToast(
            'error',
            `Failed to load connections: ${messageOf(connectionsResult.reason)}`,
          );
        }

        if (snippetsResult.status === 'fulfilled') {
          usePipelineStore.setState({ sqlSnippets: snippetsResult.value });
        } else {
          addToast(
            'error',
            `Failed to load SQL snippets: ${messageOf(snippetsResult.reason)}`,
          );
        }

        setIsLoading(false);
      },
    );

    return () => {
      cancelled = true;
    };
  }, [isOpen, addToast]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setVaultModalOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setVaultModalOpen]);

  if (!isOpen) return null;

  const saveConnection = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = connectionName.trim();
    const uri = connectionUri.trim();
    if (!name || !uri) {
      addToast('warning', 'Connection name and URI are required.');
      return;
    }

    let headers: Record<string, string> = {};
    try {
      if (connectionType === 'rest_api') headers = parseHeadersJson(headersJson);
    } catch (error) {
      addToast('error', messageOf(error));
      return;
    }

    setIsSavingConnection(true);
    try {
      const saved = await api.createConnection({
        name,
        conn_type: connectionType,
        connection_uri: uri,
        headers,
      });
      const secured = secureConnection(saved);
      usePipelineStore.setState((state) => ({
        connections: [
          secured,
          ...state.connections.filter((connection) => connection.conn_id !== secured.conn_id),
        ],
      }));
      setConnectionName('');
      setConnectionUri('');
      setHeadersJson('{}');
      setConnectionTest(null);
      addToast('success', `Connection '${name}' saved.`);
    } catch (error) {
      addToast('error', `Failed to save connection: ${messageOf(error)}`);
    } finally {
      setIsSavingConnection(false);
    }
  };

  const testNewConnection = async () => {
    const uri = connectionUri.trim();
    if (!uri) {
      addToast('warning', 'Connection URI is required before testing.');
      return;
    }

    let headers: Record<string, string> = {};
    try {
      if (connectionType === 'rest_api') headers = parseHeadersJson(headersJson);
    } catch (error) {
      addToast('error', messageOf(error));
      return;
    }

    setIsTestingConnection(true);
    setConnectionTest(null);
    try {
      const result = await api.testConnection({
        conn_type: connectionType,
        connection_uri: uri,
        headers,
      });
      const success = Boolean(result.success ?? result.ok);
      setConnectionTest({
        success,
        message:
          String(result.message ?? '') ||
          (success ? 'Connection successful.' : 'Connection failed.'),
      });
    } catch (error) {
      setConnectionTest({ success: false, message: messageOf(error) });
    } finally {
      setIsTestingConnection(false);
    }
  };

  const deleteConnection = async (connId: string) => {
    setDeletingConnectionId(connId);
    try {
      await api.deleteConnection(connId);
      usePipelineStore.setState((state) => ({
        connections: state.connections.filter((connection) => connection.conn_id !== connId),
      }));
      addToast('success', 'Connection deleted.');
    } catch (error) {
      addToast('error', `Failed to delete connection: ${messageOf(error)}`);
    } finally {
      setDeletingConnectionId(null);
    }
  };

  const saveSecret = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const keyName = secretKeyName.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) {
      addToast('warning', 'Secret key must be a valid environment variable name.');
      return;
    }
    if (!secretValue) {
      addToast('warning', 'Secret value is required.');
      return;
    }
    if (vaultSecrets.some((secret) => secret.key_name === keyName)) {
      addToast('warning', `Secret '${keyName}' already exists. Delete it first.`);
      return;
    }

    const secret: VaultSecretItem = {
      secret_id: makeLocalId('secret'),
      key_name: keyName,
      secret_value: obfuscateSecret(secretValue),
      description: secretDescription.trim() || undefined,
      created_at: new Date().toISOString(),
    };
    usePipelineStore.setState((state) => ({
      vaultSecrets: [secret, ...state.vaultSecrets],
    }));
    setSecretKeyName('');
    setSecretValue('');
    setSecretDescription('');
    setRevealSecretValue(false);
    addToast('success', `Secret '${keyName}' saved.`);
  };

  const deleteSecret = (secretId: string, keyName: string) => {
    usePipelineStore.setState((state) => ({
      vaultSecrets: state.vaultSecrets.filter((secret) => secret.secret_id !== secretId),
    }));
    addToast('success', `Secret '${keyName}' deleted.`);
  };

  const saveSnippet = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const title = snippetTitle.trim();
    const sql = snippetSql.trim();
    if (!title || !sql) {
      addToast('warning', 'Snippet title and SQL text are required.');
      return;
    }

    setIsSavingSnippet(true);
    try {
      const saved = await api.createSnippet({ title, sql_text: sql });
      usePipelineStore.setState((state) => ({
        sqlSnippets: [
          saved,
          ...state.sqlSnippets.filter((snippet) => snippet.snippet_id !== saved.snippet_id),
        ],
      }));
      setSnippetTitle('');
      setSnippetSql('');
      addToast('success', `SQL snippet '${title}' saved.`);
    } catch (error) {
      addToast('error', `Failed to save SQL snippet: ${messageOf(error)}`);
    } finally {
      setIsSavingSnippet(false);
    }
  };

  const deleteSnippet = async (snippetId: string) => {
    setDeletingSnippetId(snippetId);
    try {
      await api.deleteSnippet(snippetId);
      usePipelineStore.setState((state) => ({
        sqlSnippets: state.sqlSnippets.filter((snippet) => snippet.snippet_id !== snippetId),
      }));
      addToast('success', 'SQL snippet deleted.');
    } catch (error) {
      addToast('error', `Failed to delete SQL snippet: ${messageOf(error)}`);
    } finally {
      setDeletingSnippetId(null);
    }
  };

  const tabButtonClass = (tab: VaultTab) =>
    `flex items-center gap-1.5 border-b-[length:var(--border-width)] px-3 py-2 text-xs font-bold transition-colors ${
      activeTab === tab
        ? 'border-[var(--accent-primary)] bg-[var(--bg-card)] text-[var(--accent-primary)]'
        : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'
    }`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setVaultModalOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-secrets-title"
        className="relative z-[51] flex h-[min(820px,92vh)] w-[min(1180px,95vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <KeyRound size={20} className="shrink-0 text-[var(--accent-primary)]" />
            <div className="min-w-0">
              <h2
                id="vault-secrets-title"
                className="text-lg font-bold text-[var(--text-main)]"
              >
                Connection Vault & Global Secrets
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">
                Credentials are masked. Runtime secrets are read with
                {' '}
                <span className="font-mono">dataiki_ctx.vault.get_secret()</span>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setVaultModalOpen(false)}
            className="flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
            aria-label="Close Vault"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2">
          <button
            type="button"
            onClick={() => setActiveTab('connections')}
            className={tabButtonClass('connections')}
            aria-pressed={activeTab === 'connections'}
          >
            <Database size={14} />
            Database & API Connections
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('secrets')}
            className={tabButtonClass('secrets')}
            aria-pressed={activeTab === 'secrets'}
          >
            <KeyRound size={14} />
            Global Secrets
            <span className="hidden font-mono text-[10px] font-normal opacity-70 lg:inline">
              dataiki_ctx.vault.get_secret
            </span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('snippets')}
            className={tabButtonClass('snippets')}
            aria-pressed={activeTab === 'snippets'}
          >
            <Code2 size={14} />
            SQL Snippets
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden bg-[var(--bg-card)]">
          {isLoading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 size={18} className="animate-spin" />
              Loading vault...
            </div>
          )}

          {!isLoading && activeTab === 'connections' && (
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.25fr)_minmax(320px,0.75fr)] gap-4 p-4">
              <section className="flex min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[var(--text-main)]">
                    Saved Connections
                  </h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    {visibleConnections.length}
                  </span>
                </div>
                <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {visibleConnections.length === 0 ? (
                    <div className="flex min-h-[120px] items-center justify-center border-[length:var(--border-width)] border-dashed border-[var(--border-color)] p-4 text-center text-xs text-[var(--text-muted)] rounded-[var(--border-radius)]">
                      No saved connections yet.
                    </div>
                  ) : (
                    visibleConnections.map((connection) => (
                      <div
                        key={connection.conn_id}
                        className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-3 rounded-[var(--border-radius)]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="truncate text-sm font-bold text-[var(--text-main)]">
                                {connection.name}
                              </span>
                              <span className="shrink-0 bg-[var(--accent-primary)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[var(--bg-card)] rounded-[var(--border-radius)]">
                                {connection.conn_type}
                              </span>
                            </div>
                            <p
                              className="mt-1 truncate font-mono text-xs text-[var(--text-muted)]"
                              title={maskedConnectionUri(connection)}
                            >
                              {maskedConnectionUri(connection)}
                            </p>
                            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                              Created: {formatDate(connection.created_at)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void deleteConnection(connection.conn_id)}
                            disabled={deletingConnectionId === connection.conn_id}
                            className="flex shrink-0 items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold text-[var(--accent-danger)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {deletingConnectionId === connection.conn_id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Trash2 size={12} />
                            )}
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="min-h-0 overflow-y-auto border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-3 rounded-[var(--border-radius)]">
                <h3 className="text-sm font-bold text-[var(--text-main)]">
                  Add Connection
                </h3>
                <form onSubmit={(event) => void saveConnection(event)} className="mt-3 space-y-2.5">
                  <label className="block">
                    <span className={LABEL_CLASS}>Connection Name</span>
                    <input
                      value={connectionName}
                      onChange={(event) => setConnectionName(event.target.value)}
                      placeholder="prod_postgres"
                      className={INPUT_CLASS}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL_CLASS}>Connection Type</span>
                    <select
                      value={connectionType}
                      onChange={(event) =>
                        setConnectionType(event.target.value as ConnectionType)
                      }
                      className={INPUT_CLASS}
                    >
                      {CONNECTION_TYPES.map((type) => (
                        <option key={type.value} value={type.value}>
                          {type.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={LABEL_CLASS}>
                      {connectionType === 'rest_api' ? 'REST API URL' : 'Connection URI'}
                    </span>
                    <input
                      value={connectionUri}
                      onChange={(event) => setConnectionUri(event.target.value)}
                      placeholder={
                        connectionType === 'rest_api'
                          ? 'https://api.example.com/v1'
                          : 'postgresql://user:password@host:5432/db'
                      }
                      className={`${INPUT_CLASS} font-mono`}
                    />
                  </label>
                  {connectionType === 'rest_api' && (
                    <label className="block">
                      <span className={LABEL_CLASS}>Headers (JSON)</span>
                      <textarea
                        value={headersJson}
                        onChange={(event) => setHeadersJson(event.target.value)}
                        rows={3}
                        spellCheck={false}
                        className={`${INPUT_CLASS} resize-none font-mono`}
                      />
                    </label>
                  )}
                  {connectionTest && (
                    <p
                      className={`border-[length:var(--border-width)] border-[var(--border-color)] p-2 text-xs rounded-[var(--border-radius)] ${
                        connectionTest.success
                          ? 'text-[var(--accent-secondary)]'
                          : 'text-[var(--accent-danger)]'
                      }`}
                    >
                      {connectionTest.message}
                    </p>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => void testNewConnection()}
                      disabled={isTestingConnection || !connectionUri.trim()}
                      className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isTestingConnection ? 'Testing...' : 'Test Connection'}
                    </button>
                    <button
                      type="submit"
                      disabled={isSavingConnection}
                      className="bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSavingConnection ? 'Saving...' : 'Save Connection'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {!isLoading && activeTab === 'secrets' && (
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)] gap-4 p-4">
              <section className="flex min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[var(--text-main)]">
                    Global Key-Value Secrets
                  </h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    {vaultSecrets.length}
                  </span>
                </div>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Use{' '}
                  <span className="font-mono">
                    dataiki_ctx.vault.get_secret(&quot;KEY_NAME&quot;)
                  </span>{' '}
                  inside Python scripts, Custom APIs, and Jobs.
                </p>
                <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {vaultSecrets.length === 0 ? (
                    <div className="flex min-h-[120px] items-center justify-center border-[length:var(--border-width)] border-dashed border-[var(--border-color)] p-4 text-center text-xs text-[var(--text-muted)] rounded-[var(--border-radius)]">
                      No global secrets saved yet.
                    </div>
                  ) : (
                    vaultSecrets.map((secret) => (
                      <div
                        key={secret.secret_id}
                        className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-3 rounded-[var(--border-radius)]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-sm font-bold text-[var(--text-main)]">
                              {secret.key_name}
                            </p>
                            {secret.description && (
                              <p className="mt-0.5 truncate text-xs text-[var(--text-muted)]">
                                {secret.description}
                              </p>
                            )}
                            <p className="mt-1 font-mono text-xs text-[var(--text-muted)]">
                              ••••••••
                            </p>
                            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                              Created: {formatDate(secret.created_at)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => deleteSecret(secret.secret_id, secret.key_name)}
                            className="flex shrink-0 items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold text-[var(--accent-danger)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
                          >
                            <Trash2 size={12} />
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="min-h-0 overflow-y-auto border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-3 rounded-[var(--border-radius)]">
                <h3 className="text-sm font-bold text-[var(--text-main)]">
                  Add Secret
                </h3>
                <form onSubmit={saveSecret} className="mt-3 space-y-2.5">
                  <label className="block">
                    <span className={LABEL_CLASS}>Key Name</span>
                    <input
                      value={secretKeyName}
                      onChange={(event) => setSecretKeyName(event.target.value)}
                      placeholder="SLACK_TOKEN"
                      className={`${INPUT_CLASS} font-mono`}
                    />
                  </label>
                  <label className="block">
                    <span className={LABEL_CLASS}>Secret Value</span>
                    <div className="flex items-center gap-1">
                      <input
                        type={revealSecretValue ? 'text' : 'password'}
                        value={secretValue}
                        onChange={(event) => setSecretValue(event.target.value)}
                        placeholder="Enter secret value"
                        autoComplete="off"
                        className={`${INPUT_CLASS} font-mono`}
                      />
                      <button
                        type="button"
                        onClick={() => setRevealSecretValue((current) => !current)}
                        className="flex h-9 w-9 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
                        aria-label={revealSecretValue ? 'Hide secret value' : 'Show secret value'}
                      >
                        {revealSecretValue ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  </label>
                  <label className="block">
                    <span className={LABEL_CLASS}>Description</span>
                    <input
                      value={secretDescription}
                      onChange={(event) => setSecretDescription(event.target.value)}
                      placeholder="Optional note"
                      className={INPUT_CLASS}
                    />
                  </label>
                  <div className="flex justify-end pt-1">
                    <button
                      type="submit"
                      className="bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
                    >
                      Save Secret
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}

          {!isLoading && activeTab === 'snippets' && (
            <div className="grid h-full min-h-0 grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)] gap-4 p-4">
              <section className="flex min-h-0 flex-col">
                <div className="flex shrink-0 items-center justify-between gap-2">
                  <h3 className="text-sm font-bold text-[var(--text-main)]">
                    Saved SQL Snippets
                  </h3>
                  <span className="text-xs text-[var(--text-muted)]">
                    {sqlSnippets.length}
                  </span>
                </div>
                <div className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                  {sqlSnippets.length === 0 ? (
                    <div className="flex min-h-[120px] items-center justify-center border-[length:var(--border-width)] border-dashed border-[var(--border-color)] p-4 text-center text-xs text-[var(--text-muted)] rounded-[var(--border-radius)]">
                      No SQL snippets saved yet.
                    </div>
                  ) : (
                    sqlSnippets.map((snippet) => (
                      <div
                        key={snippet.snippet_id}
                        className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-3 rounded-[var(--border-radius)]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-bold text-[var(--text-main)]">
                              {snippet.title}
                            </p>
                            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-[var(--border-radius)] bg-[var(--bg-canvas)] p-2 font-mono text-[11px] text-[var(--text-muted)]">
                              {snippet.sql_text}
                            </pre>
                            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
                              Created: {formatDate(snippet.created_at)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => void deleteSnippet(snippet.snippet_id)}
                            disabled={deletingSnippetId === snippet.snippet_id}
                            className="flex shrink-0 items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-[10px] font-bold text-[var(--accent-danger)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {deletingSnippetId === snippet.snippet_id ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Trash2 size={12} />
                            )}
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section className="flex min-h-0 flex-col border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-3 rounded-[var(--border-radius)]">
                <h3 className="shrink-0 text-sm font-bold text-[var(--text-main)]">
                  Add SQL Snippet
                </h3>
                <form onSubmit={(event) => void saveSnippet(event)} className="mt-3 flex min-h-0 flex-1 flex-col gap-2.5">
                  <label className="block shrink-0">
                    <span className={LABEL_CLASS}>Title</span>
                    <input
                      value={snippetTitle}
                      onChange={(event) => setSnippetTitle(event.target.value)}
                      placeholder="Monthly churn base query"
                      className={INPUT_CLASS}
                    />
                  </label>
                  <div className="flex min-h-[180px] flex-1 flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] rounded-[var(--border-radius)]">
                    <Editor
                      height="100%"
                      language="sql"
                      value={snippetSql}
                      onChange={(value) => setSnippetSql(value ?? '')}
                      theme={activeTheme === 'midnight' ? 'vs-dark' : 'light'}
                      loading={
                        <div className="flex h-full items-center justify-center gap-2 text-xs text-[var(--text-muted)]">
                          <Loader2 size={14} className="animate-spin" />
                          Loading SQL editor...
                        </div>
                      }
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
                  <div className="flex shrink-0 justify-end pt-1">
                    <button
                      type="submit"
                      disabled={isSavingSnippet}
                      className="bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {isSavingSnippet ? 'Saving...' : 'Save Snippet'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2">
          <span className="truncate text-xs text-[var(--text-muted)]">
            Saved connection URIs and secret values are never shown in plain text.
          </span>
          <button
            type="button"
            onClick={() => setVaultModalOpen(false)}
            className="shrink-0 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
