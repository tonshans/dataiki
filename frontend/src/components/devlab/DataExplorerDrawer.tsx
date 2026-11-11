import { useEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  AlertCircle,
  BarChart3,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  Filter,
  FilterX,
  GripHorizontal,
  Info,
  Loader2,
  RefreshCw,
  Search,
  Table2,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { TabularPreviewData } from '../../types/dataiki';
import { exportPreviewToCSV, exportPreviewToExcel } from '../../utils/datasetExporter';

const MIN_DRAWER_HEIGHT = 150;
const DEFAULT_DRAWER_HEIGHT = 280;

const TAB_BUTTON =
  'flex items-center gap-1.5 border-[length:var(--border-width)] px-2.5 py-1 text-[11px] font-bold rounded-[var(--border-radius)] transition-colors';
const TOOL_BUTTON =
  'flex items-center gap-1.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2.5 py-1 text-[11px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] disabled:cursor-not-allowed disabled:opacity-50';

const ROW_LIMIT_OPTIONS = [
  { value: 100, label: '100 rows' },
  { value: 500, label: '500 rows' },
  { value: 1000, label: '1,000 rows' },
  { value: 5000, label: '5,000 rows' },
  { value: 0, label: 'All rows' },
];

function clampHeight(height: number): number {
  const max = Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - 140);
  return Math.min(Math.max(height, MIN_DRAWER_HEIGHT), max);
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function formatLogTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString([], { hour12: false });
}

function safeFilename(label: string, preview: TabularPreviewData): string {
  const base = label.trim() || preview.node_id;
  const suffix = preview.is_raw_view ? 'raw' : 'processed';
  return `${base.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/-+/g, '-')}-${suffix}`;
}

function FillRateBar({ fillRate, nullRate }: { fillRate: number; nullRate: number }) {
  const filled = Math.max(0, Math.min(100, fillRate));
  const empty = Math.max(0, Math.min(100, nullRate));
  return (
    <div className="mt-1">
      <div
        className="flex h-1.5 w-full overflow-hidden bg-[var(--bg-card)]"
        role="img"
        aria-label={`${filled.toFixed(1)}% filled, ${empty.toFixed(1)}% null`}
        title={`${filled.toFixed(1)}% Filled · ${empty.toFixed(1)}% Null`}
      >
        <span
          className="h-full bg-[var(--accent-secondary)]"
          style={{ width: `${filled}%` }}
        />
        <span
          className={`h-full ${empty >= 20 ? 'bg-[var(--accent-danger)]' : 'bg-[var(--accent-warning)]'}`}
          style={{ width: `${empty}%` }}
        />
      </div>
      <div className="mt-0.5 flex justify-between gap-1 text-[9px] font-bold leading-none">
        <span className="text-[var(--accent-secondary)]">{filled.toFixed(0)}% filled</span>
        <span className="text-[var(--text-muted)]">{empty.toFixed(0)}% null</span>
      </div>
    </div>
  );
}

export function DataExplorerDrawer() {
  const bottomDrawerHeight = useUIStore((state) => state.bottomDrawerHeight);
  const setBottomDrawerHeight = useUIStore((state) => state.setBottomDrawerHeight);
  const activeBottomTab = useUIStore((state) => state.activeBottomTab);
  const setActiveBottomTab = useUIStore((state) => state.setActiveBottomTab);
  const setActiveAnalysisColumn = useUIStore((state) => state.setActiveAnalysisColumn);
  const addToast = useUIStore((state) => state.addToast);

  const tabularPreview = usePipelineStore((state) => state.tabularPreview);
  const nodes = usePipelineStore((state) => state.nodes);
  const processLogs = usePipelineStore((state) => state.processLogs);
  const clearProcessLogs = usePipelineStore((state) => state.clearProcessLogs);
  const setIsRawPreview = usePipelineStore((state) => state.setIsRawPreview);
  const fetchNodePreview = usePipelineStore((state) => state.fetchNodePreview);
  const clearColumnAnalysisCache = usePipelineStore((state) => state.clearColumnAnalysisCache);

  const [isResizing, setIsResizing] = useState(false);
  const [isTogglingRaw, setIsTogglingRaw] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [rowLimit, setRowLimit] = useState<number>(100);
  const [pendingLimit, setPendingLimit] = useState<number | null>(null);
  const [showLimitWarning, setShowLimitWarning] = useState(false);
  const [isChangingLimit, setIsChangingLimit] = useState(false);

  // Visual column filtering states
  const [columnFilters, setColumnFilters] = useState<Record<string, Set<string>>>({});
  const [activeFilterCol, setActiveFilterCol] = useState<string | null>(null);
  const [filterSearch, setFilterSearch] = useState('');
  const [filterDraft, setFilterDraft] = useState<Set<string>>(new Set());

  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // Reset limit & visual filters when switching to a different node
  const previousNodeIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (tabularPreview && tabularPreview.node_id !== previousNodeIdRef.current) {
      previousNodeIdRef.current = tabularPreview.node_id;
      setRowLimit(100);
      setColumnFilters({});
      setActiveFilterCol(null);
    }
  }, [tabularPreview]);

  // Handle escape / outside click for column filter popover
  useEffect(() => {
    if (!activeFilterCol) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setActiveFilterCol(null);
    };
    const handleClickOutside = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.column-filter-popover')) {
        setActiveFilterCol(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('mousedown', handleClickOutside);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('mousedown', handleClickOutside);
    };
  }, [activeFilterCol]);

  const selectedNodeLabel = useMemo(() => {
    if (!tabularPreview) return '';
    return (
      nodes.find((node) => node.id === tabularPreview.node_id)?.data.label ??
      tabularPreview.node_id
    );
  }, [nodes, tabularPreview]);

  const columns = useMemo(() => {
    if (!tabularPreview) return [] as string[];
    if (tabularPreview.headers.length > 0) {
      return tabularPreview.headers.map((header) => header.column_name);
    }
    return Object.keys(tabularPreview.rows[0] ?? {});
  }, [tabularPreview]);

  const headerByName = useMemo(
    () =>
      new Map(
        (tabularPreview?.headers ?? []).map((header) => [header.column_name, header]),
      ),
    [tabularPreview],
  );

  const modifiedColumns = useMemo(
    () => new Set(tabularPreview?.last_modified_columns ?? []),
    [tabularPreview],
  );

  const chronologicalLogs = useMemo(() => [...processLogs].reverse(), [processLogs]);

  const isRawView = tabularPreview?.is_raw_view ?? false;

  const handleResizeStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dragRef.current = {
      startY: event.clientY,
      startHeight: bottomDrawerHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  };

  const handleResizeMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setBottomDrawerHeight(clampHeight(drag.startHeight + drag.startY - event.clientY));
  };

  const handleResizeEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setIsResizing(false);
  };

  const handleToggleRaw = async () => {
    if (!tabularPreview) return;
    const nextRaw = !tabularPreview.is_raw_view;
    setIsRawPreview(nextRaw);
    setIsTogglingRaw(true);
    try {
      await fetchNodePreview(tabularPreview.node_id, rowLimit);
      addToast('info', nextRaw ? 'Showing raw data.' : 'Showing processed data.');
    } catch (error) {
      setIsRawPreview(tabularPreview.is_raw_view);
      addToast('error', `Failed to switch view: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsTogglingRaw(false);
    }
  };

  const onSelectRowLimit = (newLimit: number) => {
    if (!tabularPreview) return;
    if (newLimit === rowLimit) return;
    if ((newLimit === 0 || newLimit >= 5000) && tabularPreview.row_count > 1000) {
      setPendingLimit(newLimit);
      setShowLimitWarning(true);
      return;
    }
    void executeLimitChange(newLimit);
  };

  const executeLimitChange = async (limitToApply: number) => {
    if (!tabularPreview) return;
    setIsChangingLimit(true);
    try {
      await fetchNodePreview(tabularPreview.node_id, limitToApply);
      setRowLimit(limitToApply);
      addToast(
        'info',
        `Loaded ${limitToApply === 0 ? 'all ' + tabularPreview.row_count.toLocaleString() : limitToApply} rows.`,
      );
    } catch (err) {
      addToast('error', `Failed to load rows: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsChangingLimit(false);
      setShowLimitWarning(false);
      setPendingLimit(null);
    }
  };

  const handleRefresh = async () => {
    if (!tabularPreview) return;
    setIsRefreshing(true);
    try {
      setRowLimit(100);
      setColumnFilters({});
      setActiveFilterCol(null);
      clearColumnAnalysisCache(tabularPreview.node_id);
      await fetchNodePreview(tabularPreview.node_id, 100);
      addToast('success', 'Data preview refreshed.');
    } catch (error) {
      addToast('error', `Failed to refresh preview: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsRefreshing(false);
    }
  };

  const uniqueValuesForActiveCol = useMemo(() => {
    if (!activeFilterCol || !tabularPreview) return [];
    const counts = new Map<string, number>();
    for (const row of tabularPreview.rows) {
      const v = formatCell(row[activeFilterCol]);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([val, count]) => ({ val, count }))
      .sort((a, b) => b.count - a.count || a.val.localeCompare(b.val));
  }, [activeFilterCol, tabularPreview]);

  const filteredUniqueValues = useMemo(() => {
    if (!filterSearch.trim()) return uniqueValuesForActiveCol;
    const q = filterSearch.toLowerCase();
    return uniqueValuesForActiveCol.filter((item) =>
      item.val.toLowerCase().includes(q),
    );
  }, [uniqueValuesForActiveCol, filterSearch]);

  const isAllSelected = useMemo(() => {
    if (uniqueValuesForActiveCol.length === 0) return false;
    return uniqueValuesForActiveCol.every((item) => filterDraft.has(item.val));
  }, [uniqueValuesForActiveCol, filterDraft]);

  const handleToggleSelectAll = () => {
    if (isAllSelected) {
      setFilterDraft(new Set());
    } else {
      setFilterDraft(new Set(uniqueValuesForActiveCol.map((item) => item.val)));
    }
  };

  const openFilterForCol = (col: string) => {
    setActiveFilterCol(col);
    setFilterSearch('');
    const existing = columnFilters[col];
    if (existing) {
      setFilterDraft(new Set(existing));
    } else {
      const vals = new Set<string>();
      for (const row of tabularPreview?.rows ?? []) {
        vals.add(formatCell(row[col]));
      }
      setFilterDraft(vals);
    }
  };

  const handleApplyFilter = () => {
    if (!activeFilterCol || !tabularPreview) return;
    const totalUnique = new Set(tabularPreview.rows.map((r) => formatCell(r[activeFilterCol]))).size;
    if (filterDraft.size === totalUnique || filterDraft.size === 0) {
      setColumnFilters((prev) => {
        const next = { ...prev };
        delete next[activeFilterCol];
        return next;
      });
    } else {
      setColumnFilters((prev) => ({
        ...prev,
        [activeFilterCol]: new Set(filterDraft),
      }));
    }
    setActiveFilterCol(null);
  };

  const handleClearCurrentFilter = () => {
    if (!activeFilterCol) return;
    setColumnFilters((prev) => {
      const next = { ...prev };
      delete next[activeFilterCol];
      return next;
    });
    setActiveFilterCol(null);
  };

  const handleClearAllFilters = () => {
    setColumnFilters({});
    setActiveFilterCol(null);
  };

  const filteredRows = useMemo(() => {
    if (!tabularPreview) return [];
    const filterEntries = Object.entries(columnFilters);
    if (filterEntries.length === 0) return tabularPreview.rows;
    return tabularPreview.rows.filter((row) => {
      for (const [col, allowedSet] of filterEntries) {
        if (!allowedSet || allowedSet.size === 0) continue;
        const cellVal = formatCell(row[col]);
        if (!allowedSet.has(cellVal)) return false;
      }
      return true;
    });
  }, [tabularPreview, columnFilters]);

  const activeFilterCount = Object.keys(columnFilters).length;

  const handleExport = (format: 'csv' | 'xlsx') => {
    if (!tabularPreview) return;
    const filename = safeFilename(selectedNodeLabel, tabularPreview);
    if (format === 'csv') exportPreviewToCSV(tabularPreview, filename);
    else exportPreviewToExcel(tabularPreview, filename);
    addToast('success', `Exported ${filename}.${format === 'csv' ? 'csv' : 'xlsx'}.`);
  };

  const flashKey = tabularPreview
    ? [
        tabularPreview.node_id,
        tabularPreview.is_raw_view ? 'raw' : 'processed',
        tabularPreview.row_count,
        tabularPreview.rows.length,
        filteredRows.length,
        tabularPreview.last_modified_columns.join(','),
      ].join('|')
    : 'empty';

  return (
    <section
      className="fixed inset-x-0 bottom-0 z-40 flex flex-col border-t-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]"
      style={{ height: clampHeight(bottomDrawerHeight) }}
      aria-label="Data explorer drawer"
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize data explorer"
        aria-valuenow={Math.round(bottomDrawerHeight)}
        aria-valuemin={MIN_DRAWER_HEIGHT}
        aria-valuemax={Math.max(MIN_DRAWER_HEIGHT, window.innerHeight - 140)}
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        onDoubleClick={() => setBottomDrawerHeight(DEFAULT_DRAWER_HEIGHT)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          setBottomDrawerHeight(
            clampHeight(bottomDrawerHeight + (event.key === 'ArrowUp' ? 16 : -16)),
          );
        }}
        tabIndex={0}
        className={`flex h-5 shrink-0 touch-none select-none items-center justify-center border-b-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] ${
          isResizing ? 'cursor-ns-resize' : 'cursor-ns-resize'
        }`}
        title="Drag to resize · Double-click to reset"
      >
        <GripHorizontal size={18} className="text-[var(--text-muted)]" />
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] px-3 py-1.5">
        <div className="flex items-center gap-1" role="tablist" aria-label="Data explorer tabs">
          <button
            type="button"
            role="tab"
            aria-selected={activeBottomTab === 'preview'}
            onClick={() => setActiveBottomTab('preview')}
            className={`${TAB_BUTTON} ${
              activeBottomTab === 'preview'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--bg-card)]'
                : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Table2 size={13} />
            Tabular Data Preview
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeBottomTab === 'logs'}
            onClick={() => setActiveBottomTab('logs')}
            className={`${TAB_BUTTON} ${
              activeBottomTab === 'logs'
                ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--bg-card)]'
                : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]'
            }`}
          >
            <Terminal size={13} />
            Process Logs / Console
          </button>
        </div>

        {activeBottomTab === 'preview' && tabularPreview && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] text-[var(--text-muted)]">
              {selectedNodeLabel} · {tabularPreview.row_count.toLocaleString()} rows
              {activeFilterCount > 0
                ? ` · filtered ${filteredRows.length} of ${tabularPreview.rows.length}`
                : ` · showing ${tabularPreview.rows.length}`}
            </span>

            {/* Row limit selector */}
            <div className="flex items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-1.5 py-0.5 rounded-[var(--border-radius)] text-[11px]">
              <span className="text-[10px] text-[var(--text-muted)] font-semibold">Limit:</span>
              <select
                value={rowLimit}
                onChange={(e) => onSelectRowLimit(Number(e.target.value))}
                disabled={isChangingLimit || isRefreshing}
                className="bg-transparent font-bold text-[var(--text-main)] outline-none cursor-pointer"
                title="Pilih jumlah baris yang dimuat"
              >
                {ROW_LIMIT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value} className="bg-[var(--bg-card)] text-[var(--text-main)]">
                    {opt.label}
                  </option>
                ))}
              </select>
              {isChangingLimit && <Loader2 size={11} className="animate-spin text-[var(--accent-primary)]" />}
            </div>

            {/* Clear visual filter button if active */}
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={handleClearAllFilters}
                className="flex items-center gap-1 border-[length:var(--border-width)] border-[var(--accent-warning)] bg-[var(--accent-warning)]/10 px-2 py-1 text-[10px] font-bold text-[var(--accent-warning)] rounded-[var(--border-radius)] hover:bg-[var(--accent-warning)]/20"
                title="Hapus semua filter visual kolom"
              >
                <FilterX size={11} />
                Clear Filters ({activeFilterCount})
              </button>
            )}

            {/* Toggle raw / processed */}
            <button
              type="button"
              onClick={handleToggleRaw}
              disabled={isTogglingRaw || isRefreshing}
              className={TOOL_BUTTON}
              aria-pressed={isRawView}
            >
              {isTogglingRaw ? (
                <Loader2 size={12} className="animate-spin" />
              ) : isRawView ? (
                <EyeOff size={12} />
              ) : (
                <Eye size={12} />
              )}
              {isRawView ? 'View Processed Data' : 'View Raw Data'}
            </button>

            {/* Refresh Button */}
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={isRefreshing || isTogglingRaw || isChangingLimit}
              className={TOOL_BUTTON}
              title="Refresh preview data (reset visual filters & row limit ke 100)"
            >
              <RefreshCw size={12} className={isRefreshing ? 'animate-spin text-[var(--accent-primary)]' : ''} />
              Refresh
            </button>

            <button
              type="button"
              onClick={() => handleExport('csv')}
              disabled={tabularPreview.rows.length === 0}
              className={TOOL_BUTTON}
            >
              <Download size={12} />
              Export CSV
            </button>
            <button
              type="button"
              onClick={() => handleExport('xlsx')}
              disabled={tabularPreview.rows.length === 0}
              className={TOOL_BUTTON}
            >
              <FileSpreadsheet size={12} />
              Export Excel
            </button>
          </div>
        )}

        {activeBottomTab === 'logs' && (
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-[var(--text-muted)]">
              {processLogs.length} entries
            </span>
            <button
              type="button"
              onClick={clearProcessLogs}
              disabled={processLogs.length === 0}
              className={TOOL_BUTTON}
            >
              <Trash2 size={12} />
              Clear Console
            </button>
          </div>
        )}
      </div>

      {activeBottomTab === 'preview' ? (
        <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
          {activeFilterCol && (
            <div
              className="fixed inset-0 z-20"
              onClick={() => setActiveFilterCol(null)}
              aria-hidden="true"
            />
          )}
          {!tabularPreview ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Table2 size={26} className="text-[var(--text-muted)]" />
              <p className="text-sm font-bold text-[var(--text-main)]">No preview loaded</p>
              <p className="max-w-md text-xs text-[var(--text-muted)]">
                Open a node and run its preview action. The first 100 rows appear here.
              </p>
            </div>
          ) : columns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Info size={24} className="text-[var(--accent-warning)]" />
              <p className="text-sm font-bold text-[var(--text-main)]">Preview is empty</p>
              <p className="text-xs text-[var(--text-muted)]">
                The node returned no columns. Check its configuration or upstream data.
              </p>
            </div>
          ) : (
            <table className="min-w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 z-10">
                <tr>
                  {columns.map((column) => {
                    const header = headerByName.get(column);
                    const fillRate = header?.fill_rate_pct ?? 0;
                    const nullRate =
                      header?.null_pct ?? Math.max(0, Math.min(100, 100 - fillRate));
                    const isModified = modifiedColumns.has(column);
                    const isColFiltered = Boolean(columnFilters[column] && columnFilters[column].size > 0);
                    const isFilterOpen = activeFilterCol === column;

                    return (
                      <th
                        key={column}
                        scope="col"
                        className="relative min-w-[180px] border-b-[length:var(--border-width)] border-r-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 align-top last:border-r-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p
                              className="truncate font-mono text-[11px] font-bold text-[var(--text-main)]"
                              title={column}
                            >
                              {column}
                            </p>
                            <p className="font-mono text-[9px] text-[var(--text-muted)]">
                              {header?.dtype || 'unknown'}
                              {header ? ` · ${header.unique_count.toLocaleString()} unique` : ''}
                            </p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                if (isFilterOpen) {
                                  setActiveFilterCol(null);
                                } else {
                                  openFilterForCol(column);
                                }
                              }}
                              className={`flex shrink-0 items-center gap-0.5 border-[length:var(--border-width)] px-1.5 py-0.5 text-[9px] font-bold rounded-[var(--border-radius)] transition-colors ${
                                isColFiltered
                                  ? 'border-[var(--accent-warning)] bg-[var(--accent-warning)]/15 text-[var(--accent-warning)]'
                                  : 'border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]'
                              }`}
                              title={`Filter ${column} (${isColFiltered ? `${columnFilters[column].size} values selected` : 'all'})`}
                            >
                              <Filter size={10} className={isColFiltered ? 'fill-[var(--accent-warning)]' : ''} />
                            </button>
                            <button
                              type="button"
                              onClick={() => setActiveAnalysisColumn(column)}
                              className="flex shrink-0 items-center gap-1 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:border-[var(--accent-primary)] hover:text-[var(--accent-primary)]"
                              title={`Analyze ${column}`}
                            >
                              <BarChart3 size={10} />
                              Analyze
                            </button>
                          </div>
                        </div>

                        {/* Filter Popover */}
                        {isFilterOpen && (
                          <div className="absolute left-1 top-full mt-1 z-30 w-64 rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-card)] p-2.5 shadow-xl text-xs text-[var(--text-main)] font-sans">
                            <div className="flex items-center justify-between pb-1.5 border-b border-[var(--border-color)] mb-2">
                              <span className="font-bold text-[11px] truncate text-[var(--text-main)]">Filter: {column}</span>
                              <button
                                type="button"
                                onClick={() => setActiveFilterCol(null)}
                                className="text-[var(--text-muted)] hover:text-[var(--text-main)] p-0.5"
                              >
                                <X size={13} />
                              </button>
                            </div>

                            {/* Search box */}
                            <div className="relative mb-2">
                              <Search size={12} className="absolute left-2 top-2 text-[var(--text-muted)]" />
                              <input
                                type="text"
                                placeholder="Cari nilai..."
                                value={filterSearch}
                                onChange={(e) => setFilterSearch(e.target.value)}
                                className="w-full pl-6 pr-2 py-1 text-[11px] bg-[var(--bg-canvas)] border border-[var(--border-color)] rounded-[var(--border-radius)] text-[var(--text-main)] focus:outline-none focus:border-[var(--accent-primary)] font-normal"
                                autoFocus
                              />
                            </div>

                            {/* Select all checkbox */}
                            <div className="flex items-center justify-between py-1 px-1 border-b border-[var(--border-color)] mb-1 text-[11px]">
                              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={isAllSelected}
                                  onChange={handleToggleSelectAll}
                                  className="rounded text-[var(--accent-primary)] cursor-pointer"
                                />
                                <span className="font-semibold text-[var(--text-main)]">(Select All)</span>
                              </label>
                              <span className="text-[10px] text-[var(--text-muted)] font-normal">
                                {filterDraft.size} / {uniqueValuesForActiveCol.length}
                              </span>
                            </div>

                            {/* Value list */}
                            <div className="max-h-40 overflow-y-auto space-y-0.5 py-1 text-[11px]">
                              {filteredUniqueValues.length === 0 ? (
                                <div className="text-[10px] text-[var(--text-muted)] text-center py-2">
                                  Tidak ada nilai cocok
                                </div>
                              ) : (
                                filteredUniqueValues.map(({ val, count }) => {
                                  const checked = filterDraft.has(val);
                                  return (
                                    <label
                                      key={val}
                                      className="flex items-center justify-between gap-2 px-1.5 py-0.5 rounded hover:bg-[var(--bg-hover)] cursor-pointer select-none font-normal"
                                    >
                                      <div className="flex items-center gap-1.5 min-w-0">
                                        <input
                                          type="checkbox"
                                          checked={checked}
                                          onChange={() => {
                                            setFilterDraft((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(val)) next.delete(val);
                                              else next.add(val);
                                              return next;
                                            });
                                          }}
                                          className="rounded text-[var(--accent-primary)] cursor-pointer"
                                        />
                                        <span className="truncate font-mono text-[11px]" title={val}>
                                          {val === '' ? '(empty)' : val}
                                        </span>
                                      </div>
                                      <span className="shrink-0 text-[9px] text-[var(--text-muted)] font-mono">
                                        {count}
                                      </span>
                                    </label>
                                  );
                                })
                              )}
                            </div>

                            {/* Actions: Apply & Clear */}
                            <div className="flex items-center justify-between pt-2 border-t border-[var(--border-color)] mt-2">
                              <button
                                type="button"
                                onClick={handleClearCurrentFilter}
                                className="text-[10px] text-[var(--accent-danger)] hover:underline"
                              >
                                Hapus Filter
                              </button>
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => setActiveFilterCol(null)}
                                  className="px-2 py-0.5 text-[10px] border border-[var(--border-color)] rounded-[var(--border-radius)] hover:bg-[var(--bg-hover)]"
                                >
                                  Batal
                                </button>
                                <button
                                  type="button"
                                  onClick={handleApplyFilter}
                                  className="px-2.5 py-0.5 text-[10px] font-bold bg-[var(--accent-primary)] text-white rounded-[var(--border-radius)] hover:opacity-90"
                                >
                                  Terapkan
                                </button>
                              </div>
                            </div>
                          </div>
                        )}

                        <FillRateBar fillRate={fillRate} nullRate={nullRate} />
                        {isModified && (
                          <p className="mt-0.5 text-[9px] font-bold text-[var(--accent-secondary)]">
                            modified by recipe
                          </p>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody key={flashKey}>
                {tabularPreview.rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-3 py-6 text-center text-xs text-[var(--text-muted)]"
                    >
                      No rows returned.
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={columns.length}
                      className="px-3 py-8 text-center text-xs text-[var(--text-muted)]"
                    >
                      <div className="flex flex-col items-center justify-center gap-1.5">
                        <FilterX size={20} className="text-[var(--accent-warning)]" />
                        <p className="font-bold text-[var(--text-main)]">
                          Tidak ada baris yang cocok dengan filter visual
                        </p>
                        <button
                          type="button"
                          onClick={handleClearAllFilters}
                          className="mt-1 text-[11px] text-[var(--accent-primary)] underline hover:opacity-80"
                        >
                          Hapus semua filter visual
                        </button>
                      </div>
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, rowIndex) => (
                    <tr
                      key={rowIndex}
                      className="hover:bg-[var(--bg-hover)]"
                    >
                      {columns.map((column) => {
                        const value = row[column];
                        const isNull = value === null || value === undefined;
                        return (
                          <td
                            key={column}
                            className={`max-w-[320px] truncate border-b border-r-[length:var(--border-width)] border-[var(--border-color)] px-2 py-1 font-mono text-[11px] last:border-r-0 ${
                              isNull
                                ? 'italic text-[var(--text-muted)]'
                                : 'text-[var(--text-main)]'
                            } ${modifiedColumns.has(column) ? 'flash-modified-cell' : ''}`}
                            title={isNull ? 'null' : formatCell(value)}
                          >
                            {formatCell(value)}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-2" role="tabpanel">
          {chronologicalLogs.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <Terminal size={24} className="text-[var(--text-muted)]" />
              <p className="text-sm font-bold text-[var(--text-main)]">Console is empty</p>
              <p className="text-xs text-[var(--text-muted)]">
                Pipeline runs, previews, warnings, and backend errors appear here.
              </p>
            </div>
          ) : (
            <ol className="space-y-1">
              {chronologicalLogs.map((entry) => {
                const color =
                  entry.level === 'ERROR'
                    ? 'var(--accent-danger)'
                    : entry.level === 'WARN'
                      ? 'var(--accent-warning)'
                      : 'var(--accent-primary)';
                const LevelIcon =
                  entry.level === 'ERROR'
                    ? AlertCircle
                    : entry.level === 'WARN'
                      ? Info
                      : Terminal;
                return (
                  <li
                    key={entry.id}
                    className="flex items-start gap-2 border-b border-[var(--border-color)] px-1.5 py-1 font-mono text-[11px] last:border-b-0"
                  >
                    <span className="shrink-0 text-[var(--text-muted)]">
                      {formatLogTime(entry.timestamp)}
                    </span>
                    <span
                      className="flex shrink-0 items-center gap-1 font-bold"
                      style={{ color }}
                    >
                      <LevelIcon size={11} />
                      {entry.level}
                    </span>
                    {entry.nodeId && (
                      <span className="shrink-0 text-[var(--text-muted)]">[{entry.nodeId}]</span>
                    )}
                    <span className="min-w-0 whitespace-pre-wrap break-words text-[var(--text-main)]">
                      {entry.message}
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      {showLimitWarning && pendingLimit !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-card)] p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="rounded-full bg-[var(--accent-warning)]/20 p-2 text-[var(--accent-warning)]">
                <AlertCircle size={22} />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-bold text-[var(--text-main)]">
                  Peringatan Kinerja (Performance Warning)
                </h3>
                <p className="mt-1.5 text-xs text-[var(--text-muted)] leading-relaxed">
                  Anda memilih untuk memuat{' '}
                  <strong className="text-[var(--text-main)]">
                    {pendingLimit === 0
                      ? `semua baris (${tabularPreview?.row_count.toLocaleString() ?? 'seluruh data'})`
                      : `${pendingLimit.toLocaleString()} baris`}
                  </strong>
                  .
                  Memuat data dalam jumlah sangat besar sekaligus dapat menyebabkan browser terasa berat atau memori meningkat.
                </p>
                <p className="mt-2 text-xs text-[var(--text-muted)]">
                  Apakah Anda ingin tetap melanjutkan pemuatan data ini?
                </p>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-2 border-t border-[var(--border-color)] pt-3">
              <button
                type="button"
                onClick={() => {
                  setShowLimitWarning(false);
                  setPendingLimit(null);
                }}
                className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-1.5 text-xs font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
              >
                Batal
              </button>
              <button
                type="button"
                onClick={() => void executeLimitChange(pendingLimit)}
                className="rounded-[var(--border-radius)] bg-[var(--accent-warning)] px-3 py-1.5 text-xs font-bold text-black hover:opacity-90"
              >
                Lanjutkan & Muat Data
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
