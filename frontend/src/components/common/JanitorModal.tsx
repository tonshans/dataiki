import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Boxes,
  Eraser,
  FolderX,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import * as api from '../../api/client';
import { useUIStore } from '../../store/useUIStore';
import type { JanitorScanResult } from '../../types/dataiki';

interface JanitorFileDetail {
  relative_path?: string;
  path?: string;
  size_mb?: number;
}

interface FileGroupCardProps {
  title: string;
  description: string;
  icon: ReactNode;
  iconClass: string;
  sizeMb: number;
  files: string[];
  checked?: boolean;
  onToggle?: (checked: boolean) => void;
  disabled?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileLabel(file: string): string {
  const detail = file as unknown as JanitorFileDetail;
  return detail?.relative_path ?? detail?.path ?? String(file);
}

function fileSize(file: string): string {
  const detail = file as unknown as JanitorFileDetail;
  return typeof detail?.size_mb === 'number' ? `${detail.size_mb.toFixed(2)} MB` : '';
}

function normalizeScan(raw: unknown): JanitorScanResult {
  const source = (raw ?? {}) as {
    orphaned_caches?: JanitorScanResult['orphaned_caches'];
    unpublished_experiments?: JanitorScanResult['unpublished_experiments'];
    unpublished_models?: JanitorScanResult['unpublished_experiments'];
    protected_production_assets?: JanitorScanResult['protected_production_assets'];
  };
  const summary = (value?: JanitorScanResult['orphaned_caches']) => ({
    size_mb: Number(value?.size_mb ?? 0),
    files: Array.isArray(value?.files) ? value.files : [],
  });
  return {
    orphaned_caches: summary(source.orphaned_caches),
    unpublished_experiments: summary(
      source.unpublished_experiments ?? source.unpublished_models,
    ),
    protected_production_assets: summary(source.protected_production_assets),
  };
}

function FileGroupCard({
  title,
  description,
  icon,
  iconClass,
  sizeMb,
  files,
  checked,
  onToggle,
  disabled = false,
}: FileGroupCardProps) {
  const selectable = typeof onToggle === 'function';

  return (
    <div
      className={`border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-3 rounded-[var(--border-radius)] ${
        selectable && checked === false ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <span className={`mt-0.5 shrink-0 ${iconClass}`}>{icon}</span>
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-[var(--text-main)]">{title}</h3>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">{description}</p>
          </div>
        </div>
        <div className="shrink-0 text-right">
          {selectable ? (
            <label className="flex cursor-pointer items-center justify-end gap-1.5 text-[10px] font-bold uppercase tracking-wider text-[var(--text-main)]">
              <input
                type="checkbox"
                checked={Boolean(checked)}
                onChange={(event) => onToggle?.(event.target.checked)}
                disabled={disabled}
                className="h-4 w-4 accent-[var(--accent-primary)]"
              />
              Delete
            </label>
          ) : (
            <span className="flex items-center justify-end gap-1 text-[10px] font-bold uppercase tracking-wider text-[var(--accent-secondary)]">
              <Lock size={12} />
              Locked & Safe
            </span>
          )}
          <p className="mt-1 font-mono text-xs font-bold text-[var(--text-main)]">
            {sizeMb.toFixed(2)} MB
          </p>
          <p className="text-[10px] text-[var(--text-muted)]">
            {files.length} file{files.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      <div className="mt-2 max-h-32 space-y-1 overflow-y-auto border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 rounded-[var(--border-radius)]">
        {files.length === 0 ? (
          <p className="text-[11px] text-[var(--text-muted)]">No files in this category.</p>
        ) : (
          files.map((file, index) => (
            <div
              key={`${fileLabel(file)}-${index}`}
              className="flex items-center justify-between gap-3 text-[11px]"
            >
              <span className="min-w-0 truncate font-mono text-[var(--text-muted)]" title={fileLabel(file)}>
                {fileLabel(file)}
              </span>
              <span className="shrink-0 font-mono text-[var(--text-main)]">
                {fileSize(file)}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function JanitorModal() {
  const isOpen = useUIStore((state) => state.isJanitorModalOpen);
  const setJanitorModalOpen = useUIStore((state) => state.setJanitorModalOpen);
  const addToast = useUIStore((state) => state.addToast);

  const [scan, setScan] = useState<JanitorScanResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPurging, setIsPurging] = useState(false);
  const [isConfirmingPurge, setIsConfirmingPurge] = useState(false);
  const [purgeCaches, setPurgeCaches] = useState(true);
  const [purgeModels, setPurgeModels] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadScan = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setIsConfirmingPurge(false);
    try {
      const result = await api.scanJanitor();
      const normalized = normalizeScan(result);
      setScan(normalized);
      setPurgeCaches(normalized.orphaned_caches.files.length > 0);
      setPurgeModels(normalized.unpublished_experiments.files.length > 0);
    } catch (loadError) {
      setError(messageOf(loadError));
      addToast('error', `Janitor scan failed: ${messageOf(loadError)}`);
    } finally {
      setIsLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    if (!isOpen) return;
    void loadScan();
  }, [isOpen, loadScan]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setJanitorModalOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, setJanitorModalOpen]);

  if (!isOpen) return null;

  const hasSelection = purgeCaches || purgeModels;
  const selectedSizeMb =
    (purgeCaches && scan ? scan.orphaned_caches.size_mb : 0) +
    (purgeModels && scan ? scan.unpublished_experiments.size_mb : 0);

  const purgeSelected = async () => {
    const categories: Array<'orphaned_caches' | 'unpublished_experiments'> = [];
    if (purgeCaches) categories.push('orphaned_caches');
    if (purgeModels) categories.push('unpublished_experiments');
    if (categories.length === 0) {
      addToast('warning', 'Select at least one category to purge.');
      return;
    }

    setIsPurging(true);
    try {
      const result = await api.purgeJanitor(categories);
      const nextScan = normalizeScan(result.post_purge_scan);
      setScan(nextScan);
      setPurgeCaches(nextScan.orphaned_caches.files.length > 0);
      setPurgeModels(nextScan.unpublished_experiments.files.length > 0);
      setIsConfirmingPurge(false);
      if (result.purged_files_count > 0) {
        addToast(
          'success',
          `Purged ${result.purged_files_count} file(s), freed ${result.purged_mb} MB.`,
        );
      } else {
        addToast('warning', 'No files were purged.');
      }
    } catch (purgeError) {
      addToast('error', `Purge failed: ${messageOf(purgeError)}`);
    } finally {
      setIsPurging(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setJanitorModalOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="janitor-title"
        className="relative z-[51] flex h-[min(760px,90vh)] w-[min(980px,94vw)] flex-col overflow-hidden border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b-[length:var(--border-width)] border-[var(--border-color)] px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Eraser size={20} className="shrink-0 text-[var(--accent-primary)]" />
            <div className="min-w-0">
              <h2 id="janitor-title" className="text-lg font-bold text-[var(--text-main)]">
                System Janitor
              </h2>
              <p className="truncate text-xs text-[var(--text-muted)]">
                Remove orphaned cache files and unpublished experiment models.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void loadScan()}
              disabled={isLoading || isPurging}
              className="flex h-8 items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={13} className={isLoading ? 'animate-spin' : ''} />
              Rescan
            </button>
            <button
              type="button"
              onClick={() => setJanitorModalOpen(false)}
              className="flex h-8 w-8 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
              aria-label="Close System Janitor"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading && (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
              <Loader2 size={18} className="animate-spin" />
              Scanning storage...
            </div>
          )}

          {!isLoading && error && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <AlertTriangle size={28} className="text-[var(--accent-danger)]" />
              <p className="text-sm font-semibold text-[var(--text-main)]">
                Failed to scan storage.
              </p>
              <p className="max-w-md text-xs text-[var(--text-muted)]">{error}</p>
              <button
                type="button"
                onClick={() => void loadScan()}
                className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                Try Again
              </button>
            </div>
          )}

          {!isLoading && !error && scan && (
            <div className="space-y-3">
              <FileGroupCard
                title="Orphaned Parquet Caches"
                description="Intermediate or experimental cache files not linked to any published model."
                icon={<FolderX size={18} />}
                iconClass="text-[var(--accent-warning)]"
                sizeMb={scan.orphaned_caches.size_mb}
                files={scan.orphaned_caches.files}
                checked={purgeCaches}
                onToggle={setPurgeCaches}
                disabled={isPurging}
              />
              <FileGroupCard
                title="Unpublished Experiment Models"
                description="Archived, orphaned, or discarded model artifacts that were never promoted."
                icon={<Boxes size={18} />}
                iconClass="text-[var(--accent-primary)]"
                sizeMb={scan.unpublished_experiments.size_mb}
                files={scan.unpublished_experiments.files}
                checked={purgeModels}
                onToggle={setPurgeModels}
                disabled={isPurging}
              />
              <FileGroupCard
                title="Protected Production Assets"
                description="Active or staged production model artifacts and their lineage caches."
                icon={<ShieldCheck size={18} />}
                iconClass="text-[var(--accent-secondary)]"
                sizeMb={scan.protected_production_assets.size_mb}
                files={scan.protected_production_assets.files}
              />
            </div>
          )}
        </div>

        <div className="shrink-0 border-t-[length:var(--border-width)] border-[var(--border-color)] px-4 py-2.5">
          {isConfirmingPurge && (
            <div className="mb-2 flex items-center gap-2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--accent-warning)] px-2.5 py-1.5 text-xs font-semibold text-[var(--text-main)] rounded-[var(--border-radius)]">
              <AlertTriangle size={14} className="shrink-0" />
              <span className="min-w-0">
                This permanently deletes the selected files. Confirm to continue.
              </span>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 text-xs text-[var(--text-muted)]">
              <span className="font-semibold text-[var(--text-main)]">
                Selected: {selectedSizeMb.toFixed(2)} MB
              </span>
              <span className="ml-2">
                Protected assets are never touched.
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setJanitorModalOpen(false)}
                className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
              {isConfirmingPurge ? (
                <>
                  <button
                    type="button"
                    onClick={() => setIsConfirmingPurge(false)}
                    className="border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => void purgeSelected()}
                    disabled={isPurging || !hasSelection}
                    className="flex items-center gap-1.5 bg-[var(--accent-danger)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPurging ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Trash2 size={13} />
                    )}
                    {isPurging ? 'Purging...' : 'Confirm Purge'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsConfirmingPurge(true)}
                  disabled={!hasSelection || isPurging}
                  className="flex items-center gap-1.5 bg-[var(--accent-danger)] px-3 py-1.5 text-xs font-bold text-[var(--bg-card)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Trash2 size={13} />
                  Purge Selected Files
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
