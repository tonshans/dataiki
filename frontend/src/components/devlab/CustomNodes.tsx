import {
  AlertTriangle,
  BrainCircuit,
  Combine,
  Database,
  GitFork,
  Layers,
  Loader2,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Handle, Position } from '@xyflow/react';
import type { Node, NodeProps, NodeTypes } from '@xyflow/react';
import type { CanvasNodeData, UINodeKind } from '../../types/dataiki';

type DataikiFlowNode = Node<CanvasNodeData, UINodeKind>;

const NODE_ICON: Record<UINodeKind, LucideIcon> = {
  datasource: Database,
  recipe: Layers,
  split_data: GitFork,
  joiner: Combine,
  python_script: Terminal,
  ml_studio: BrainCircuit,
};

const NODE_LABEL: Record<UINodeKind, string> = {
  datasource: 'DataSource',
  recipe: 'Data Recipe',
  split_data: 'Split Data',
  joiner: 'Joiner',
  python_script: 'Python Script',
  ml_studio: 'ML Studio',
};

function asText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shorten(value: string, maxLength = 72): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function describeNode(data: CanvasNodeData): string {
  const params = data.params ?? {};

  switch (data.ui_node_kind) {
    case 'datasource': {
      const sourceType = asText(params.source_type) || 'file';
      const target =
        asText(params.query_or_path) ||
        asText(params.sql_query) ||
        asText(params.file_path) ||
        asText(params.api_url);
      return target ? `${sourceType} · ${shorten(target)}` : `${sourceType} source, not configured`;
    }
    case 'recipe': {
      const steps = data.recipe_steps ?? [];
      if (steps.length === 0) return 'No recipe steps configured';
      const actions = steps.slice(0, 3).map((step) => step.action);
      const suffix = steps.length > actions.length ? ', …' : '';
      return `${steps.length} step${steps.length === 1 ? '' : 's'} · ${actions.join(', ')}${suffix}`;
    }
    case 'split_data': {
      const pathA = Array.isArray(params.path_a_columns) ? params.path_a_columns.length : 0;
      return pathA > 0
        ? `Path A: ${pathA} column${pathA === 1 ? '' : 's'} · Path B: complement`
        : 'Choose columns for Path A';
    }
    case 'joiner': {
      const joinType = asText(params.join_type) || 'INNER';
      const leftOn = asText(params.left_on);
      const rightOn = asText(params.right_on);
      return leftOn && rightOn
        ? `${joinType} · ${leftOn} = ${rightOn}`
        : `${joinType} join, keys not configured`;
    }
    case 'python_script': {
      const code =
        asText(params.python_code) || asText(params.code) || asText(params.script);
      if (!code) return 'Custom transform, script not written';
      const lines = code.split('\n').length;
      return `Custom transform · ${lines} line${lines === 1 ? '' : 's'}`;
    }
    case 'ml_studio': {
      const predictionType =
        asText(params.prediction_type) || asText(params.task_type) || 'not configured';
      const target = asText(params.target_column);
      return target
        ? `${predictionType} · target: ${target}`
        : `${predictionType}, target not selected`;
    }
    default:
      return 'Pipeline node';
  }
}

export function CustomNode({
  data,
  isConnectable = true,
  selected,
}: NodeProps<DataikiFlowNode>) {
  const kind = data.ui_node_kind;
  const Icon = NODE_ICON[kind] ?? Layers;
  const label = data.label || NODE_LABEL[kind] || 'Node';
  const summary = describeNode(data);
  const hasError = Boolean(data.error_message);
  const isLoading = Boolean(data.is_loading);

  return (
    <div
      role="group"
      aria-label={`${label}: ${summary}`}
      data-node-kind={kind}
      className={`group relative flex h-16 w-16 items-center justify-center rounded-[var(--border-radius)] ${
        hasError
          ? 'hazard-stripes-danger p-1'
          : 'border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] shadow-[var(--shadow-card)]'
      } ${selected ? 'outline outline-2 outline-offset-2 outline-[var(--accent-primary)]' : ''}`}
    >
      <div
        className={`flex h-full w-full items-center justify-center rounded-[var(--border-radius)] ${
          hasError
            ? 'bg-[var(--bg-card)] text-[var(--accent-danger)]'
            : 'text-[var(--accent-primary)]'
        }`}
      >
        <Icon size={28} strokeWidth={1.8} />
      </div>

      {hasError ? (
        <span
          className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--accent-danger)] text-[var(--bg-card)] rounded-[var(--border-radius)]"
          title={data.error_message}
        >
          <AlertTriangle size={11} />
        </span>
      ) : (
        isLoading && (
          <span className="absolute -right-2 -top-2 flex h-5 w-5 items-center justify-center border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] text-[var(--accent-warning)] rounded-[var(--border-radius)]">
            <Loader2 size={12} className="animate-spin" />
          </span>
        )
      )}

      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 w-max max-w-[240px] -translate-x-1/2 border-[length:var(--border-width)] border-[var(--border-color)] bg-[var(--bg-card)] px-2 py-1.5 text-left opacity-0 shadow-[var(--shadow-card)] rounded-[var(--border-radius)] transition-opacity group-hover:opacity-100"
      >
        <p className="text-xs font-bold text-[var(--text-main)]">{label}</p>
        <p className="mt-0.5 break-words text-[10px] leading-tight text-[var(--text-muted)]">
          {summary}
        </p>
        {hasError && (
          <p className="mt-1 break-words text-[10px] leading-tight text-[var(--accent-danger)]">
            {shorten(data.error_message ?? '', 120)}
          </p>
        )}
      </div>

      {kind === 'joiner' ? (
        <>
          <Handle
            type="target"
            position={Position.Left}
            id="input_left"
            isConnectable={isConnectable}
            style={{ top: '32%' }}
            title="Joiner left input"
          />
          <Handle
            type="target"
            position={Position.Left}
            id="input_right"
            isConnectable={isConnectable}
            style={{ top: '68%' }}
            title="Joiner right input"
          />
        </>
      ) : (
        kind !== 'datasource' && (
          <Handle
            type="target"
            position={Position.Left}
            id="input"
            isConnectable={isConnectable}
            title={`${label} input`}
          />
        )
      )}

      {kind === 'split_data' ? (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="output_a"
            isConnectable={isConnectable}
            style={{ top: '32%' }}
            title="Path A output"
          />
          <Handle
            type="source"
            position={Position.Right}
            id="output_b"
            isConnectable={isConnectable}
            style={{ top: '68%' }}
            title="Path B output"
          />
        </>
      ) : (
        kind !== 'ml_studio' && (
          <Handle
            type="source"
            position={Position.Right}
            id="output"
            isConnectable={isConnectable}
            title={`${label} output`}
          />
        )
      )}
    </div>
  );
}

export const nodeTypes: NodeTypes = {
  datasource: CustomNode,
  recipe: CustomNode,
  split_data: CustomNode,
  joiner: CustomNode,
  python_script: CustomNode,
  ml_studio: CustomNode,
};
