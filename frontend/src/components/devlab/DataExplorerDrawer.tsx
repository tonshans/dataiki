import { useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  AlertCircle,
  BarChart3,
  Download,
  Eye,
  EyeOff,
  FileSpreadsheet,
  GripHorizontal,
  Info,
  Loader2,
  Table2,
  Terminal,
  Trash2,
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

  const [isResizing, setIsResizing] = useState(false);
  const [isTogglingRaw, setIsTogglingRaw] = useState(false);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

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
      await fetchNodePreview(tabularPreview.node_id);
      addToast('info', nextRaw ? 'Showing raw data.' : 'Showing processed data.');
    } catch (error) {
      setIsRawPreview(tabularPreview.is_raw_view);
      addToast('error', `Failed to switch view: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsTogglingRaw(false);
    }
  };

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
              {selectedNodeLabel} · {tabularPreview.row_count.toLocaleString()} rows · showing{' '}
              {tabularPreview.rows.length}
            </span>
            <button
              type="button"
              onClick={handleToggleRaw}
              disabled={isTogglingRaw}
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
                    return (
                      <th
                        key={column}
                        scope="col"
                        className="min-w-[170px] border-b-[length:var(--border-width)] border-r-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 align-top last:border-r-0"
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
                ) : (
                  tabularPreview.rows.map((row, rowIndex) => (
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
    </section>
  );
}
