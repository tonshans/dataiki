import { useEffect, useState } from 'react';
import {
  Eraser,
  FlaskConical,
  Loader2,
  LockKeyhole,
  Palette,
  Rocket,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { getHealth } from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { ThemeMode } from '../../types/dataiki';
import { parseProjectKey } from '../../utils/projectDelimiter';

type BackendStatus = 'checking' | 'online' | 'offline';

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'brutalism', label: 'Brutalism' },
  { value: 'minimalist', label: 'Minimalist' },
  { value: 'midnight', label: 'Midnight' },
];

const TOOL_BUTTON_CLASS =
  'flex items-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-main)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]';

export function TopNavBar() {
  const activeTheme = useUIStore((state) => state.activeTheme);
  const setTheme = useUIStore((state) => state.setTheme);
  const workspaceTab = useUIStore((state) => state.workspaceTab);
  const setWorkspaceTab = useUIStore((state) => state.setWorkspaceTab);
  const setProjectModalOpen = useUIStore((state) => state.setProjectModalOpen);
  const setVaultModalOpen = useUIStore((state) => state.setVaultModalOpen);
  const setJanitorModalOpen = useUIStore((state) => state.setJanitorModalOpen);

  const projects = usePipelineStore((state) => state.projects);
  const activeProjectKey = usePipelineStore((state) => state.activeProjectKey);
  const loadProjects = usePipelineStore((state) => state.loadProjects);

  const [backendStatus, setBackendStatus] = useState<BackendStatus>('checking');

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    let cancelled = false;

    const checkBackend = async () => {
      try {
        await getHealth();
        if (!cancelled) setBackendStatus('online');
      } catch {
        if (!cancelled) setBackendStatus('offline');
      }
    };

    void checkBackend();
    const timer = window.setInterval(checkBackend, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const activeProject = projects.find((project) => project.project_key === activeProjectKey);
  const breadcrumb = activeProject
    ? { category: activeProject.category, displayName: activeProject.display_name }
    : activeProjectKey
      ? parseProjectKey(activeProjectKey)
      : { category: 'Uncategorized', displayName: 'No Project' };

  const statusLabel =
    backendStatus === 'online'
      ? 'Backend Online'
      : backendStatus === 'offline'
        ? 'Backend Offline'
        : 'Checking Backend';

  return (
    <header className="flex h-16 shrink-0 items-center gap-3 border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3">
      <button
        type="button"
        onClick={() => setProjectModalOpen(true)}
        className="flex min-w-0 items-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2 text-left shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
        title="Open Project Manager"
      >
        <span className="shrink-0 text-base" aria-hidden="true">
          📁
        </span>
        <span className="truncate text-sm font-semibold text-[var(--text-main)]">
          {breadcrumb.category}
        </span>
        <span className="shrink-0 text-sm text-[var(--text-muted)]">/</span>
        <span className="shrink-0 text-base" aria-hidden="true">
          📄
        </span>
        <span className="truncate text-sm font-semibold text-[var(--accent-primary)]">
          {breadcrumb.displayName}
        </span>
      </button>

      <div className="mx-auto flex shrink-0 items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-1 rounded-[var(--border-radius)]">
        <button
          type="button"
          onClick={() => setWorkspaceTab('development')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition-colors rounded-[var(--border-radius)] ${
            workspaceTab === 'development'
              ? 'bg-[var(--accent-primary)] text-[var(--bg-card)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'
          }`}
          aria-pressed={workspaceTab === 'development'}
        >
          <FlaskConical size={15} />
          Dev Lab
        </button>
        <button
          type="button"
          onClick={() => setWorkspaceTab('production')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition-colors rounded-[var(--border-radius)] ${
            workspaceTab === 'production'
              ? 'bg-[var(--accent-primary)] text-[var(--bg-card)]'
              : 'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-main)]'
          }`}
          aria-pressed={workspaceTab === 'production'}
        >
          <Rocket size={15} />
          Production Gateway
        </button>
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <div
          className="flex items-center gap-1.5 px-1 text-xs font-semibold"
          title={statusLabel}
          aria-live="polite"
        >
          {backendStatus === 'checking' ? (
            <Loader2 size={15} className="animate-spin text-[var(--text-muted)]" />
          ) : backendStatus === 'online' ? (
            <Wifi size={15} className="text-[var(--accent-secondary)]" />
          ) : (
            <WifiOff size={15} className="text-[var(--accent-danger)]" />
          )}
          <span
            className={
              backendStatus === 'online'
                ? 'text-[var(--accent-secondary)]'
                : backendStatus === 'offline'
                  ? 'text-[var(--accent-danger)]'
                  : 'text-[var(--text-muted)]'
            }
          >
            {statusLabel}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setVaultModalOpen(true)}
          className={TOOL_BUTTON_CLASS}
          title="Connection Vault & Global Secrets"
        >
          <LockKeyhole size={15} />
          Vault & Secrets
        </button>

        <button
          type="button"
          onClick={() => setJanitorModalOpen(true)}
          className={TOOL_BUTTON_CLASS}
          title="System Janitor"
        >
          <Eraser size={15} />
          System Janitor
        </button>

        <label
          className="flex items-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1.5 shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
          title="Theme"
        >
          <Palette size={15} className="text-[var(--text-muted)]" />
          <select
            value={activeTheme}
            onChange={(event) => setTheme(event.target.value as ThemeMode)}
            className="cursor-pointer bg-transparent text-xs font-semibold text-[var(--text-main)] outline-none"
            aria-label="Select theme"
          >
            {THEME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </header>
  );
}
