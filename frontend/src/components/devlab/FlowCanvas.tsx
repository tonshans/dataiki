import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  EdgeProps,
  EdgeTypes,
  Node,
  NodeMouseHandler,
  NodeProps,
  NodeTypes,
  XYPosition,
} from '@xyflow/react';
import { Layers3, Plus, X } from 'lucide-react';
import { nodeTypes } from './CustomNodes';
import { FlowGroupModal } from './FlowGroupModal';
import { PALETTE_DRAG_MIME } from './SidebarPalette';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type {
  BackendNodeType,
  CanvasNodeData,
  FlowGroup,
  NodeConfig,
  UINodeKind,
} from '../../types/dataiki';

type FlowNode = Node<CanvasNodeData>;

// Mirrors the store port contract for pre-connect feedback; store still rejects onConnect.
const MAX_INPUTS: Record<UINodeKind, number> = {
  datasource: 0,
  recipe: 1,
  split_data: 1,
  joiner: 2,
  python_script: 1,
  ml_studio: 1,
  prediction_model: 1,
  data_output: 1,
};

const MAX_OUTPUTS: Record<UINodeKind, number> = {
  datasource: Infinity,
  recipe: Infinity,
  split_data: Infinity,
  joiner: Infinity,
  python_script: Infinity,
  ml_studio: 0,
  prediction_model: Infinity,
  data_output: 0,
};

const BACKEND_NODE_TYPE: Record<UINodeKind, BackendNodeType> = {
  datasource: 'ingestion',
  recipe: 'data_recipe',
  split_data: 'data_recipe',
  joiner: 'join',
  python_script: 'py_transform',
  ml_studio: 'ml_studio',
  prediction_model: 'prediction',
  data_output: 'data_output',
};

const UI_NODE_KINDS = new Set<UINodeKind>([
  'datasource',
  'recipe',
  'split_data',
  'joiner',
  'python_script',
  'ml_studio',
  'prediction_model',
  'data_output',
]);

function isUINodeKind(value: string): value is UINodeKind {
  return UI_NODE_KINDS.has(value as UINodeKind);
}

function createsCycle(edges: Edge[], source: string, target: string): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.source) ?? [];
    next.push(edge.target);
    adjacency.set(edge.source, next);
  }

  const stack = [target];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === source) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function GhostNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className="pointer-events-none flex w-[112px] flex-col items-center gap-1 opacity-50">
      <div className="flex h-14 w-14 items-center justify-center border-[length:var(--border-width)] border-dashed border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--text-muted)] rounded-[var(--border-radius)]">
        <Plus size={22} />
      </div>
      <span className="whitespace-nowrap border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--text-muted)] shadow-[var(--shadow-card)] rounded-[var(--border-radius)]">
        {data.label}
      </span>
    </div>
  );
}

const CANVAS_NODE_TYPES: NodeTypes = {
  ...nodeTypes,
  ghost: GhostNode,
};

function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  selected,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const removeEdge = usePipelineStore((state) => state.removeEdge);
  const [isHovered, setIsHovered] = useState(false);

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth: selected || isHovered ? 2.5 : 1.75,
          stroke: selected
            ? 'var(--accent-primary)'
            : isHovered
              ? 'var(--accent-secondary)'
              : 'var(--border-color)',
          transition: 'stroke 0.15s, stroke-width 0.15s',
        }}
        interactionWidth={30}
      />
      <EdgeLabelRenderer>
        <div
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
        >
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              removeEdge(id);
            }}
            title="Hapus hubungan ini (atau klik garis lalu tekan tombol Del)"
            className={`flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--accent-danger)] shadow-md transition-all hover:scale-125 hover:border-[var(--accent-danger)] hover:bg-[var(--accent-danger)] hover:text-white ${selected || isHovered ? 'opacity-100 scale-100' : 'opacity-0 pointer-events-none scale-90'
              }`}
          >
            <X size={11} strokeWidth={2.5} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const CANVAS_EDGE_TYPES: EdgeTypes = {
  default: DeletableEdge,
};

function ghostNode(
  kind: UINodeKind,
  label: string,
  position: XYPosition,
): FlowNode {
  return {
    id: `ghost_${kind}`,
    type: 'ghost',
    position,
    data: {
      node_id: `ghost_${kind}`,
      node_type: BACKEND_NODE_TYPE[kind],
      ui_node_kind: kind,
      label,
      params: {},
      recipe_steps: [],
      is_ghost: true,
    },
    draggable: false,
    selectable: false,
    connectable: false,
    deletable: false,
    focusable: false,
    style: { pointerEvents: 'none' },
  };
}

function FlowCanvasInner() {
  const nodes = usePipelineStore((state) => state.nodes);
  const edges = usePipelineStore((state) => state.edges);
  const onNodesChange = usePipelineStore((state) => state.onNodesChange);
  const onEdgesChange = usePipelineStore((state) => state.onEdgesChange);
  const onConnect = usePipelineStore((state) => state.onConnect);
  const removeEdge = usePipelineStore((state) => state.removeEdge);
  const addNodeFromPalette = usePipelineStore((state) => state.addNodeFromPalette);
  const activeProjectKey = usePipelineStore((state) => state.activeProjectKey);
  const setSelectedNodeId = usePipelineStore((state) => state.setSelectedNodeId);
  const selectedNodeId = usePipelineStore((state) => state.selectedNodeId);
  const deleteNode = usePipelineStore((state) => state.deleteNode);
  const fetchNodePreview = usePipelineStore((state) => state.fetchNodePreview);

  const setActiveBottomTab = useUIStore((state) => state.setActiveBottomTab);
  const setActiveConfigNodeId = useUIStore((state) => state.setActiveConfigNodeId);
  const activeConfigNodeId = useUIStore((state) => state.activeConfigNodeId);
  const addToast = useUIStore((state) => state.addToast);

  const { screenToFlowPosition } = useReactFlow<FlowNode, Edge>();
  const clickTimer = useRef<number | null>(null);
  const [isPaletteDragging, setIsPaletteDragging] = useState(false);

  // ---- Flow Group modal state ----
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [editingGroup, setEditingGroup] = useState<FlowGroup | null>(null);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => node.selected && !node.data.is_ghost).map((node) => node.id),
    [nodes],
  );

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

  const openCreateGroup = useCallback(() => {
    setEditingGroup(null);
    setShowGroupModal(true);
  }, []);

  const closeGroupModal = useCallback(() => {
    setShowGroupModal(false);
    setEditingGroup(null);
  }, []);

  const clearClickTimer = useCallback(() => {
    if (clickTimer.current !== null) {
      window.clearTimeout(clickTimer.current);
      clickTimer.current = null;
    }
  }, []);

  useEffect(() => clearClickTimer, [clearClickTimer]);

  useEffect(() => {
    const handleDragStart = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes(PALETTE_DRAG_MIME)) {
        setIsPaletteDragging(true);
      }
    };
    const handleDragEnd = () => setIsPaletteDragging(false);

    window.addEventListener('dragstart', handleDragStart);
    window.addEventListener('dragend', handleDragEnd);
    window.addEventListener('drop', handleDragEnd);
    return () => {
      window.removeEventListener('dragstart', handleDragStart);
      window.removeEventListener('dragend', handleDragEnd);
      window.removeEventListener('drop', handleDragEnd);
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      if (activeConfigNodeId) return;

      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      if (selectedNodeId && !selectedNodeId.startsWith('ghost_')) {
        event.preventDefault();
        const targetNode = nodes.find((n) => n.id === selectedNodeId);
        const label = targetNode?.data.label || 'Node';
        void deleteNode(selectedNodeId).then(() => {
          addToast('info', `${label} deleted.`);
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeConfigNodeId, addToast, deleteNode, nodes, selectedNodeId]);

  const ghostNodes = useMemo<FlowNode[]>(() => {
    if (isPaletteDragging) return [];

    const realNodes = nodes.filter((node) => !node.data.is_ghost);
    if (realNodes.length === 0) {
      return [ghostNode('datasource', '+ Add DataSource', { x: 280, y: 120 })];
    }

    const outgoingCount = new Map<string, number>();
    for (const edge of edges) {
      outgoingCount.set(edge.source, (outgoingCount.get(edge.source) ?? 0) + 1);
    }

    const tips = realNodes.filter((node) => {
      const kind = node.data.ui_node_kind;
      if ((MAX_OUTPUTS[kind] ?? 0) === 0) return false;
      return (outgoingCount.get(node.id) ?? 0) === 0;
    });
    if (tips.length === 0) return [];

    const freePorts = tips.length;

    const lastTip = tips[tips.length - 1];
    const ghosts = [
      ghostNode('recipe', '+ Add Recipe', {
        x: lastTip.position.x + 150,
        y: lastTip.position.y,
      }),
    ];

    if (freePorts >= 2) {
      const maxX = Math.max(...tips.map((node) => node.position.x));
      const maxY = Math.max(...tips.map((node) => node.position.y));
      ghosts.push(
        ghostNode('joiner', '+ Join', { x: maxX + 150, y: maxY + 110 }),
      );
    }

    return ghosts;
  }, [edges, isPaletteDragging, nodes]);

  const canvasNodes = useMemo(
    () => (ghostNodes.length > 0 ? [...nodes, ...ghostNodes] : nodes),
    [ghostNodes, nodes],
  );

  const isValidConnection = useCallback(
    (connection: Edge | Connection) => {
      if (connection.source === connection.target) return false;

      const sourceNode = nodes.find((node) => node.id === connection.source);
      const targetNode = nodes.find((node) => node.id === connection.target);
      if (!sourceNode || !targetNode) return false;
      if (sourceNode.data.is_ghost || targetNode.data.is_ghost) return false;

      const sourceKind = sourceNode.data.ui_node_kind;
      const targetKind = targetNode.data.ui_node_kind;
      if ((MAX_OUTPUTS[sourceKind] ?? 0) === 0) return false;
      if ((MAX_INPUTS[targetKind] ?? 0) === 0) return false;

      const maxOut = MAX_OUTPUTS[sourceKind] ?? Infinity;
      const outputCount = edges.filter((edge) => edge.source === connection.source).length;
      const inputCount = edges.filter((edge) => edge.target === connection.target).length;
      if (outputCount >= maxOut) return false;
      if (inputCount >= (MAX_INPUTS[targetKind] ?? 0)) return false;

      // Target port can only accept 1 incoming connection
      const targetHandleUsed = edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle,
      );
      if (targetHandleUsed) return false;

      // Prevent exact duplicate connection between same handles
      const isDuplicate = edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.target === connection.target &&
          edge.sourceHandle === connection.sourceHandle &&
          edge.targetHandle === connection.targetHandle,
      );
      if (isDuplicate) return false;

      return !createsCycle(edges, connection.source, connection.target);
    },
    [edges, nodes],
  );

  const handleNodeClick = useCallback<NodeMouseHandler<FlowNode>>(
    (_event, node) => {
      if (node.data.is_ghost) return;

      clearClickTimer();
      setSelectedNodeId(node.id);
      clickTimer.current = window.setTimeout(() => {
        clickTimer.current = null;
        setActiveBottomTab('preview');
        void fetchNodePreview(node.id).catch((error) => {
          addToast(
            'error',
            `Preview failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }, 220);
    },
    [addToast, clearClickTimer, fetchNodePreview, setActiveBottomTab, setSelectedNodeId],
  );

  const handleNodeDoubleClick = useCallback<NodeMouseHandler<FlowNode>>(
    (_event, node) => {
      if (node.data.is_ghost) return;

      clearClickTimer();
      setSelectedNodeId(node.id);
      setActiveConfigNodeId(node.id);
    },
    [clearClickTimer, setActiveConfigNodeId, setSelectedNodeId],
  );

  const handlePaneClick = useCallback(() => {
    clearClickTimer();
    setSelectedNodeId(null);
  }, [clearClickTimer, setSelectedNodeId]);

  const handleDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const kind = event.dataTransfer.getData(PALETTE_DRAG_MIME);
      if (!isUINodeKind(kind)) return;

      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNodeFromPalette(kind, { x: position.x - 32, y: position.y - 32 });
    },
    [addNodeFromPalette, screenToFlowPosition],
  );

  return (
    <div
      className="relative h-full w-full bg-[var(--bg-canvas)]"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {selectedNodeIds.length >= 2 && (
        <button
          type="button"
          onClick={openCreateGroup}
          title="Bungkus node terpilih menjadi Flow Group"
          className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-[var(--border-radius)] border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-3 py-1.5 text-xs font-semibold text-[var(--text-main)] shadow-[var(--shadow-card)] hover:bg-[var(--bg-hover)]"
        >
          <Layers3 size={14} className="text-[var(--accent-primary)]" />
          Buat Group ({selectedNodeIds.length})
        </button>
      )}
      <ReactFlow
        nodes={canvasNodes}
        edges={edges}
        nodeTypes={CANVAS_NODE_TYPES}
        edgeTypes={CANVAS_EDGE_TYPES}
        defaultEdgeOptions={{ type: 'default' }}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={handlePaneClick}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault();
          removeEdge(edge.id);
        }}
        isValidConnection={isValidConnection}
        deleteKeyCode={['Delete', 'Backspace']}
        fitView
        minZoom={0.25}
        maxZoom={2}
        panOnDrag
        panOnScroll={false}
        zoomOnScroll
        zoomOnPinch
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1}
          color="var(--border-color)"
        />
      </ReactFlow>

      {showGroupModal && (
        <FlowGroupModal
          existingGroup={editingGroup}
          projectKey={activeProjectKey}
          allNodes={modalNodes}
          allEdges={modalEdges}
          selectedNodeIds={editingGroup?.node_ids ?? selectedNodeIds}
          onClose={closeGroupModal}
          onSaved={(group) => {
            addToast('success', `Flow Group "${group.group_name}" disimpan.`);
            closeGroupModal();
          }}
          onDeleted={() => addToast('info', 'Flow Group dihapus.')}
        />
      )}
    </div>
  );
}

export function FlowCanvas() {
  return (
    <ReactFlowProvider>
      <FlowCanvasInner />
    </ReactFlowProvider>
  );
}
