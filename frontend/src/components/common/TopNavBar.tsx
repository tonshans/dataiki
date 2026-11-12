import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Eraser,
  FlaskConical,
  Loader2,
  LockKeyhole,
  MoreHorizontal,
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
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMoreMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(event.target as Node)) {
        setIsMoreMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsMoreMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMoreMenuOpen]);

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
      <div className="flex shrink-0 items-center pr-1 select-none" aria-label="Dataiki">
        <span className="text-xl font-extrabold tracking-tight text-[var(--text-main)]">
          <span className="text-[var(--accent-primary)]">D</span>ataiki
        </span>
      </div>
      {/* <div className="h-6 w-px shrink-0 bg-[var(--border-color)] opacity-40" aria-hidden="true" /> */}

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

      <div className="flex shrink-0 items-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-1 rounded-[var(--border-radius)]">
        <button
          type="button"
          onClick={() => setWorkspaceTab('development')}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition-colors rounded-[var(--border-radius)] ${workspaceTab === 'development'
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
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold transition-colors rounded-[var(--border-radius)] ${workspaceTab === 'production'
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

        <div ref={moreMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setIsMoreMenuOpen((prev) => !prev)}
            className={TOOL_BUTTON_CLASS}
            title="More tools & settings"
            aria-label="More tools and settings"
            aria-haspopup="menu"
            aria-expanded={isMoreMenuOpen}
          >
            <MoreHorizontal size={16} />
          </button>

          {isMoreMenuOpen && (
            <div
              role="menu"
              aria-label="Workspace tools and theme"
              className="absolute right-0 top-full z-50 mt-1.5 w-56 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-1.5 shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsMoreMenuOpen(false);
                  setVaultModalOpen(true);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <LockKeyhole size={15} className="shrink-0 text-[var(--text-muted)]" />
                Vault & Secrets
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setIsMoreMenuOpen(false);
                  setJanitorModalOpen(true);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-2 text-left text-xs font-semibold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <Eraser size={15} className="shrink-0 text-[var(--text-muted)]" />
                System Janitor
              </button>

              <div className="my-1.5 border-t border-[var(--border-color)] opacity-30" />

              <div className="px-2.5 py-1">
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">
                  <Palette size={13} />
                  Theme
                </div>
                <div className="space-y-0.5">
                  {THEME_OPTIONS.map((option) => {
                    const isSelected = activeTheme === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isSelected}
                        onClick={() => {
                          setTheme(option.value);
                          setIsMoreMenuOpen(false);
                        }}
                        className={`flex w-full items-center justify-between px-2 py-1.5 text-left text-xs font-semibold rounded-[var(--border-radius)] transition-colors ${isSelected
                          ? 'bg-[var(--bg-hover)] text-[var(--accent-primary)]'
                          : 'text-[var(--text-main)] hover:bg-[var(--bg-hover)]'
                          }`}
                      >
                        <span>{option.label}</span>
                        {isSelected && <Check size={14} className="shrink-0 text-[var(--accent-primary)]" />}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
