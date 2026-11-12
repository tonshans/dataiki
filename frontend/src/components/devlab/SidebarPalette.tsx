import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import {
  BrainCircuit,
  Combine,
  Cpu,
  Database,
  GitFork,
  HardDriveDownload,
  Layers,
  Layers3,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Play,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { listFlowGroups, runFlowGroupNow } from '../../api/client';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { FlowGroup, NodeConfig, UINodeKind } from '../../types/dataiki';
import { FlowGroupModal } from './FlowGroupModal';

// FlowCanvas reads this same MIME key on drop; payload is the UINodeKind string.
export const PALETTE_DRAG_MIME = 'application/dataiki-node-kind';

interface PaletteItem {
  kind: UINodeKind;
  label: string;
  description: string;
  icon: LucideIcon;
}

const PALETTE_ITEMS: PaletteItem[] = [
  {
    kind: 'datasource',
    label: 'DataSource',
    description: 'Database query, file, directory, or REST API input.',
    icon: Database,
  },
  {
    kind: 'recipe',
    label: 'Data Recipe',
    description: 'Stackable Polars cleaning and transformation steps.',
    icon: Layers,
  },
  {
    kind: 'split_data',
    label: 'Split Data',
    description: 'Branch rows into Path A and Path B experiments.',
    icon: GitFork,
  },
  {
    kind: 'joiner',
    label: 'Joiner',
    description: 'Combine two inputs with an INNER, LEFT, RIGHT, or FULL join.',
    icon: Combine,
  },
  {
    kind: 'python_script',
    label: 'Python Script',
    description: 'Custom Polars transform running inside the pipeline.',
    icon: Terminal,
  },
  {
    kind: 'ml_studio',
    label: 'ML Studio',
    description: 'Screen, tune, and publish machine learning models.',
    icon: BrainCircuit,
  },
  {
    kind: 'prediction_model',
    label: 'Prediction Model',
    description: 'Score upstream data with a published model + post-calc script.',
    icon: Cpu,
  },
  {
    kind: 'data_output',
    label: 'Data Output',
    description: 'Write pipeline results to a database table or local file.',
    icon: HardDriveDownload,
  },
];

const CARD_BASE =
  'group flex w-full items-center gap-2.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-2 text-left shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

export function SidebarPalette() {
  const isOpen = useUIStore((state) => state.isLeftPaletteOpen);
  const toggleLeftPalette = useUIStore((state) => state.toggleLeftPalette);
  const addToast = useUIStore((state) => state.addToast);
  const addNodeFromPalette = usePipelineStore((state) => state.addNodeFromPalette);
  const activeProjectKey = usePipelineStore((state) => state.activeProjectKey);
  const nodes = usePipelineStore((state) => state.nodes);
  const edges = usePipelineStore((state) => state.edges);

  // ---- Flow Groups state ----
  const [groups, setGroups] = useState<FlowGroup[]>([]);
  const [isGroupsLoading, setIsGroupsLoading] = useState(false);
  const [runningGroupId, setRunningGroupId] = useState<string | null>(null);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<FlowGroup | null>(null);

  const refreshGroups = useCallback(async () => {
    if (!activeProjectKey) {
      setGroups([]);
      return;
    }
    setIsGroupsLoading(true);
    try {
      setGroups(await listFlowGroups(activeProjectKey));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      addToast('error', `Gagal memuat Flow Groups: ${message}`);
    } finally {
      setIsGroupsLoading(false);
    }
  }, [activeProjectKey, addToast]);

  useEffect(() => {
    void refreshGroups();
  }, [refreshGroups]);

  const modalNodes = useMemo<NodeConfig[]>(
    () =>
      nodes
        .filter((node) => !node.data.is_ghost)
        .map((node) => ({
          node_id: node.data.node_id,
          node_type: node.data.node_type,
          label: node.data.label,
          position: { x: node.position.x, y: node.position.y },
          params: { ...node.data.params },
          recipe_steps: node.data.recipe_steps ?? [],
        })),
    [nodes],
  );

  const modalEdges = useMemo(
    () =>
      edges.map((edge) => ({
        edge_id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      })),
    [edges],
  );

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected && !node.data.is_ghost).map((node) => node.id),
    [nodes],
  );

  const handleRunGroup = useCallback(
    async (group: FlowGroup) => {
      setRunningGroupId(group.group_id);
      try {
        const result = await runFlowGroupNow(group.group_id, {}, 'summary');
        addToast('success', `${group.group_name}: ${result.output_summary}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        addToast('error', `${group.group_name} gagal: ${message}`);
      } finally {
        setRunningGroupId(null);
        void refreshGroups();
      }
    },
    [addToast, refreshGroups],
  );

  const closeGroupModal = useCallback(() => {
    setShowGroupModal(false);
    setEditingGroup(null);
  }, []);

  const startDrag = useCallback(
    (event: DragEvent<HTMLButtonElement>, kind: UINodeKind) => {
      event.dataTransfer.setData(PALETTE_DRAG_MIME, kind);
      event.dataTransfer.effectAllowed = 'move';
    },
    [],
  );

  return (
    <aside
      aria-label="Node palette"
      className={`flex h-full shrink-0 flex-col border-r-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] transition-[width] duration-200 ${
        isOpen ? 'w-[250px]' : 'w-[58px]'
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b-[length:var(--border-width)] border-[var(--border-color)] px-2 py-2">
        {isOpen && (
          <div className="min-w-0">
            <h2 className="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">
              Node Palette
            </h2>
            <p className="truncate text-[10px] text-[var(--text-muted)]">
              Drag or click to add
            </p>
          </div>
        )}
        <button
          type="button"
          onClick={toggleLeftPalette}
          title={isOpen ? 'Collapse palette' : 'Expand palette'}
          aria-label={isOpen ? 'Collapse node palette' : 'Expand node palette'}
          aria-expanded={isOpen}
          className={`flex h-8 w-8 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-main)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] ${
            isOpen ? '' : 'mx-auto'
          }`}
        >
          {isOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
      </div>

      <div
        className={`min-h-0 flex-1 overflow-y-auto ${
          isOpen ? 'space-y-2 p-2' : 'space-y-2 p-1.5'
        }`}
      >
        {PALETTE_ITEMS.map((item) => {
          const Icon = item.icon;

          if (!isOpen) {
            return (
              <button
                key={item.kind}
                type="button"
                draggable
                onDragStart={(event) => startDrag(event, item.kind)}
                onClick={() => addNodeFromPalette(item.kind)}
                title={`${item.label} — ${item.description}`}
                aria-label={`Add ${item.label} node`}
                className="flex h-10 w-10 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--accent-primary)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                <Icon size={18} />
              </button>
            );
          }

          return (
            <button
              key={item.kind}
              type="button"
              draggable
              onDragStart={(event) => startDrag(event, item.kind)}
              onClick={() => addNodeFromPalette(item.kind)}
              title={item.description}
              aria-label={`Add ${item.label} node`}
              className={CARD_BASE}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] text-[var(--accent-primary)] rounded-[var(--border-radius)]">
                <Icon size={18} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-bold text-[var(--text-main)]">
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[10px] leading-tight text-[var(--text-muted)]">
                  {item.description}
                </span>
              </span>
            </button>
          );
        })}

        {isOpen && (
          <section className="space-y-2 border-t-[length:var(--border-width)] border-[var(--border-color)] pt-2">
            <div className="flex items-center justify-between px-1">
              <h2 className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)]">
                Flow Groups
              </h2>
              <button
                type="button"
                onClick={() => {
                  setEditingGroup(null);
                  setShowGroupModal(true);
                }}
                title="Buat Flow Group dari node terpilih"
                aria-label="Buat Flow Group"
                className="flex h-6 w-6 items-center justify-center rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] text-[var(--accent-primary)] hover:bg-[var(--bg-hover)]"
              >
                <Layers3 size={12} />
              </button>
            </div>

            {isGroupsLoading && groups.length === 0 && (
              <p className="px-1 text-[10px] text-[var(--text-muted)]">Memuat…</p>
            )}
            {!isGroupsLoading && groups.length === 0 && (
              <p className="px-1 text-[10px] text-[var(--text-muted)]">
                Belum ada group. Seleksi ≥2 node lalu klik ikon di atas.
              </p>
            )}

            {groups.map((group) => (
              <div
                key={group.group_id}
                className="space-y-1 rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-canvas)] p-2"
              >
                <div className="flex items-center gap-1.5">
                  <Layers3 size={12} className="shrink-0 text-[var(--accent-primary)]" />
                  <span className="truncate text-xs font-bold text-[var(--text-main)]">
                    {group.group_name}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1 text-[9px] text-[var(--text-muted)]">
                  <span className="truncate font-mono">/{group.group_slug}</span>
                  {group.is_api_enabled && (
                    <span className="rounded-full bg-[var(--accent-primary)] px-1.5 text-white">
                      API
                    </span>
                  )}
                  {group.schedule_config.is_scheduled && (
                    <span className="rounded-full bg-[var(--accent-secondary)] px-1.5 text-white">
                      Jadwal
                    </span>
                  )}
                  <span>{group.last_status}</span>
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => void handleRunGroup(group)}
                    disabled={runningGroupId === group.group_id}
                    className="flex items-center gap-1 rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
                  >
                    {runningGroupId === group.group_id ? (
                      <Loader2 size={9} className="animate-spin" />
                    ) : (
                      <Play size={9} />
                    )}
                    Run
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingGroup(group);
                      setShowGroupModal(true);
                    }}
                    className="flex items-center gap-1 rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] px-1.5 py-0.5 text-[9px] font-semibold text-[var(--text-main)] hover:bg-[var(--bg-hover)]"
                  >
                    <Pencil size={9} />
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}
      </div>

      {isOpen && (
        <p className="shrink-0 border-t-[length:var(--border-width)] border-[var(--border-color)] px-2 py-2 text-[10px] text-[var(--text-muted)]">
          Double-click a node on the canvas to configure it.
        </p>
      )}

      {showGroupModal && (
        <FlowGroupModal
          existingGroup={editingGroup}
          projectKey={activeProjectKey}
          allNodes={modalNodes}
          allEdges={modalEdges}
          selectedNodeIds={editingGroup?.node_ids ?? selectedNodeIds}
          onClose={closeGroupModal}
          onSaved={() => {
            closeGroupModal();
            void refreshGroups();
          }}
          onDeleted={() => void refreshGroups()}
        />
      )}
    </aside>
  );
}
