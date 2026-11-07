import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import type {
  Connection,
  Edge,
  Node,
  NodeMouseHandler,
  NodeProps,
  NodeTypes,
  XYPosition,
} from '@xyflow/react';
import { Plus } from 'lucide-react';
import { nodeTypes } from './CustomNodes';
import { PALETTE_DRAG_MIME } from './SidebarPalette';
import { usePipelineStore } from '../../store/usePipelineStore';
import { useUIStore } from '../../store/useUIStore';
import type { BackendNodeType, CanvasNodeData, UINodeKind } from '../../types/dataiki';

type FlowNode = Node<CanvasNodeData>;

// Mirrors the store port contract for pre-connect feedback; store still rejects onConnect.
const MAX_INPUTS: Record<UINodeKind, number> = {
  datasource: 0,
  recipe: 1,
  split_data: 1,
  joiner: 2,
  python_script: 1,
  ml_studio: 1,
};

const MAX_OUTPUTS: Record<UINodeKind, number> = {
  datasource: 1,
  recipe: 1,
  split_data: 2,
  joiner: 1,
  python_script: 1,
  ml_studio: 0,
};

const BACKEND_NODE_TYPE: Record<UINodeKind, BackendNodeType> = {
  datasource: 'ingestion',
  recipe: 'data_recipe',
  split_data: 'data_recipe',
  joiner: 'join',
  python_script: 'py_transform',
  ml_studio: 'ml_studio',
};

const UI_NODE_KINDS = new Set<UINodeKind>([
  'datasource',
  'recipe',
  'split_data',
  'joiner',
  'python_script',
  'ml_studio',
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
  const addNodeFromPalette = usePipelineStore((state) => state.addNodeFromPalette);
  const setSelectedNodeId = usePipelineStore((state) => state.setSelectedNodeId);
  const fetchNodePreview = usePipelineStore((state) => state.fetchNodePreview);

  const setActiveBottomTab = useUIStore((state) => state.setActiveBottomTab);
  const setActiveConfigNodeId = useUIStore((state) => state.setActiveConfigNodeId);
  const addToast = useUIStore((state) => state.addToast);

  const { screenToFlowPosition } = useReactFlow<FlowNode, Edge>();
  const clickTimer = useRef<number | null>(null);
  const [isPaletteDragging, setIsPaletteDragging] = useState(false);

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
      return (outgoingCount.get(node.id) ?? 0) < (MAX_OUTPUTS[kind] ?? 0);
    });
    if (tips.length === 0) return [];

    const freePorts = tips.reduce((total, node) => {
      const kind = node.data.ui_node_kind;
      return total + (MAX_OUTPUTS[kind] ?? 0) - (outgoingCount.get(node.id) ?? 0);
    }, 0);

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

      const outputCount = edges.filter((edge) => edge.source === connection.source).length;
      const inputCount = edges.filter((edge) => edge.target === connection.target).length;
      if (outputCount >= (MAX_OUTPUTS[sourceKind] ?? 0)) return false;
      if (inputCount >= (MAX_INPUTS[targetKind] ?? 0)) return false;

      const sourceHandleUsed = edges.some(
        (edge) =>
          edge.source === connection.source &&
          edge.sourceHandle === connection.sourceHandle,
      );
      const targetHandleUsed = edges.some(
        (edge) =>
          edge.target === connection.target &&
          edge.targetHandle === connection.targetHandle,
      );
      if (sourceHandleUsed || targetHandleUsed) return false;

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
      className="h-full w-full bg-[var(--bg-canvas)]"
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={canvasNodes}
        edges={edges}
        nodeTypes={CANVAS_NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onPaneClick={handlePaneClick}
        isValidConnection={isValidConnection}
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
