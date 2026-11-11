import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from '@xyflow/react';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import * as api from '../api/client';
import { useUIStore } from './useUIStore';
import type {
  ApiKeyItem,
  BackendNodeType,
  CanvasNodeData,
  ColumnDeepAnalysisResponse,
  ConnectionItem,
  CustomEndpointConfig,
  EdgeConfig,
  JobExecutionLogEntry,
  MLSessionItem,
  NodeConfig,
  PipelineDAG,
  ProductionJobItem,
  ProjectItem,
  PublishedModelItem,
  RecipeStep,
  ScreeningRequest,
  SqlSnippetItem,
  TabularPreviewData,
  TuningRequest,
  UINodeKind,
  VaultSecretItem,
} from '../types/dataiki';
import { encodeProjectKey, parseProjectKey } from '../utils/projectDelimiter';

export type ProcessLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface ProcessLogEntry {
  id: string;
  timestamp: string;
  level: ProcessLogLevel;
  nodeId?: string;
  message: string;
}

export interface PromoteModelPayload {
  project_key?: string;
  tuning_job_id: string;
  trial_number: number;
  activate_immediately?: boolean;
}

export interface CustomEndpointTestOptions {
  projectKey?: string;
  httpMethod: 'GET' | 'POST';
  customPath: string;
  payload?: unknown;
  apiKey?: string;
}

const PROJECT_DATASOURCE_NODE_ID = 'node_source_1';
const PROCESS_LOG_LIMIT = 300;

const BACKEND_NODE_TYPE: Record<UINodeKind, BackendNodeType> = {
  datasource: 'ingestion',
  recipe: 'data_recipe',
  split_data: 'data_recipe',
  joiner: 'join',
  python_script: 'py_transform',
  ml_studio: 'ml_studio',
};

const UI_NODE_KIND: Record<BackendNodeType, UINodeKind> = {
  ingestion: 'datasource',
  join: 'joiner',
  data_recipe: 'recipe',
  py_transform: 'python_script',
  ml_studio: 'ml_studio',
};

const NODE_LABELS: Record<UINodeKind, string> = {
  datasource: 'DataSource',
  recipe: 'Data Recipe',
  split_data: 'Split Data',
  joiner: 'Joiner',
  python_script: 'Python Script',
  ml_studio: 'ML Studio',
};

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

let idSequence = 0;

function makeId(prefix: string): string {
  idSequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${idSequence}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createFlowNode(
  kind: UINodeKind,
  id: string,
  position: { x: number; y: number },
): Node<CanvasNodeData> {
  return {
    id,
    type: kind,
    position,
    data: {
      node_id: id,
      node_type: BACKEND_NODE_TYPE[kind],
      ui_node_kind: kind,
      label: NODE_LABELS[kind],
      params: {},
      recipe_steps: [],
    },
  };
}

function createDataSourceNode(
  position: { x: number; y: number } = { x: 120, y: 160 },
  id: string = PROJECT_DATASOURCE_NODE_ID,
): Node<CanvasNodeData> {
  const node = createFlowNode('datasource', id, position);
  return {
    ...node,
    data: {
      ...node.data,
      params: { source_type: 'file', connection_id: '', query_or_path: '' },
    },
  };
}

function uiKindFromConfig(node: NodeConfig): UINodeKind {
  const declared = node.params?.ui_node_kind;
  if (typeof declared === 'string' && declared in NODE_LABELS) {
    return declared as UINodeKind;
  }
  return UI_NODE_KIND[node.node_type] ?? 'recipe';
}

function flowNodeFromConfig(node: NodeConfig): Node<CanvasNodeData> {
  const kind = uiKindFromConfig(node);
  const rawSteps = node.recipe_steps ?? node.params?.recipe_steps ?? [];
  return {
    id: node.node_id,
    type: kind,
    position: { ...node.position },
    data: {
      node_id: node.node_id,
      node_type: node.node_type,
      ui_node_kind: kind,
      label: node.label || NODE_LABELS[kind],
      params: { ...node.params },
      recipe_steps: api.fromBackendRecipeSteps(rawSteps),
    },
  };
}

function configFromFlowNode(node: Node<CanvasNodeData>): NodeConfig {
  return {
    node_id: node.data.node_id,
    node_type: node.data.node_type,
    label: node.data.label,
    position: { x: node.position.x, y: node.position.y },
    params: { ...node.data.params, ui_node_kind: node.data.ui_node_kind },
    recipe_steps: node.data.recipe_steps ?? [],
  };
}

function dagFromCanvas(
  projectKey: string,
  nodes: Node<CanvasNodeData>[],
  edges: Edge[],
): PipelineDAG {
  return {
    project_key: projectKey,
    nodes: nodes.map(configFromFlowNode),
    edges: edges.map<EdgeConfig>((edge) => ({
      edge_id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
}

function canvasFromDag(dag: PipelineDAG): { nodes: Node<CanvasNodeData>[]; edges: Edge[] } {
  return {
    nodes: dag.nodes.map(flowNodeFromConfig),
    edges: dag.edges.map((edge) => ({
      id: edge.edge_id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    })),
  };
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
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

function modelKey(projectKey: string, modelName: string): string {
  return `${projectKey}::${modelName}`;
}

function findActiveModel(
  models: PublishedModelItem[],
  projectKey: string,
  modelName: string,
): PublishedModelItem | undefined {
  return models.find(
    (model) =>
      model.project_key === projectKey &&
      model.model_name === modelName &&
      model.status === 'active',
  );
}

/**
 * Auto-Active Model Binding: every endpoint/job that references a model name is
 * pointed at the single active version of that name.
 */
function reconcileActiveBindings(
  models: PublishedModelItem[],
  customEndpoints: CustomEndpointConfig[],
  productionJobs: ProductionJobItem[],
): Pick<PipelineState, 'customEndpoints' | 'productionJobs'> {
  const activeByProjectAndName = new Map<string, string>();
  const nameByModelId = new Map<string, string>();

  for (const model of models) {
    nameByModelId.set(model.model_id, model.model_name);
    if (model.status === 'active') {
      activeByProjectAndName.set(modelKey(model.project_key, model.model_name), model.model_id);
    }
  }

  const reboundEndpoints = customEndpoints.map((endpoint) => {
    const modelName = endpoint.model_name ?? nameByModelId.get(endpoint.model_id);
    if (!modelName) return endpoint;
    const activeModelId = activeByProjectAndName.get(
      modelKey(endpoint.project_key, modelName),
    );
    if (!activeModelId) return endpoint;
    if (endpoint.model_id === activeModelId && endpoint.model_name === modelName) return endpoint;
    return { ...endpoint, model_name: modelName, model_id: activeModelId };
  });

  const reboundJobs = productionJobs.map((job) => {
    const modelName = job.model_name ?? nameByModelId.get(job.model_id);
    if (!modelName) return job;
    const activeModelId = activeByProjectAndName.get(modelKey(job.project_key, modelName));
    if (!activeModelId) return job;
    if (job.model_id === activeModelId && job.model_name === modelName) return job;
    return { ...job, model_name: modelName, model_id: activeModelId };
  });

  return { customEndpoints: reboundEndpoints, productionJobs: reboundJobs };
}

interface PipelineState {
  projects: ProjectItem[];
  knownRemoteProjectKeys: string[];
  activeProjectKey: string;

  nodes: Node<CanvasNodeData>[];
  edges: Edge[];
  selectedNodeId: string | null;

  tabularPreview: TabularPreviewData | null;
  isRawPreview: boolean;
  columnAnalysisCache: Record<string, ColumnDeepAnalysisResponse>;
  processLogs: ProcessLogEntry[];

  connections: ConnectionItem[];
  vaultSecrets: VaultSecretItem[];
  sqlSnippets: SqlSnippetItem[];

  mlSessions: MLSessionItem[];
  activeSessionId: string | null;

  publishedModels: PublishedModelItem[];
  customEndpoints: CustomEndpointConfig[];
  productionJobs: ProductionJobItem[];
  jobExecutionLogs: Record<string, JobExecutionLogEntry[]>;
  apiKeys: ApiKeyItem[];

  loadProjects: () => Promise<ProjectItem[]>;
  createProjectWithCategory: (
    category: string,
    name: string,
    description: string,
  ) => Promise<ProjectItem>;
  setActiveProject: (projectKey: string, force?: boolean) => Promise<void>;

  setSelectedNodeId: (nodeId: string | null) => void;
  setIsRawPreview: (isRaw: boolean) => void;
  setActiveSessionId: (sessionId: string | null) => void;

  addProcessLog: (level: ProcessLogLevel, message: string, nodeId?: string) => string;
  clearProcessLogs: () => void;

  onNodesChange: (changes: NodeChange<Node<CanvasNodeData>>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNodeFromPalette: (kind: UINodeKind, position?: { x: number; y: number }) => string;
  updateNodeConfig: (nodeId: string, patch: Partial<CanvasNodeData>) => void;
  deleteNode: (nodeId: string) => Promise<void>;

  fetchNodePreview: (nodeId?: string) => Promise<TabularPreviewData>;
  saveNodeRecipe: (nodeId: string, recipeSteps: RecipeStep[]) => Promise<TabularPreviewData>;
  fetchColumnAnalysis: (
    nodeId: string,
    column: string,
    targetColumn?: string | null,
  ) => Promise<ColumnDeepAnalysisResponse>;

  loadMLSessions: (projectKey?: string) => Promise<MLSessionItem[]>;
  startScreeningJob: (
    request: ScreeningRequest,
  ) => Promise<api.ScreeningStartResponse>;
  resolveHighCardinality: (
    jobId: string,
    action: 'continue' | 'drop_column' | 'stop',
  ) => Promise<{ job_id: string; status: string; action?: string; message?: string }>;
  startTuningJob: (request: TuningRequest) => Promise<api.TuningStartResponse>;

  loadPublishedModels: (projectKey?: string) => Promise<PublishedModelItem[]>;
  promoteModelToProduction: (payload: PromoteModelPayload) => Promise<Record<string, any>>;
  activateModelVersion: (modelId: string) => Promise<void>;
  retrainModel: (modelId: string) => Promise<Record<string, any>>;
  deleteModelVersion: (modelId: string) => Promise<void>;

  loadCustomEndpoints: (projectKey?: string) => Promise<CustomEndpointConfig[]>;
  saveCustomEndpoint: (config: CustomEndpointConfig) => Promise<CustomEndpointConfig>;
  deleteCustomEndpoint: (endpointId: string) => Promise<void>;
  testCustomEndpoint: (options: CustomEndpointTestOptions) => Promise<api.ApiTestResult>;

  loadProductionJobs: (projectKey?: string) => Promise<ProductionJobItem[]>;
  saveProductionJob: (job: ProductionJobItem) => Promise<ProductionJobItem>;
  deleteProductionJob: (jobScriptId: string) => Promise<void>;
  runProductionJobNow: (jobScriptId: string) => Promise<api.JobRunResult>;

  addJobExecutionLog: (entry: JobExecutionLogEntry) => void;
  updateJobExecutionLog: (
    jobScriptId: string,
    logId: string,
    patch: Partial<JobExecutionLogEntry>,
  ) => void;
  clearSchedulerLogsOlderThan: (jobScriptId: string, months: 1 | 3 | 12) => void;
}

export const usePipelineStore = create<PipelineState>()(
  persist(
    (set, get) => ({
      projects: [],
      knownRemoteProjectKeys: [],
      activeProjectKey: '',
      nodes: [],
      edges: [],
      selectedNodeId: null,
      tabularPreview: null,
      isRawPreview: false,
      columnAnalysisCache: {},
      processLogs: [],
      connections: [],
      vaultSecrets: [],
      sqlSnippets: [],
      mlSessions: [],
      activeSessionId: null,
      publishedModels: [],
      customEndpoints: [],
      productionJobs: [],
      jobExecutionLogs: {},
      apiKeys: [],

      loadProjects: async () => {
        try {
          const remoteProjects = await api.fetchProjects();
          set((state) => {
            const remoteKeys = new Set(remoteProjects.map((project) => project.project_key));
            const previouslyKnown = new Set(state.knownRemoteProjectKeys);

            const localOnly = state.projects.filter(
              (project) =>
                !remoteKeys.has(project.project_key) &&
                !previouslyKnown.has(project.project_key),
            );

            return {
              projects: [...remoteProjects, ...localOnly],
              knownRemoteProjectKeys: [...remoteKeys],
            };
          });
          return get().projects;
        } catch (error) {
          get().addProcessLog('ERROR', `Failed to load projects: ${errorMessage(error)}`);
          return get().projects;
        }
      },

      createProjectWithCategory: async (category, name, description) => {
        const projectKey = encodeProjectKey(category, name);
        if (!projectKey) {
          throw new Error('Project name is required.');
        }
        if (get().projects.some((project) => project.project_key === projectKey)) {
          throw new Error(`Project '${projectKey}' already exists.`);
        }

        const parsed = parseProjectKey(projectKey);
        const createdAt = nowIso();
        const project: ProjectItem = {
          project_key: projectKey,
          name: projectKey,
          category: parsed.category,
          display_name: parsed.displayName,
          description,
          created_at: createdAt,
          updated_at: createdAt,
        };
        const sourceNode = createDataSourceNode();
        const dag = dagFromCanvas(projectKey, [sourceNode], []);

        set((state) => ({
          projects: [...state.projects, project],
          activeProjectKey: projectKey,
          nodes: [sourceNode],
          edges: [],
          selectedNodeId: sourceNode.id,
          tabularPreview: null,
          isRawPreview: false,
          columnAnalysisCache: {},
          mlSessions: [],
          activeSessionId: null,
          publishedModels: [],
          customEndpoints: [],
          productionJobs: [],
        }));

        try {
          await api.saveProject({
            project_key: projectKey,
            name: projectKey,
            description,
            dag,
          });
        } catch (error) {
          get().addProcessLog(
            'ERROR',
            `Project '${projectKey}' saved locally but backend sync failed: ${errorMessage(error)}`,
          );
        }

        get().addProcessLog(
          'INFO',
          `Project '${projectKey}' created with initial DataSource node.`,
        );
        return project;
      },

      setActiveProject: async (projectKey, force = false) => {
        const nextKey = projectKey.trim();
        if (!nextKey) {
          set({
            activeProjectKey: '',
            nodes: [],
            edges: [],
            selectedNodeId: null,
            tabularPreview: null,
            columnAnalysisCache: {},
          });
          return;
        }
        if (!force && get().activeProjectKey === nextKey) return;

        set({
          activeProjectKey: nextKey,
          selectedNodeId: null,
          tabularPreview: null,
          isRawPreview: false,
          columnAnalysisCache: {},
          mlSessions: [],
          activeSessionId: null,
          publishedModels: [],
          customEndpoints: [],
          productionJobs: [],
        });

        try {
          const detail = await api.fetchProject(nextKey);
          const loaded =
            detail.dag && detail.dag.nodes.length > 0
              ? canvasFromDag(detail.dag)
              : { nodes: [createDataSourceNode()], edges: [] };

          set((state) => {
            const exists = state.projects.some(
              (project) => project.project_key === detail.project.project_key,
            );
            return {
              projects: exists
                ? state.projects.map((project) =>
                  project.project_key === detail.project.project_key
                    ? detail.project
                    : project,
                )
                : [...state.projects, detail.project],
              nodes: loaded.nodes,
              edges: loaded.edges,
              selectedNodeId: loaded.nodes[0]?.id ?? null,
            };
          });
          get().addProcessLog('INFO', `Project '${nextKey}' loaded.`);
        } catch (error) {
          const sourceNode = createDataSourceNode();
          set({
            nodes: [sourceNode],
            edges: [],
            selectedNodeId: sourceNode.id,
          });
          get().addProcessLog(
            'ERROR',
            `Failed to load project '${nextKey}': ${errorMessage(error)}`,
          );
        }
      },

      setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),
      setIsRawPreview: (isRawPreview) => set({ isRawPreview }),
      setActiveSessionId: (activeSessionId) => set({ activeSessionId }),

      addProcessLog: (level, message, nodeId) => {
        const entry: ProcessLogEntry = {
          id: makeId('plog'),
          timestamp: nowIso(),
          level,
          nodeId,
          message,
        };
        set((state) => ({
          processLogs: [entry, ...state.processLogs].slice(0, PROCESS_LOG_LIMIT),
        }));
        return entry.id;
      },

      clearProcessLogs: () => set({ processLogs: [] }),

      onNodesChange: (changes) => {
        const removedIds = new Set(
          changes.flatMap((change) => (change.type === 'remove' ? [change.id] : [])),
        );
        set((state) => ({
          nodes: applyNodeChanges(changes, state.nodes),
          edges:
            removedIds.size > 0
              ? state.edges.filter(
                (edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target),
              )
              : state.edges,
          selectedNodeId:
            state.selectedNodeId && removedIds.has(state.selectedNodeId)
              ? null
              : state.selectedNodeId,
          tabularPreview:
            state.tabularPreview && removedIds.has(state.tabularPreview.node_id)
              ? null
              : state.tabularPreview,
        }));

        if (removedIds.size > 0) {
          const current = get();
          const activeConfigNodeId = useUIStore.getState().activeConfigNodeId;
          if (activeConfigNodeId && removedIds.has(activeConfigNodeId)) {
            useUIStore.getState().setActiveConfigNodeId(null);
          }
          if (current.activeProjectKey) {
            const dag = dagFromCanvas(current.activeProjectKey, current.nodes, current.edges);
            void api.saveDag(current.activeProjectKey, dag).catch((err) => {
              current.addProcessLog(
                'WARN',
                `Failed to sync pipeline after node removal: ${errorMessage(err)}`,
              );
            });
          }
        }
      },

      onEdgesChange: (changes) => {
        set((state) => ({ edges: applyEdgeChanges(changes, state.edges) }));
      },

      onConnect: (connection) => {
        const state = get();
        if (!connection.source || !connection.target) return;
        if (connection.source === connection.target) {
          state.addProcessLog('WARN', 'Connection rejected: a node cannot connect to itself.');
          return;
        }

        const sourceNode = state.nodes.find((node) => node.id === connection.source);
        const targetNode = state.nodes.find((node) => node.id === connection.target);
        if (!sourceNode || !targetNode) {
          state.addProcessLog('WARN', 'Connection rejected: source or target node is missing.');
          return;
        }

        const sourceKind = sourceNode.data.ui_node_kind;
        const targetKind = targetNode.data.ui_node_kind;

        if ((MAX_OUTPUTS[sourceKind] ?? 1) === 0) {
          state.addProcessLog(
            'WARN',
            `Connection rejected: '${sourceNode.data.label}' has no output port.`,
          );
          return;
        }
        if ((MAX_INPUTS[targetKind] ?? 1) === 0) {
          state.addProcessLog(
            'WARN',
            `Connection rejected: '${targetNode.data.label}' has no input port.`,
          );
          return;
        }

        const outputCount = state.edges.filter((edge) => edge.source === connection.source).length;
        if (outputCount >= (MAX_OUTPUTS[sourceKind] ?? 1)) {
          state.addProcessLog(
            'WARN',
            `Connection rejected: all output ports on '${sourceNode.data.label}' are used.`,
          );
          return;
        }
        const inputCount = state.edges.filter((edge) => edge.target === connection.target).length;
        if (inputCount >= (MAX_INPUTS[targetKind] ?? 1)) {
          state.addProcessLog(
            'WARN',
            `Connection rejected: all input ports on '${targetNode.data.label}' are used.`,
          );
          return;
        }

        const sourceHandleUsed = state.edges.some(
          (edge) =>
            edge.source === connection.source &&
            edge.sourceHandle === connection.sourceHandle,
        );
        if (sourceHandleUsed) {
          state.addProcessLog(
            'WARN',
            `Connection rejected: output port on '${sourceNode.data.label}' is already connected.`,
          );
          return;
        }
        const targetHandleUsed = state.edges.some(
          (edge) =>
            edge.target === connection.target &&
            edge.targetHandle === connection.targetHandle,
        );
        if (targetHandleUsed) {
          state.addProcessLog(
            'WARN',
            `Connection rejected: input port on '${targetNode.data.label}' is already connected.`,
          );
          return;
        }

        if (createsCycle(state.edges, connection.source, connection.target)) {
          state.addProcessLog(
            'WARN',
            'Connection rejected: cyclic pipelines are not allowed.',
          );
          return;
        }

        const edge: Edge = {
          id: makeId('edge'),
          source: connection.source,
          target: connection.target,
          sourceHandle: connection.sourceHandle ?? null,
          targetHandle: connection.targetHandle ?? null,
        };
        set((current) => ({ edges: addEdge(edge, current.edges) }));
      },

      addNodeFromPalette: (kind, position) => {
        const state = get();
        const index = state.nodes.length;
        const fallbackPosition = position ?? {
          x: 320 + (index % 4) * 220,
          y: 120 + Math.floor(index / 4) * 160,
        };
        const node =
          kind === 'datasource'
            ? createDataSourceNode(fallbackPosition, makeId('node_datasource'))
            : createFlowNode(kind, makeId(`node_${kind}`), fallbackPosition);
        set({ nodes: [...state.nodes, node], selectedNodeId: node.id });
        state.addProcessLog('INFO', `Node '${NODE_LABELS[kind]}' added to canvas.`, node.id);
        return node.id;
      },

      updateNodeConfig: (nodeId, patch) => {
        set((state) => ({
          nodes: state.nodes.map((node) =>
            node.id === nodeId
              ? {
                ...node,
                type: patch.ui_node_kind ?? node.type,
                data: { ...node.data, ...patch },
              }
              : node,
          ),
        }));
      },

      deleteNode: async (nodeId) => {
        const state = get();
        const targetNode = state.nodes.find((item) => item.id === nodeId);
        if (!targetNode) return;

        const nextNodes = state.nodes.filter((node) => node.id !== nodeId);
        const nextEdges = state.edges.filter(
          (edge) => edge.source !== nodeId && edge.target !== nodeId,
        );
        const nextSelected = state.selectedNodeId === nodeId ? null : state.selectedNodeId;
        const nextPreview =
          state.tabularPreview?.node_id === nodeId ? null : state.tabularPreview;

        set({
          nodes: nextNodes,
          edges: nextEdges,
          selectedNodeId: nextSelected,
          tabularPreview: nextPreview,
        });

        if (useUIStore.getState().activeConfigNodeId === nodeId) {
          useUIStore.getState().setActiveConfigNodeId(null);
        }

        const label = targetNode.data.label || targetNode.id;
        state.addProcessLog('INFO', `Node '${label}' deleted.`, nodeId);

        if (state.activeProjectKey) {
          const dag = dagFromCanvas(state.activeProjectKey, nextNodes, nextEdges);
          try {
            await api.saveDag(state.activeProjectKey, dag);
          } catch (error) {
            state.addProcessLog(
              'WARN',
              `Failed to sync pipeline after deleting '${label}': ${errorMessage(error)}`,
            );
          }
        }
      },

      fetchNodePreview: async (nodeId) => {
        const state = get();
        const targetNodeId = nodeId ?? state.selectedNodeId;
        if (!state.activeProjectKey) throw new Error('No active project selected.');
        if (!targetNodeId) throw new Error('No node selected for preview.');

        const node = state.nodes.find((item) => item.id === targetNodeId);
        try {
          const preview = await api.fetchNodePreview(state.activeProjectKey, targetNodeId, {
            viewRaw: state.isRawPreview,
            recipeSteps: node?.data.recipe_steps ?? [],
          });
          set({ tabularPreview: preview, selectedNodeId: targetNodeId });
          get().addProcessLog(
            'INFO',
            `Preview loaded for '${node?.data.label ?? targetNodeId}' (${preview.row_count} rows).`,
            targetNodeId,
          );
          return preview;
        } catch (error) {
          get().addProcessLog(
            'ERROR',
            `Preview failed for '${targetNodeId}': ${errorMessage(error)}`,
            targetNodeId,
          );
          throw error;
        }
      },

      saveNodeRecipe: async (nodeId, recipeSteps) => {
        const state = get();
        if (!state.activeProjectKey) throw new Error('No active project selected.');
        const node = state.nodes.find((item) => item.id === nodeId);
        if (!node) throw new Error(`Node '${nodeId}' not found.`);

        // Persist form edits locally first so a backend failure never loses the recipe.
        set((current) => ({
          nodes: current.nodes.map((item) =>
            item.id === nodeId
              ? { ...item, data: { ...item.data, recipe_steps: recipeSteps } }
              : item,
          ),
        }));

        try {
          const preview = await api.saveNodeRecipe(
            state.activeProjectKey,
            nodeId,
            recipeSteps,
          );
          set({ tabularPreview: preview, selectedNodeId: nodeId });
          get().addProcessLog(
            'INFO',
            `Recipe saved for '${node.data.label}' (${recipeSteps.length} steps).`,
            nodeId,
          );
          return preview;
        } catch (error) {
          get().addProcessLog(
            'ERROR',
            `Recipe save failed for '${node.data.label}': ${errorMessage(error)}`,
            nodeId,
          );
          throw error;
        }
      },

      fetchColumnAnalysis: async (nodeId, column, targetColumn) => {
        const state = get();
        if (!state.activeProjectKey) throw new Error('No active project selected.');
        try {
          const analysis = await api.fetchColumnAnalysis(
            state.activeProjectKey,
            nodeId,
            column,
            targetColumn,
          );
          const cacheKey = `${nodeId}::${column}::${targetColumn ?? ''}`;
          set((current) => ({
            columnAnalysisCache: { ...current.columnAnalysisCache, [cacheKey]: analysis },
          }));
          return analysis;
        } catch (error) {
          get().addProcessLog(
            'ERROR',
            `Column analysis failed for '${column}': ${errorMessage(error)}`,
            nodeId,
          );
          throw error;
        }
      },

      loadMLSessions: async (projectKey) => {
        const key = projectKey ?? get().activeProjectKey;
        if (!key) return [];
        try {
          const sessions = await api.fetchMLSessions(key);
          set((state) => ({
            mlSessions: sessions,
            activeSessionId:
              state.activeSessionId &&
                sessions.some((session) => session.session_id === state.activeSessionId)
                ? state.activeSessionId
                : (sessions[0]?.session_id ?? null),
          }));
          return sessions;
        } catch (error) {
          get().addProcessLog('ERROR', `Failed to load ML sessions: ${errorMessage(error)}`);
          throw error;
        }
      },

      startScreeningJob: async (request) => {
        try {
          const response = await api.startScreening(request);
          get().addProcessLog(
            'INFO',
            `Screening job '${response.job_id}' started for session '${request.session_name}'.`,
          );
          if ((response.high_cardinality_columns?.length ?? 0) > 0) {
            get().addProcessLog(
              'WARN',
              `High cardinality detected in ${response.high_cardinality_columns?.length ?? 0} column(s).`,
            );
          }
          return response;
        } catch (error) {
          get().addProcessLog('ERROR', `Screening start failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      resolveHighCardinality: async (jobId, action) => {
        try {
          const response = await api.resolveHighCardinality(jobId, action);
          get().addProcessLog('INFO', `High cardinality resolved with action '${action}'.`);
          return response;
        } catch (error) {
          get().addProcessLog(
            'ERROR',
            `High cardinality resolution failed: ${errorMessage(error)}`,
          );
          throw error;
        }
      },

      startTuningJob: async (request) => {
        try {
          const response = await api.startTuning(request);
          get().addProcessLog(
            'INFO',
            `Tuning job '${response.job_id}' started for '${request.algorithm}' (${request.n_trials} trials).`,
          );
          return response;
        } catch (error) {
          get().addProcessLog('ERROR', `Tuning start failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      loadPublishedModels: async (projectKey) => {
        const key = projectKey ?? get().activeProjectKey;
        if (!key) return [];
        try {
          const models = await api.fetchPublishedModels(key);
          set((state) => ({
            publishedModels: models,
            ...reconcileActiveBindings(models, state.customEndpoints, state.productionJobs),
          }));
          return models;
        } catch (error) {
          get().addProcessLog('ERROR', `Failed to load model registry: ${errorMessage(error)}`);
          throw error;
        }
      },

      promoteModelToProduction: async (payload) => {
        const key = payload.project_key ?? get().activeProjectKey;
        if (!key) throw new Error('No active project selected.');
        try {
          const result = await api.promoteModel({ ...payload, project_key: key });
          const models = await api.fetchPublishedModels(key);
          set((state) => ({
            publishedModels: models,
            ...reconcileActiveBindings(models, state.customEndpoints, state.productionJobs),
          }));
          get().addProcessLog('INFO', `Model promoted to production for '${key}'.`);
          return result;
        } catch (error) {
          get().addProcessLog('ERROR', `Model promotion failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      activateModelVersion: async (modelId) => {
        const state = get();
        const target = state.publishedModels.find((model) => model.model_id === modelId);
        if (!target) throw new Error(`Model '${modelId}' not found in the registry.`);

        const parsed = api.parseModelId(modelId);
        if (!parsed) return;

        const previousModels = state.publishedModels;
        const previousEndpoints = state.customEndpoints;
        const previousJobs = state.productionJobs;

        const nextModels = state.publishedModels.map((model) => {
          if (model.model_id === modelId) return { ...model, status: 'active' as const };
          if (
            model.project_key === target.project_key &&
            model.model_name === target.model_name &&
            model.status === 'active'
          ) {
            return { ...model, status: 'archived' as const };
          }
          return model;
        });
        set((current) => ({
          publishedModels: nextModels,
          ...reconcileActiveBindings(
            nextModels,
            current.customEndpoints,
            current.productionJobs,
          ),
        }));

        try {
          await api.changeModelStatus(parsed.projectKey, parsed.version, 'activate');
        } catch (error) {
          get().addProcessLog(
            'ERROR',
            `Backend activation failed for '${target.model_name}' v${target.version}: ${errorMessage(error)}`,
          );
          set({
            publishedModels: previousModels,
            ...reconcileActiveBindings(previousModels, previousEndpoints, previousJobs),
          });
          get().addProcessLog('WARN', 'Model activation rolled back; UI state restored.');
          throw error;
        }

        get().addProcessLog(
          'INFO',
          `Activated '${target.model_name}' v${target.version}; API and job bindings updated.`,
        );
      },

      retrainModel: async (modelId) => {
        const parsed = api.parseModelId(modelId);
        if (!parsed) throw new Error(`Invalid model id '${modelId}'.`);
        try {
          const result = await api.retrainModel(parsed.projectKey, parsed.version);
          const models = await api.fetchPublishedModels(parsed.projectKey);
          set((state) => ({
            publishedModels: models,
            ...reconcileActiveBindings(models, state.customEndpoints, state.productionJobs),
          }));
          get().addProcessLog(
            'INFO',
            `Retrain started from v${parsed.version}; new version is staged for review.`,
          );
          return result;
        } catch (error) {
          get().addProcessLog('ERROR', `Retrain failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      deleteModelVersion: async (modelId) => {
        const parsed = api.parseModelId(modelId);
        if (!parsed) throw new Error(`Invalid model id '${modelId}'.`);
        const target = get().publishedModels.find((model) => model.model_id === modelId);
        if (target?.status === 'active') {
          throw new Error(
            'Cannot delete the active model version. Activate another version first.',
          );
        }
        try {
          await api.changeModelStatus(parsed.projectKey, parsed.version, 'delete');
          set((state) => ({
            publishedModels: state.publishedModels.filter((model) => model.model_id !== modelId),
          }));
          get().addProcessLog('INFO', `Deleted model version '${modelId}'.`);
        } catch (error) {
          get().addProcessLog('ERROR', `Delete model failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      loadCustomEndpoints: async (projectKey) => {
        const key = projectKey ?? get().activeProjectKey;
        if (!key) return [];
        try {
          const endpoints = await api.fetchCustomEndpoints(key);
          set((state) => ({
            ...reconcileActiveBindings(
              state.publishedModels,
              endpoints,
              state.productionJobs,
            ),
          }));
          return endpoints;
        } catch (error) {
          get().addProcessLog('ERROR', `Failed to load custom endpoints: ${errorMessage(error)}`);
          throw error;
        }
      },

      saveCustomEndpoint: async (config) => {
        const state = get();
        const projectKey = config.project_key || state.activeProjectKey;
        if (!projectKey) throw new Error('No active project selected.');
        if (!config.custom_path.trim()) throw new Error('Custom path is required.');

        const modelName = config.model_name?.trim();
        let modelId = config.model_id;
        if (modelName) {
          const activeModel = findActiveModel(state.publishedModels, projectKey, modelName);
          if (!activeModel) {
            throw new Error(`No active model named '${modelName}'. Activate a version first.`);
          }
          modelId = activeModel.model_id;
        }
        if (!modelId) {
          throw new Error('Select a model name before saving the endpoint.');
        }

        const resolvedName =
          modelName ??
          state.publishedModels.find((model) => model.model_id === modelId)?.model_name;

        try {
          const response = await api.saveCustomEndpoint({
            ...config,
            project_key: projectKey,
            model_id: modelId,
            model_name: resolvedName,
          });
          const endpointId = String(
            response?.endpoint_id ?? config.endpoint_id ?? makeId('endpoint'),
          );
          const saved: CustomEndpointConfig = {
            ...config,
            endpoint_id: endpointId,
            project_key: projectKey,
            model_id: modelId,
            model_name: resolvedName,
          };
          set((current) => ({
            customEndpoints: [
              saved,
              ...current.customEndpoints.filter(
                (endpoint) => endpoint.endpoint_id !== endpointId,
              ),
            ],
          }));
          get().addProcessLog('INFO', `Endpoint '${saved.custom_path}' saved.`);
          return saved;
        } catch (error) {
          get().addProcessLog('ERROR', `Endpoint save failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      deleteCustomEndpoint: async (endpointId) => {
        if (!endpointId) throw new Error('Endpoint id is required.');
        try {
          await api.deleteCustomEndpoint(endpointId);
          set((state) => ({
            customEndpoints: state.customEndpoints.filter(
              (endpoint) => endpoint.endpoint_id !== endpointId,
            ),
          }));
          get().addProcessLog('INFO', `Endpoint '${endpointId}' deleted.`);
        } catch (error) {
          get().addProcessLog('ERROR', `Endpoint delete failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      testCustomEndpoint: async (options) => {
        const projectKey = options.projectKey ?? get().activeProjectKey;
        if (!projectKey) throw new Error('No active project selected.');
        if (!options.customPath.trim()) throw new Error('Custom path is required.');
        try {
          const result = await api.testCustomEndpoint({ ...options, projectKey });
          get().addProcessLog(
            result.ok ? 'INFO' : 'WARN',
            `Test request ${result.status} ${result.statusText} in ${result.duration_ms}ms.`,
          );
          return result;
        } catch (error) {
          get().addProcessLog('ERROR', `Test request failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      loadProductionJobs: async (projectKey) => {
        const key = projectKey ?? get().activeProjectKey;
        if (!key) return [];
        try {
          const jobs = await api.fetchProductionJobs(key);
          set((state) => ({
            ...reconcileActiveBindings(state.publishedModels, state.customEndpoints, jobs),
          }));
          return jobs;
        } catch (error) {
          get().addProcessLog('ERROR', `Failed to load production jobs: ${errorMessage(error)}`);
          throw error;
        }
      },

      saveProductionJob: async (job) => {
        const state = get();
        const projectKey = job.project_key || state.activeProjectKey;
        if (!projectKey) throw new Error('No active project selected.');
        if (!job.job_name.trim()) throw new Error('Job name is required.');

        const modelName =
          job.model_name?.trim() ||
          state.publishedModels.find((model) => model.model_id === job.model_id)?.model_name;
        let modelId = job.model_id;
        if (modelName) {
          const activeModel = findActiveModel(state.publishedModels, projectKey, modelName);
          if (!activeModel) {
            throw new Error(`No active model named '${modelName}'. Activate a version first.`);
          }
          modelId = activeModel.model_id;
        }
        if (!modelId) {
          throw new Error('Select a model name before saving the job.');
        }

        try {
          const saved = await api.saveProductionJob({
            ...job,
            project_key: projectKey,
            model_id: modelId,
            model_name: modelName,
          });
          const jobScriptId = saved.job_script_id ?? job.job_script_id ?? makeId('job');
          const nextJob: ProductionJobItem = {
            ...saved,
            job_script_id: jobScriptId,
            project_key: projectKey,
            model_id: modelId,
            model_name: modelName,
          };
          set((current) => ({
            productionJobs: [
              nextJob,
              ...current.productionJobs.filter(
                (item) => item.job_script_id !== jobScriptId,
              ),
            ],
          }));
          get().addProcessLog('INFO', `Job '${nextJob.job_name}' saved.`);
          return nextJob;
        } catch (error) {
          get().addProcessLog('ERROR', `Job save failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      deleteProductionJob: async (jobScriptId) => {
        if (!jobScriptId) throw new Error('Job id is required.');
        try {
          await api.deleteProductionJob(jobScriptId);
          set((state) => {
            const nextLogs = { ...state.jobExecutionLogs };
            delete nextLogs[jobScriptId];
            return {
              productionJobs: state.productionJobs.filter(
                (job) => job.job_script_id !== jobScriptId,
              ),
              jobExecutionLogs: nextLogs,
            };
          });
          get().addProcessLog('INFO', `Job '${jobScriptId}' deleted.`);
        } catch (error) {
          get().addProcessLog('ERROR', `Job delete failed: ${errorMessage(error)}`);
          throw error;
        }
      },

      runProductionJobNow: async (jobScriptId) => {
        if (!jobScriptId) throw new Error('Job id is required.');
        const job = get().productionJobs.find((item) => item.job_script_id === jobScriptId);
        const scheduleName = job?.job_name ?? jobScriptId;
        const startedAt = nowIso();
        const logId = makeId('jlog');

        get().addJobExecutionLog({
          log_id: logId,
          job_script_id: jobScriptId,
          schedule_name: scheduleName,
          status: 'running',
          started_at: startedAt,
          stdout_text: '',
        });
        set((state) => ({
          productionJobs: state.productionJobs.map((item) =>
            item.job_script_id === jobScriptId
              ? { ...item, last_status: 'running', last_run_at: startedAt }
              : item,
          ),
        }));

        try {
          const result = await api.runProductionJobNow(jobScriptId);
          const stdout = [
            `Rows processed: ${result.rows_processed}`,
            `Sink: ${result.sink_destination}`,
            `Executed at: ${result.executed_at}`,
          ].join('\n');
          get().updateJobExecutionLog(jobScriptId, logId, {
            status: 'success',
            finished_at: nowIso(),
            stdout_text: stdout,
          });
          set((state) => ({
            productionJobs: state.productionJobs.map((item) =>
              item.job_script_id === jobScriptId
                ? {
                  ...item,
                  last_status: 'completed',
                  last_error: '',
                  last_run_at: result.executed_at,
                }
                : item,
            ),
          }));
          get().addProcessLog('INFO', `Job '${scheduleName}' completed successfully.`);
          return result;
        } catch (error) {
          const detail = errorMessage(error);
          get().updateJobExecutionLog(jobScriptId, logId, {
            status: 'error',
            finished_at: nowIso(),
            error_detail: detail,
          });
          set((state) => ({
            productionJobs: state.productionJobs.map((item) =>
              item.job_script_id === jobScriptId
                ? { ...item, last_status: 'failed', last_error: detail }
                : item,
            ),
          }));
          get().addProcessLog('ERROR', `Job '${scheduleName}' failed: ${detail}`);
          throw error;
        }
      },

      addJobExecutionLog: (entry) => {
        set((state) => {
          const currentLogs = state.jobExecutionLogs[entry.job_script_id] ?? [];
          const existingIndex = currentLogs.findIndex((log) => log.log_id === entry.log_id);
          const nextLogs =
            existingIndex >= 0
              ? currentLogs.map((log) => (log.log_id === entry.log_id ? entry : log))
              : [entry, ...currentLogs];
          return {
            jobExecutionLogs: {
              ...state.jobExecutionLogs,
              [entry.job_script_id]: nextLogs,
            },
          };
        });
      },

      updateJobExecutionLog: (jobScriptId, logId, patch) => {
        set((state) => {
          const currentLogs = state.jobExecutionLogs[jobScriptId];
          if (!currentLogs) return {};
          return {
            jobExecutionLogs: {
              ...state.jobExecutionLogs,
              [jobScriptId]: currentLogs.map((log) =>
                log.log_id === logId ? { ...log, ...patch } : log,
              ),
            },
          };
        });
      },

      clearSchedulerLogsOlderThan: (jobScriptId, months) => {
        if (!jobScriptId) return;
        const cutoffDays = months === 12 ? 365 : months * 30;
        const cutoff = Date.now() - cutoffDays * 24 * 60 * 60 * 1000;

        // shortcut: no log-purge endpoint exists in client.ts; clear local history only.
        set((state) => {
          const currentLogs = state.jobExecutionLogs[jobScriptId];
          if (!currentLogs) return {};
          return {
            jobExecutionLogs: {
              ...state.jobExecutionLogs,
              [jobScriptId]: currentLogs.filter((log) => {
                const started = new Date(log.started_at).getTime();
                return !Number.isFinite(started) || started >= cutoff;
              }),
            },
          };
        });

        get().addProcessLog(
          'INFO',
          `Cleared logs older than ${months === 12 ? '1 year' : `${months} month(s)`} for job '${jobScriptId}'.`,
        );
      },
    }),
    {
      name: 'dataiki-pipeline-store',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        projects: state.projects,
        knownRemoteProjectKeys: state.knownRemoteProjectKeys,
        activeProjectKey: state.activeProjectKey,
        nodes: state.nodes,
        edges: state.edges,
        connections: state.connections,
        vaultSecrets: state.vaultSecrets,
        sqlSnippets: state.sqlSnippets,
        mlSessions: state.mlSessions,
        activeSessionId: state.activeSessionId,
        publishedModels: state.publishedModels,
        customEndpoints: state.customEndpoints,
        productionJobs: state.productionJobs,
        jobExecutionLogs: state.jobExecutionLogs,
        apiKeys: state.apiKeys,
      }),
      merge: (persistedState, currentState) => {
        const persisted = (persistedState ?? {}) as Partial<PipelineState>;
        return {
          ...currentState,
          ...persisted,
          nodes: (persisted.nodes ?? currentState.nodes).map((node) => ({
            ...node,
            selected: false,
            dragging: false,
          })),
          edges: persisted.edges ?? currentState.edges,
        } as PipelineState;
      },
    },
  ),
);
