import { useCallback } from 'react';
import type { DragEvent } from 'react';
import {
  BrainCircuit,
  Combine,
  Database,
  GitFork,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { UINodeKind } from '../../types/dataiki';

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
];

const CARD_BASE =
  'group flex w-full items-center gap-2.5 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] p-2 text-left shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

export function SidebarPalette() {
  const isOpen = useUIStore((state) => state.isLeftPaletteOpen);
  const toggleLeftPalette = useUIStore((state) => state.toggleLeftPalette);
  const addNodeFromPalette = usePipelineStore((state) => state.addNodeFromPalette);

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
      </div>

      {isOpen && (
        <p className="shrink-0 border-t-[length:var(--border-width)] border-[var(--border-color)] px-2 py-2 text-[10px] text-[var(--text-muted)]">
          Double-click a node on the canvas to configure it.
        </p>
      )}
    </aside>
  );
}
