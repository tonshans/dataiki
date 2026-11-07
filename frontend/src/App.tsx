import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  Monitor,
  X,
  XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { JanitorModal } from './components/common/JanitorModal';
import { ProjectManagerModal } from './components/common/ProjectManagerModal';
import { TopNavBar } from './components/common/TopNavBar';
import { VaultSecretsModal } from './components/common/VaultSecretsModal';
import { ColumnAnalysisModal } from './components/devlab/ColumnAnalysisModal';
import { DataExplorerDrawer } from './components/devlab/DataExplorerDrawer';
import { FeatureImportanceModal } from './components/devlab/FeatureImportanceModal';
import { FlowCanvas } from './components/devlab/FlowCanvas';
import { HighCardinalityModal } from './components/devlab/HighCardinalityModal';
import { MLStudioModal } from './components/devlab/MLStudioModal';
import { NodeConfigModals } from './components/devlab/NodeConfigModals';
import { SidebarPalette } from './components/devlab/SidebarPalette';
import { ProductionGatewayView } from './components/production/ProductionGatewayView';
import { useUIStore } from './store/useUIStore';
import type { ToastType } from './store/useUIStore';
import type { ToastItem } from './store/useUIStore';

const DESKTOP_QUERY = '(min-width: 1024px)';
const TOAST_TTL_MS = 5000;

const CARD_CLASS =
  'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]';

const TOAST_ICON: Record<ToastType, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TOAST_COLOR: Record<ToastType, string> = {
  info: 'var(--accent-primary)',
  success: 'var(--accent-secondary)',
  warning: 'var(--accent-warning)',
  error: 'var(--accent-danger)',
};

function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : window.matchMedia(DESKTOP_QUERY).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(DESKTOP_QUERY);
    const handleChange = () => setIsDesktop(query.matches);
    query.addEventListener('change', handleChange);
    return () => query.removeEventListener('change', handleChange);
  }, []);

  return isDesktop;
}

function DesktopViewportGuard() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg-canvas)] p-6">
      <div className={`${CARD_CLASS} w-full max-w-md px-6 py-8 text-center`} role="alert">
        <Monitor size={34} className="mx-auto text-[var(--accent-primary)]" />
        <h1 className="mt-3 text-base font-bold uppercase tracking-wide text-[var(--text-main)]">
          Desktop Viewport Required
        </h1>
        <p className="mt-2 text-[12px] leading-relaxed text-[var(--text-main)]">
          Dataiki is a desktop-only workspace. The interface requires a viewport width of
          at least <span className="font-mono font-bold">1024px</span>.
        </p>
        <p className="mt-3 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-input)] px-2 py-1 font-mono text-[10px] text-[var(--text-muted)] rounded-[var(--border-radius)]">
          Current viewport is below 1024px
        </p>
        <p className="mt-3 text-[10px] leading-relaxed text-[var(--text-muted)]">
          Resize this browser window or switch to a desktop display to continue.
        </p>
      </div>
    </div>
  );
}

function DevelopmentLab() {
  return (
    <div className="flex h-full min-h-0">
      <SidebarPalette />
      <div className="min-w-0 flex-1">
        <FlowCanvas />
      </div>
    </div>
  );
}

function ToastCard({ toast }: { toast: ToastItem }) {
  const removeToast = useUIStore((state) => state.removeToast);
  const Icon = TOAST_ICON[toast.type];
  const color = TOAST_COLOR[toast.type];

  useEffect(() => {
    const timer = window.setTimeout(() => removeToast(toast.id), TOAST_TTL_MS);
    return () => window.clearTimeout(timer);
  }, [removeToast, toast.id]);

  return (
    <div
      role="status"
      className="pointer-events-auto flex items-start gap-2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-2 shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      style={{ borderLeftWidth: 4, borderLeftColor: color }}
    >
      <Icon size={14} className="mt-0.5 shrink-0" style={{ color }} />
      <p className="min-w-0 flex-1 break-words text-[11px] leading-relaxed text-[var(--text-main)]">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={() => removeToast(toast.id)}
        className="mt-0.5 shrink-0 text-[var(--text-muted)] transition-colors hover:text-[var(--text-main)]"
        aria-label="Dismiss notification"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ToastStack() {
  const toasts = useUIStore((state) => state.toasts);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed right-4 top-20 z-[70] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
      aria-label="Notifications"
    >
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

export function App() {
  const isDesktop = useIsDesktopViewport();
  const workspaceTab = useUIStore((state) => state.workspaceTab);

  if (!isDesktop) return <DesktopViewportGuard />;

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[var(--bg-canvas)] text-[var(--text-main)]">
      <TopNavBar />

      <main className="min-h-0 flex-1 overflow-hidden">
        {workspaceTab === 'development' ? <DevelopmentLab /> : <ProductionGatewayView />}
      </main>

      {workspaceTab === 'development' && (
        <>
          <DataExplorerDrawer />
          <NodeConfigModals />
          <MLStudioModal />
          <ColumnAnalysisModal />
          <FeatureImportanceModal />
          <HighCardinalityModal />
        </>
      )}

      <ProjectManagerModal />
      <VaultSecretsModal />
      <JanitorModal />
      <ToastStack />
    </div>
  );
}
