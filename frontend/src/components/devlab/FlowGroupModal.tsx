/**
 * FlowGroupModal — Modal untuk membuat, mengedit, atau menjalankan Flow Group.
 *
 * Flow Group adalah snapshot sub-DAG dari node-node yang dipilih di canvas,
 * yang dapat dijadwalkan (Scheduler) atau di-expose sebagai REST API
 * (Production API Gateway).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  Clock,
  Globe,
  Layers3,
  Loader2,
  Play,
  Save,
  X,
  XCircle,
} from 'lucide-react';
import {
  createFlowGroup,
  deleteFlowGroup,
  runFlowGroupNow,
  updateFlowGroup,
} from '../../api/client';
import type {
  FlowGroup,
  FlowGroupCreate,
  NodeConfig,
  PipelineDAG,
  ScheduleConfig,
} from '../../types/dataiki';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const DEFAULT_SCHEDULE: ScheduleConfig = {
  is_scheduled: false,
  schedule_type: 'unscheduled',
  interval_val: 0,
  daily_time: '',
  run_date: null,
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface FlowGroupModalProps {
  /** Null = mode Create; non-null = mode Edit */
  existingGroup: FlowGroup | null;
  projectKey: string;
  /** All nodes in the current canvas (for the full sub-DAG snapshot) */
  allNodes: NodeConfig[];
  /** All edges in the current canvas */
  allEdges: Array<{ edge_id: string; source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>;
  /** Node IDs selected on the canvas when "Buat Group" was clicked */
  selectedNodeIds: string[];
  onClose: () => void;
  onSaved: (group: FlowGroup) => void;
  onDeleted?: (groupId: string) => void;
}

// ---------------------------------------------------------------------------
// Schedule Picker sub-component
// ---------------------------------------------------------------------------

interface SchedulePickerProps {
  value: ScheduleConfig;
  onChange: (s: ScheduleConfig) => void;
}

function SchedulePicker({ value, onChange }: SchedulePickerProps) {
  const enabled = value.is_scheduled && value.schedule_type !== 'unscheduled';

  return (
    <div className="space-y-2 rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] p-3">
      <label className="flex items-center gap-2 text-xs font-semibold text-[var(--text-main)]">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) =>
            onChange({
              ...value,
              is_scheduled: e.target.checked,
              schedule_type: e.target.checked
                ? value.schedule_type === 'unscheduled'
                  ? 'daily_at'
                  : value.schedule_type
                : 'unscheduled',
            })
          }
          className="accent-[var(--accent-primary)]"
        />
        Aktifkan Penjadwalan Otomatis
      </label>

      {enabled && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <select
              value={value.schedule_type}
              onChange={(e) =>
                onChange({
                  ...value,
                  schedule_type: e.target.value as ScheduleConfig['schedule_type'],
                })
              }
              className="flex-1 rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-main)]"
            >
              <option value="every_minute">Setiap Menit</option>
              <option value="every_hour">Setiap Jam</option>
              <option value="daily_at">Setiap Hari Pukul…</option>
              <option value="specific_date">Tanggal Tertentu</option>
            </select>
          </div>
          {value.schedule_type === 'daily_at' && (
            <input
              type="time"
              value={value.daily_time}
              onChange={(e) => onChange({ ...value, daily_time: e.target.value })}
              className="w-full rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-main)]"
            />
          )}
          {value.schedule_type === 'specific_date' && (
            <input
              type="datetime-local"
              value={value.run_date ?? ''}
              onChange={(e) => onChange({ ...value, run_date: e.target.value })}
              className="w-full rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1 text-xs text-[var(--text-main)]"
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main modal
// ---------------------------------------------------------------------------

export function FlowGroupModal({
  existingGroup,
  projectKey,
  allNodes,
  allEdges,
  selectedNodeIds,
  onClose,
  onSaved,
  onDeleted,
}: FlowGroupModalProps) {
  const isEdit = existingGroup != null;

  // --- Form state ---
  const [groupName, setGroupName] = useState(existingGroup?.group_name ?? '');
  const [groupSlug, setGroupSlug] = useState(existingGroup?.group_slug ?? '');
  const [description, setDescription] = useState(existingGroup?.description ?? '');
  const [outputNodeId, setOutputNodeId] = useState(existingGroup?.output_node_id ?? '');
  const [inputNodeId, setInputNodeId] = useState<string>(existingGroup?.input_node_id ?? '');
  const [isApiEnabled, setIsApiEnabled] = useState(existingGroup?.is_api_enabled ?? false);
  const [schedule, setSchedule] = useState<ScheduleConfig>(
    existingGroup?.schedule_config ?? DEFAULT_SCHEDULE,
  );

  // Which node IDs are in this group
  const [nodeIds, setNodeIds] = useState<string[]>(
    existingGroup?.node_ids ?? selectedNodeIds,
  );

  // --- UI state ---
  const [isSaving, setIsSaving] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [runResult, setRunResult] = useState<{ status: string; rows: number; output_summary: string; error?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [slugTouched, setSlugTouched] = useState(isEdit);

  // Auto-derive slug from name when not manually edited
  useEffect(() => {
    if (!slugTouched) {
      setGroupSlug(slugify(groupName));
    }
  }, [groupName, slugTouched]);

  // Nodes available for selection (all canvas nodes)
  const allNodeOptions = useMemo(
    () => allNodes.map((n) => ({ id: n.node_id, label: n.label || n.node_id })),
    [allNodes],
  );

  // Nodes that are inside the current group selection
  const groupNodeOptions = useMemo(
    () => allNodeOptions.filter((n) => nodeIds.includes(n.id)),
    [allNodeOptions, nodeIds],
  );

  // Build sub-DAG snapshot from nodeIds
  const buildSubDag = useCallback((): PipelineDAG => {
    const idSet = new Set(nodeIds);
    const subNodes = allNodes.filter((n) => idSet.has(n.node_id));
    const subEdges = allEdges.filter((e) => idSet.has(e.source) && idSet.has(e.target));
    return { project_key: projectKey, nodes: subNodes, edges: subEdges };
  }, [nodeIds, allNodes, allEdges, projectKey]);

  // --- Toggle node in/out of group ---
  const toggleNode = (nodeId: string) => {
    setNodeIds((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId],
    );
  };

  // --- Save ---
  const handleSave = async () => {
    if (!groupName.trim()) { setError('Nama group wajib diisi.'); return; }
    if (!groupSlug.trim()) { setError('Slug wajib diisi.'); return; }
    if (nodeIds.length === 0) { setError('Pilih minimal 1 node untuk dimasukkan ke group.'); return; }
    if (!outputNodeId) { setError('Pilih node output group.'); return; }
    if (!nodeIds.includes(outputNodeId)) { setError('Node output harus merupakan bagian dari node group.'); return; }

    setIsSaving(true);
    setError(null);

    const payload: FlowGroupCreate = {
      project_key: projectKey,
      group_name: groupName.trim(),
      group_slug: groupSlug.trim(),
      description: description.trim(),
      node_ids: nodeIds,
      output_node_id: outputNodeId,
      input_node_id: inputNodeId || null,
      sub_dag: buildSubDag(),
      schedule_config: schedule,
      is_api_enabled: isApiEnabled,
    };

    try {
      const saved = isEdit
        ? await updateFlowGroup(existingGroup!.group_id, payload)
        : await createFlowGroup(payload);
      onSaved(saved);
    } catch (err: any) {
      setError(err?.message ?? 'Gagal menyimpan flow group.');
    } finally {
      setIsSaving(false);
    }
  };

  // --- Run once ---
  const handleRunNow = async () => {
    if (!existingGroup) return;
    setIsRunning(true);
    setRunResult(null);
    setError(null);
    try {
      const res = await runFlowGroupNow(existingGroup.group_id, {}, 'summary');
      setRunResult({ status: res.status, rows: res.rows, output_summary: res.output_summary });
    } catch (err: any) {
      setError(err?.message ?? 'Gagal menjalankan flow group.');
    } finally {
      setIsRunning(false);
    }
  };

  // --- Delete ---
  const handleDelete = async () => {
    if (!existingGroup) return;
    setIsDeleting(true);
    try {
      await deleteFlowGroup(existingGroup.group_id);
      onDeleted?.(existingGroup.group_id);
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Gagal menghapus flow group.');
      setIsDeleting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const statusBadge = existingGroup?.last_status;
  const apiUrl = isApiEnabled && groupSlug
    ? `/api/v1/${projectKey}/flow/${groupSlug}`
    : null;

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Flow Group"
    >
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-card)] shadow-2xl">

        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[var(--border-color)] px-4 py-3">
          <Layers3 size={18} className="text-[var(--accent-primary)]" />
          <h2 className="flex-1 text-sm font-bold text-[var(--text-main)]">
            {isEdit ? `Edit Flow Group: ${existingGroup?.group_name}` : 'Buat Flow Group Baru'}
          </h2>
          {statusBadge && statusBadge !== 'never_run' && (
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
              statusBadge === 'success' ? 'bg-[var(--accent-secondary)]/20 text-[var(--accent-secondary)]' :
              statusBadge === 'error' ? 'bg-[var(--accent-danger)]/20 text-[var(--accent-danger)]' :
              'bg-[var(--accent-primary)]/20 text-[var(--accent-primary)]'
            }`}>
              {statusBadge === 'success' ? '✓ Berhasil' : statusBadge === 'error' ? '✗ Gagal' : '⟳ Running'}
            </span>
          )}
          <button type="button" onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-main)]">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto space-y-4 p-4">

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 rounded-[var(--border-radius)] bg-[var(--accent-danger)]/10 border border-[var(--accent-danger)]/30 p-3 text-xs text-[var(--accent-danger)]">
              <XCircle size={14} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Run result banner */}
          {runResult && (
            <div className={`flex items-start gap-2 rounded-[var(--border-radius)] border p-3 text-xs ${
              runResult.status === 'success'
                ? 'bg-[var(--accent-secondary)]/10 border-[var(--accent-secondary)]/30 text-[var(--accent-secondary)]'
                : 'bg-[var(--accent-danger)]/10 border-[var(--accent-danger)]/30 text-[var(--accent-danger)]'
            }`}>
              {runResult.status === 'success'
                ? <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                : <XCircle size={14} className="mt-0.5 shrink-0" />
              }
              <span>{runResult.status === 'success' ? `✓ Berhasil — ${runResult.output_summary}` : runResult.error}</span>
            </div>
          )}

          {/* Basic info */}
          <section className="space-y-3">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Info Group</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-[var(--text-muted)]">Nama Group *</label>
                <input
                  type="text"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  placeholder="mis. ETL Harian"
                  className="w-full rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs text-[var(--text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] font-semibold text-[var(--text-muted)]">Slug (URL-safe) *</label>
                <input
                  type="text"
                  value={groupSlug}
                  onChange={(e) => { setGroupSlug(e.target.value); setSlugTouched(true); }}
                  placeholder="mis. etl-harian"
                  className="w-full rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 font-mono text-xs text-[var(--text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-[var(--text-muted)]">Deskripsi</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="Opsional — deskripsi singkat tentang tujuan flow group ini"
                className="w-full resize-none rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs text-[var(--text-main)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)]"
              />
            </div>
          </section>

          {/* Node selection */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
              Node dalam Group <span className="ml-1 rounded-full bg-[var(--accent-primary)]/20 px-1.5 text-[var(--accent-primary)]">{nodeIds.length}</span>
            </h3>
            <div className="max-h-28 overflow-y-auto rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] p-2 space-y-1">
              {allNodeOptions.map((n) => (
                <label key={n.id} className="flex items-center gap-2 cursor-pointer rounded px-1 py-0.5 hover:bg-[var(--bg-hover)] text-xs text-[var(--text-main)]">
                  <input
                    type="checkbox"
                    checked={nodeIds.includes(n.id)}
                    onChange={() => toggleNode(n.id)}
                    className="accent-[var(--accent-primary)]"
                  />
                  <span className="font-medium">{n.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">{n.id.slice(0, 8)}</span>
                </label>
              ))}
              {allNodeOptions.length === 0 && (
                <p className="text-center text-[10px] text-[var(--text-muted)] py-2">Tidak ada node di canvas.</p>
              )}
            </div>
          </section>

          {/* Output & Input node selectors */}
          <section className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-[var(--text-muted)]">Node Output * <span className="text-[var(--accent-secondary)]">(hasil akhir group)</span></label>
              <select
                value={outputNodeId}
                onChange={(e) => setOutputNodeId(e.target.value)}
                className="w-full rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs text-[var(--text-main)]"
              >
                <option value="">— Pilih node —</option>
                {groupNodeOptions.map((n) => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold text-[var(--text-muted)]">Node Input <span className="text-[var(--text-muted)]">(opsional, inject API payload)</span></label>
              <select
                value={inputNodeId}
                onChange={(e) => setInputNodeId(e.target.value)}
                className="w-full rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-2 py-1.5 text-xs text-[var(--text-main)]"
              >
                <option value="">— Tidak ada —</option>
                {groupNodeOptions.map((n) => (
                  <option key={n.id} value={n.id}>{n.label}</option>
                ))}
              </select>
            </div>
          </section>

          {/* API toggle + URL preview */}
          <section className="space-y-2">
            <h3 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Production API</h3>
            <label className="flex items-center gap-2 cursor-pointer text-xs text-[var(--text-main)]">
              <div
                role="switch"
                aria-checked={isApiEnabled}
                onClick={() => setIsApiEnabled(!isApiEnabled)}
                className={`relative h-5 w-9 cursor-pointer rounded-full transition-colors ${isApiEnabled ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-color)]'}`}
              >
                <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${isApiEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </div>
              <Globe size={13} className="text-[var(--text-muted)]" />
              Expose sebagai REST API
            </label>
            {apiUrl && (
              <div className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2">
                <p className="mb-0.5 text-[10px] font-semibold text-[var(--text-muted)]">Endpoint tersedia di:</p>
                <code className="break-all text-[11px] text-[var(--accent-primary)]">
                  GET/POST {apiUrl}
                </code>
              </div>
            )}
          </section>

          {/* Schedule */}
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
              <Calendar size={12} /> Jadwal Otomatis
            </h3>
            <SchedulePicker value={schedule} onChange={setSchedule} />
          </section>

          {/* Last run info (edit mode only) */}
          {isEdit && existingGroup?.last_run_at && (
            <section className="rounded-[var(--border-radius)] border border-[var(--border-color)] bg-[var(--bg-canvas)] px-3 py-2 text-[10px] text-[var(--text-muted)]">
              <div className="flex items-center gap-1.5">
                <Clock size={11} />
                <span>Terakhir dijalankan: <strong>{new Date(existingGroup.last_run_at).toLocaleString('id-ID')}</strong></span>
              </div>
              {existingGroup.last_output_summary && (
                <p className="mt-1 text-[10px]">Output: {existingGroup.last_output_summary}</p>
              )}
              {existingGroup.last_error && existingGroup.last_status === 'error' && (
                <p className="mt-1 text-[10px] text-[var(--accent-danger)]">{existingGroup.last_error}</p>
              )}
            </section>
          )}

          {/* Delete confirmation */}
          {showDeleteConfirm && (
            <div className="rounded-[var(--border-radius)] border border-[var(--accent-danger)]/40 bg-[var(--accent-danger)]/10 p-3 text-xs text-[var(--accent-danger)] space-y-2">
              <p className="font-semibold">Yakin ingin menghapus flow group ini? Tindakan ini tidak dapat dibatalkan.</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex items-center gap-1 rounded-[var(--border-radius)] bg-[var(--accent-danger)] px-3 py-1 text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  {isDeleting ? <Loader2 size={12} className="animate-spin" /> : null}
                  Hapus
                </button>
                <button
                  type="button"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-[var(--border-radius)] border border-[var(--border-color)] px-3 py-1 text-xs"
                >
                  Batal
                </button>
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-color)] px-4 py-3">
          <div className="flex gap-2">
            {isEdit && onDeleted && !showDeleteConfirm && (
              <button
                type="button"
                onClick={() => setShowDeleteConfirm(true)}
                className="rounded-[var(--border-radius)] border border-[var(--accent-danger)]/40 px-3 py-1.5 text-xs font-semibold text-[var(--accent-danger)] hover:bg-[var(--accent-danger)]/10"
              >
                Hapus Group
              </button>
            )}
            {isEdit && (
              <button
                type="button"
                onClick={handleRunNow}
                disabled={isRunning}
                className="flex items-center gap-1.5 rounded-[var(--border-radius)] border border-[var(--border-color)] px-3 py-1.5 text-xs font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
              >
                {isRunning ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
                Jalankan Sekarang
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--border-radius)] border border-[var(--border-color)] px-4 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              Batal
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 rounded-[var(--border-radius)] bg-[var(--accent-primary)] px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {isEdit ? 'Simpan Perubahan' : 'Buat Group'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

