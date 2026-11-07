import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ProductionNavSection, ThemeMode, WorkspaceTab } from '../types/dataiki';

export type ToastType = 'info' | 'success' | 'warning' | 'error';
export type BottomTab = 'preview' | 'logs';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
}

export interface FeatureImportanceTarget {
  title: string;
  importance: Record<string, number>;
  metrics: Record<string, number>;
  confusionMatrix?: number[][];
}

export interface HighCardinalityWarning {
  jobId: string;
  offendingColumns: Array<{ column: string; unique_count: number }>;
}

interface UIState {
  activeTheme: ThemeMode;
  workspaceTab: WorkspaceTab;
  prodNavSection: ProductionNavSection;
  isLeftPaletteOpen: boolean;
  bottomDrawerHeight: number;
  activeBottomTab: BottomTab;
  activeConfigNodeId: string | null;
  activeAnalysisColumn: string | null;
  featureImportanceTarget: FeatureImportanceTarget | null;
  isProjectModalOpen: boolean;
  isVaultModalOpen: boolean;
  isJanitorModalOpen: boolean;
  highCardinalityWarning: HighCardinalityWarning | null;
  toasts: ToastItem[];

  setTheme: (theme: ThemeMode) => void;
  setWorkspaceTab: (tab: WorkspaceTab) => void;
  setProdNavSection: (section: ProductionNavSection) => void;
  toggleLeftPalette: () => void;
  setLeftPaletteOpen: (open: boolean) => void;
  setBottomDrawerHeight: (height: number) => void;
  setActiveBottomTab: (tab: BottomTab) => void;
  setActiveConfigNodeId: (nodeId: string | null) => void;
  setActiveAnalysisColumn: (column: string | null) => void;
  setFeatureImportanceTarget: (target: FeatureImportanceTarget | null) => void;
  setProjectModalOpen: (open: boolean) => void;
  setVaultModalOpen: (open: boolean) => void;
  setJanitorModalOpen: (open: boolean) => void;
  setHighCardinalityWarning: (warning: HighCardinalityWarning | null) => void;
  addToast: (type: ToastType, message: string) => string;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

function applyTheme(theme: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', theme);
}

let toastSeq = 0;

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      activeTheme: 'brutalism',
      workspaceTab: 'development',
      prodNavSection: 'models',
      isLeftPaletteOpen: true,
      bottomDrawerHeight: 280,
      activeBottomTab: 'preview',
      activeConfigNodeId: null,
      activeAnalysisColumn: null,
      featureImportanceTarget: null,
      isProjectModalOpen: false,
      isVaultModalOpen: false,
      isJanitorModalOpen: false,
      highCardinalityWarning: null,
      toasts: [],

      setTheme: (theme) => {
        applyTheme(theme);
        set({ activeTheme: theme });
      },
      setWorkspaceTab: (workspaceTab) => set({ workspaceTab }),
      setProdNavSection: (prodNavSection) => set({ prodNavSection }),
      toggleLeftPalette: () => set((state) => ({ isLeftPaletteOpen: !state.isLeftPaletteOpen })),
      setLeftPaletteOpen: (isLeftPaletteOpen) => set({ isLeftPaletteOpen }),
      setBottomDrawerHeight: (height) => set({ bottomDrawerHeight: Math.max(120, height) }),
      setActiveBottomTab: (activeBottomTab) => set({ activeBottomTab }),
      setActiveConfigNodeId: (activeConfigNodeId) => set({ activeConfigNodeId }),
      setActiveAnalysisColumn: (activeAnalysisColumn) => set({ activeAnalysisColumn }),
      setFeatureImportanceTarget: (featureImportanceTarget) => set({ featureImportanceTarget }),
      setProjectModalOpen: (isProjectModalOpen) => set({ isProjectModalOpen }),
      setVaultModalOpen: (isVaultModalOpen) => set({ isVaultModalOpen }),
      setJanitorModalOpen: (isJanitorModalOpen) => set({ isJanitorModalOpen }),
      setHighCardinalityWarning: (highCardinalityWarning) => set({ highCardinalityWarning }),
      addToast: (type, message) => {
        toastSeq += 1;
        const id = `toast_${Date.now()}_${toastSeq}`;
        set((state) => ({ toasts: [...state.toasts, { id, type, message }] }));
        return id;
      },
      removeToast: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
      clearToasts: () => set({ toasts: [] }),
    }),
    {
      name: 'dataiki-ui-store',
      // Hanya preferensi tampilan yang bertahan; modal/toast/node aktif selalu mulai bersih.
      partialize: (state) => ({
        activeTheme: state.activeTheme,
        workspaceTab: state.workspaceTab,
        prodNavSection: state.prodNavSection,
        isLeftPaletteOpen: state.isLeftPaletteOpen,
        bottomDrawerHeight: state.bottomDrawerHeight,
        activeBottomTab: state.activeBottomTab,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyTheme(state.activeTheme);
      },
    },
  ),
);

applyTheme(useUIStore.getState().activeTheme);
