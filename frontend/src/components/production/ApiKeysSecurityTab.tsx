import { useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { ApiKeyItem } from '../../types/dataiki';

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';
const INPUT_CLASS =
  'w-full border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2.5 py-1.5 text-sm text-[var(--text-main)] outline-none rounded-[var(--border-radius)] focus:border-[var(--accent-primary)]';
const LABEL_CLASS =
  'mb-1 block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-1.5 bg-[var(--accent-primary)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] rounded-[var(--border-radius)] transition-opacity disabled:cursor-not-allowed disabled:opacity-50';
const TABLE_HEAD_CLASS =
  'border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-2 text-left text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]';

function randomHex(bytes: number): string {
  if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    throw new Error('Secure random generator is unavailable in this browser.');
  }
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (value) => value.toString(16).padStart(2, '0')).join('');
}

function generateToken(): string {
  return `dki_live_${randomHex(24)}`;
}

function generateKeyId(): string {
  return `key_${randomHex(8)}`;
}

function formatDateTime(value: string): string {
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

function maskToken(token: string): string {
  const prefix = token.startsWith('dki_live_') ? 'dki_live_' : '';
  return `${prefix}${'•'.repeat(20)}`;
}

async function writeClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard API is unavailable. Select and copy the key manually.');
  }
  await navigator.clipboard.writeText(text);
}

export function ApiKeysSecurityTab() {
  const apiKeys = usePipelineStore((state) => state.apiKeys);
  const addToast = useUIStore((state) => state.addToast);

  const [keyLabel, setKeyLabel] = useState('');
  const [newKey, setNewKey] = useState<ApiKeyItem | null>(null);
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeCount = useMemo(
    () => apiKeys.filter((key) => key.is_active).length,
    [apiKeys],
  );

  const setApiKeys = (next: ApiKeyItem[]) => {
    usePipelineStore.setState({ apiKeys: next });
  };

  const handleCreate = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const label = keyLabel.trim();
    if (!label) {
      addToast('warning', 'Give the master key a label before generating it.');
      return;
    }
    if (apiKeys.some((key) => key.label.toLowerCase() === label.toLowerCase())) {
      addToast('warning', `A master key labelled '${label}' already exists.`);
      return;
    }

    let token: string;
    let keyId: string;
    try {
      token = generateToken();
      keyId = generateKeyId();
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : String(error));
      return;
    }

    const item: ApiKeyItem = {
      key_id: keyId,
      label,
      token,
      created_at: new Date().toISOString(),
      is_active: true,
    };
    setApiKeys([item, ...apiKeys]);
    setNewKey(item);
    setKeyLabel('');
    addToast('success', `Master API key '${label}' generated. Copy it into your secrets manager.`);
  };

  const handleToggle = (key: ApiKeyItem) => {
    const next = apiKeys.map((item) =>
      item.key_id === key.key_id ? { ...item, is_active: !item.is_active } : item,
    );
    setApiKeys(next);
    addToast(
      'info',
      key.is_active
        ? `Key '${key.label}' disabled. Requests using it are now rejected.`
        : `Key '${key.label}' enabled.`,
    );
  };

  const handleDelete = (key: ApiKeyItem) => {
    setApiKeys(apiKeys.filter((item) => item.key_id !== key.key_id));
    setConfirmDeleteId(null);
    setNewKey((current) => (current?.key_id === key.key_id ? null : current));
    addToast('success', `Master API key '${key.label}' deleted.`);
  };

  const copyText = async (text: string, message: string) => {
    try {
      await writeClipboard(text);
      addToast('success', message);
    } catch (error) {
      addToast('error', error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="space-y-3">
      <header className={`${CARD_CLASS} flex flex-wrap items-center justify-between gap-2 px-3 py-2.5`}>
        <div className="flex min-w-0 items-start gap-2">
          <ShieldCheck size={18} className="mt-0.5 shrink-0 text-[var(--accent-primary)]" />
          <div className="min-w-0">
            <h2 className="text-sm font-bold uppercase tracking-wide text-[var(--text-main)]">
              API Keys &amp; Security
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Static Master API Keys guard Custom REST API endpoints that enable{' '}
              <span className="font-bold text-[var(--text-main)]">Require API Key</span>.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            <KeyRound size={11} className="text-[var(--accent-secondary)]" />
            {activeCount} active
          </span>
          <span className="inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[10px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)]">
            {apiKeys.length} total
          </span>
        </div>
      </header>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
        <div className="space-y-3">
          <section className={CARD_CLASS}>
            <header className="flex items-center gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
              <Plus size={14} className="text-[var(--accent-primary)]" />
              <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
                Generate Master Key
              </h3>
            </header>
            <form onSubmit={handleCreate} className="p-3">
              <label className={LABEL_CLASS} htmlFor="api-key-label">
                Key Label
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="api-key-label"
                  value={keyLabel}
                  onChange={(event) => setKeyLabel(event.target.value)}
                  className={INPUT_CLASS}
                  placeholder="e.g. production-dashboard"
                  maxLength={80}
                  autoComplete="off"
                />
                <button type="submit" className={`${PRIMARY_BUTTON} shrink-0`}>
                  <KeyRound size={13} />
                  Generate Key
                </button>
              </div>
              <p className="mt-2 text-[10px] text-[var(--text-muted)]">
                Tokens use the <span className="font-mono">dki_live_</span> prefix and are stored
                in this browser profile. Copy each key into your secret manager.
              </p>
            </form>
          </section>

          {newKey && (
            <section className="border-[length:var(--border-width)] border-[var(--accent-secondary)] bg-[var(--bg-card)] p-3 rounded-[var(--border-radius)]">
              <div className="flex items-start gap-2">
                <Check size={14} className="mt-0.5 shrink-0 text-[var(--accent-secondary)]" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-bold text-[var(--text-main)]">
                    New master key: {newKey.label}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <code className="min-w-0 flex-1 break-all border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1 font-mono text-[11px] text-[var(--text-main)] rounded-[var(--border-radius)]">
                      {newKey.token}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText(newKey.token, 'Master key copied to clipboard.')}
                      className={SECONDARY_BUTTON}
                    >
                      <Copy size={11} />
                      Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => setNewKey(null)}
                      className={SECONDARY_BUTTON}
                      aria-label="Dismiss new key"
                    >
                      <X size={11} />
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          <section className={`${CARD_CLASS} overflow-hidden`}>
            <header className="flex items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
              <div className="flex items-center gap-2">
                <KeyRound size={14} className="text-[var(--accent-primary)]" />
                <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
                  Static Master API Keys
                </h3>
              </div>
              <span className="font-mono text-[10px] font-bold text-[var(--text-muted)]">
                x-api-key
              </span>
            </header>

            {apiKeys.length === 0 ? (
              <div className="px-4 py-10 text-center">
                <KeyRound size={24} className="mx-auto text-[var(--text-muted)]" />
                <p className="mt-2 text-xs font-bold text-[var(--text-main)]">No master keys yet</p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  Generate a key above, then paste it into the API Builder tester or your client
                  request header.
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse text-[11px]">
                  <thead>
                    <tr className="bg-[var(--bg-card)]">
                      <th className={TABLE_HEAD_CLASS}>Label</th>
                      <th className={TABLE_HEAD_CLASS}>Token</th>
                      <th className={TABLE_HEAD_CLASS}>Created</th>
                      <th className={TABLE_HEAD_CLASS}>Status</th>
                      <th className={`${TABLE_HEAD_CLASS} text-right`}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {apiKeys.map((key) => {
                      const visible = revealed[key.key_id] === true;
                      return (
                        <tr
                          key={key.key_id}
                          className={`border-b border-[var(--border-color)] last:border-b-0 ${
                            key.is_active
                              ? 'bg-[var(--bg-card)]'
                              : 'bg-[var(--bg-canvas)] opacity-70'
                          }`}
                        >
                          <td className="px-3 py-2">
                            <p className="truncate font-bold text-[var(--text-main)]">{key.label}</p>
                            <p className="truncate font-mono text-[9px] text-[var(--text-muted)]">
                              {key.key_id}
                            </p>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1">
                              <code className="min-w-0 flex-1 break-all font-mono text-[10px] text-[var(--text-main)]">
                                {visible ? key.token : maskToken(key.token)}
                              </code>
                              <button
                                type="button"
                                onClick={() =>
                                  setRevealed((current) => ({
                                    ...current,
                                    [key.key_id]: !visible,
                                  }))
                                }
                                className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                                aria-label={visible ? 'Hide token' : 'Reveal token'}
                                title={visible ? 'Hide token' : 'Reveal token'}
                              >
                                {visible ? <EyeOff size={11} /> : <Eye size={11} />}
                              </button>
                              <button
                                type="button"
                                onClick={() => void copyText(key.token, `Key '${key.label}' copied.`)}
                                className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                                aria-label="Copy token"
                                title="Copy token"
                              >
                                <Copy size={11} />
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-main)]">
                            {formatDateTime(key.created_at)}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              className={`inline-flex items-center border-[length:var(--border-width)] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest rounded-[var(--border-radius)] ${
                                key.is_active
                                  ? 'border-[var(--accent-secondary)] text-[var(--accent-secondary)]'
                                  : 'border-[var(--border-color)] text-[var(--text-muted)]'
                              }`}
                            >
                              {key.is_active ? 'Active' : 'Disabled'}
                            </span>
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center justify-end gap-1">
                              <button
                                type="button"
                                onClick={() => handleToggle(key)}
                                className={SECONDARY_BUTTON}
                                title={key.is_active ? 'Disable key' : 'Enable key'}
                              >
                                {key.is_active ? <Lock size={11} /> : <KeyRound size={11} />}
                                {key.is_active ? 'Disable' : 'Enable'}
                              </button>
                              {confirmDeleteId === key.key_id ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => handleDelete(key)}
                                    className="inline-flex items-center gap-1 border-[length:var(--border-width)] border-[var(--accent-danger)] bg-[var(--accent-danger)] px-2 py-1 text-[10px] font-bold text-[var(--bg-card)] rounded-[var(--border-radius)]"
                                  >
                                    <Trash2 size={11} />
                                    Confirm
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className={`${SECONDARY_BUTTON} px-1.5 py-1`}
                                    aria-label="Cancel delete"
                                  >
                                    <X size={11} />
                                  </button>
                                </>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(key.key_id)}
                                  className={SECONDARY_BUTTON}
                                  title="Delete key"
                                >
                                  <Trash2 size={11} />
                                  Delete
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="space-y-3">
          <section className={CARD_CLASS}>
            <header className="flex items-center gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
              <Lock size={14} className="text-[var(--accent-primary)]" />
              <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
                Authentication Headers
              </h3>
            </header>
            <div className="space-y-2 p-3">
              <p className="text-[11px] text-[var(--text-muted)]">
                Send one of these headers from any client calling a protected endpoint:
              </p>
              <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] p-2 rounded-[var(--border-radius)]">
                <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  Option A
                </p>
                <code className="mt-1 block break-all font-mono text-[11px] text-[var(--text-main)]">
                  x-api-key: dki_live_...
                </code>
              </div>
              <div className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] p-2 rounded-[var(--border-radius)]">
                <p className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                  Option B
                </p>
                <code className="mt-1 block break-all font-mono text-[11px] text-[var(--text-main)]">
                  Authorization: Bearer dki_live_...
                </code>
              </div>
              <p className="text-[10px] text-[var(--text-muted)]">
                Requests with a missing, disabled, or unknown key are rejected with{' '}
                <span className="font-mono">401 Unauthorized</span>.
              </p>
            </div>
          </section>

          <section className={CARD_CLASS}>
            <header className="flex items-center gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
              <ShieldCheck size={14} className="text-[var(--accent-primary)]" />
              <h3 className="text-xs font-bold uppercase tracking-wide text-[var(--text-main)]">
                Key Hygiene
              </h3>
            </header>
            <ul className="space-y-2 p-3 text-[11px] text-[var(--text-muted)]">
              <li className="flex gap-2">
                <span className="font-mono text-[var(--accent-primary)]">01</span>
                One key per client or integration. Revoke it without disturbing the others.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[var(--accent-primary)]">02</span>
                Disable a key immediately if it leaks; deletion is permanent.
              </li>
              <li className="flex gap-2">
                <span className="font-mono text-[var(--accent-primary)]">03</span>
                Enable <span className="font-bold text-[var(--text-main)]">Require API Key</span> on
                each Custom REST API endpoint that must stay private.
              </li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
