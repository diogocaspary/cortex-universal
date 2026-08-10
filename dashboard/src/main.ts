import { Graph, NodeEvent, type EdgeData, type IElementEvent, type LayoutOptions } from '@antv/g6';
import type { ForceGraph3DInstance, LinkObject, NodeObject } from '3d-force-graph';

type NodeKind =
  | 'action'
  | 'capability'
  | 'class'
  | 'classification'
  | 'concept'
  | 'datatype-property'
  | 'effect'
  | 'external'
  | 'object-property'
  | 'obligation'
  | 'ontology'
  | 'permission'
  | 'policy-bundle'
  | 'policy-rule'
  | 'precondition'
  | 'role'
  | 'shape'
  | 'agent'
  | 'goal'
  | 'work-item'
  | 'routine'
  | 'heartbeat'
  | 'evaluation';

interface CortexGraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  module: string;
  description: string | null;
  degree: number;
}

interface CortexGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  predicate: string;
  kind: 'rdf' | 'policy';
}

interface CortexGraphSnapshot {
  version: string;
  nodes: CortexGraphNode[];
  edges: CortexGraphEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    module_count: number;
    modules: string[];
    by_kind: Record<string, number>;
  };
}

interface BrainActivity {
  sequence: number;
  occurred_at: string;
  tenant_id: string;
  brain_id: string;
  kind:
    | 'ingestion'
    | 'retrieval'
    | 'agent_session'
    | 'agent_handoff'
    | 'guard'
    | 'effect'
    | 'mcp'
    | 'workforce'
    | 'authorization'
    | 'failure';
  status: 'accepted' | 'completed' | 'rejected' | 'proposed';
  subject_id: string;
  summary: string;
  request_id: string;
  trace_id: string;
  correlation_id: string;
  causation_id: string | null;
  operation: string;
  event_hash: string;
}

interface ReasoningReport {
  profile: string;
  complete_owl_reasoner: false;
  explicit_triples: number;
  inferred_triples: number;
  iterations: number;
  truncated: boolean;
  consistent: boolean;
  diagnostics: Array<{ severity: 'warning' | 'violation'; code: string; message: string }>;
}

interface SanitizedFailure {
  failure_id: string;
  occurred_at: string;
  operation: string;
  status_code: number;
  error_code: string;
  error_fingerprint: string;
  request_id: string;
  trace_id: string;
  correlation_id: string;
}

interface WorkforceRecordBase {
  id: string;
  record_type: 'goal' | 'work_item' | 'routine' | 'heartbeat' | 'evaluation';
  classification: string;
}

interface WorkforceGoal extends WorkforceRecordBase {
  record_type: 'goal';
  title: string;
  description: string;
  parent_goal_id: string | null;
  owner_agent_id: string;
  status: string;
}

interface WorkforceItem extends WorkforceRecordBase {
  record_type: 'work_item';
  title: string;
  description: string;
  goal_id: string;
  parent_work_item_id: string | null;
  assigned_agent_id: string;
  blocked_by: string[];
  status: string;
}

interface WorkforceRoutine extends WorkforceRecordBase {
  record_type: 'routine';
  name: string;
  goal_id: string;
  assigned_agent_id: string;
  status: string;
}

interface WorkforceEvaluation extends WorkforceRecordBase {
  record_type: 'evaluation';
  agent_id: string;
  work_item_id: string;
  evaluator_id: string;
}

interface WorkforceHeartbeat extends WorkforceRecordBase {
  record_type: 'heartbeat';
  agent_id: string;
  status: string;
  current_work_item_id: string | null;
  observed_at: string;
}

interface WorkforceSnapshot {
  tenant_id: string;
  brain_id: string;
  goals: WorkforceGoal[];
  work_items: WorkforceItem[];
  routines: WorkforceRoutine[];
  heartbeats: WorkforceHeartbeat[];
  evaluations: WorkforceEvaluation[];
  costs: { total_tokens: number; cost_microusd: number; event_count: number };
}

interface AgentRegistryView {
  agents: Array<{
    id: string;
    name: string;
    role: string;
    department: string;
    reports_to: string | null;
  }>;
}

const colors: Record<string, string> = {
  action: '#ff8a4c',
  capability: '#f7c948',
  class: '#58d7ff',
  concept: '#6ee7b7',
  'datatype-property': '#a78bfa',
  external: '#64748b',
  'object-property': '#8b9cff',
  ontology: '#f472b6',
  'policy-rule': '#fb7185',
  shape: '#2dd4bf',
  agent: '#f7c948',
  goal: '#f472b6',
  'work-item': '#58d7ff',
  routine: '#a78bfa',
  evaluation: '#6ee7b7',
  heartbeat: '#fb7185',
};

const cognitiveModules = new Set([
  'attention',
  'cognition',
  'learning',
  'memory',
  'metacognition',
  'retrieval',
  'world-model',
]);

interface Cortex3DNode extends NodeObject {
  id: string;
  label: string;
  kind: NodeKind;
  module: string;
  degree: number;
}

interface Cortex3DLink extends LinkObject<Cortex3DNode> {
  id: string;
  source: string | Cortex3DNode;
  target: string | Cortex3DNode;
  label: string;
}

function nodeColor(datum: Record<string, unknown>): string {
  if (cognitiveModules.has(String(datum.module))) return '#2dd4bf';
  return colors[String(datum.kind)] ?? '#64748b';
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>(`#${id}`);
  if (!value) throw new Error(`Dashboard element '${id}' was not found.`);
  return value;
}

const authDialog = element<HTMLDialogElement>('auth-dialog');
const authError = element<HTMLParagraphElement>('auth-error');
const apiTokenInput = element<HTMLInputElement>('api-token');
const environmentFile = element<HTMLInputElement>('environment-file');
const connectionStatus = element<HTMLSpanElement>('connection-status');
const emptyState = element<HTMLDivElement>('empty-state');
const loading = element<HTMLDivElement>('loading');
const searchInput = element<HTMLInputElement>('search');
const moduleFilter = element<HTMLSelectElement>('module-filter');
const kindFilter = element<HTMLSelectElement>('kind-filter');
const layoutSelect = element<HTMLSelectElement>('layout-select');
const visualMode = element<HTMLSelectElement>('visual-mode');
const showLabels = element<HTMLInputElement>('show-labels');
const fitViewButton = element<HTMLButtonElement>('fit-view');
const exportButton = element<HTMLButtonElement>('export-graph');
const detailTitle = element<HTMLHeadingElement>('detail-title');
const detailContent = element<HTMLDivElement>('detail-content');
const activityTenant = element<HTMLInputElement>('activity-tenant');
const activityBrain = element<HTMLInputElement>('activity-brain');
const loadActivityButton = element<HTMLButtonElement>('load-activity');
const activityStatus = element<HTMLParagraphElement>('activity-status');
const activityList = element<HTMLDivElement>('activity-list');
const reasoningStatus = element<HTMLParagraphElement>('reasoning-status');
const reasoningSummary = element<HTMLDivElement>('reasoning-summary');
const verifyAuditButton = element<HTMLButtonElement>('verify-audit');
const auditStatus = element<HTMLParagraphElement>('audit-status');
const loadFailuresButton = element<HTMLButtonElement>('load-failures');
const failuresStatus = element<HTMLParagraphElement>('failures-status');
const failuresList = element<HTMLDivElement>('failures-list');
const loadWorkforceButton = element<HTMLButtonElement>('load-workforce');
const workforceStatus = element<HTMLParagraphElement>('workforce-status');

let apiToken = '';
let snapshot: CortexGraphSnapshot | null = null;
let graph: Graph | null = null;
let cortex3d: ForceGraph3DInstance<Cortex3DNode, Cortex3DLink> | null = null;
let visibleSnapshot: CortexGraphSnapshot | null = null;
let workforceGraph: CortexGraphSnapshot | null = null;
let activeSnapshot: CortexGraphSnapshot | null = null;
let renderSequence = 0;

function setControlsEnabled(enabled: boolean): void {
  for (const control of [
    searchInput,
    moduleFilter,
    kindFilter,
    visualMode,
    layoutSelect,
    showLabels,
    fitViewButton,
    exportButton,
    activityTenant,
    activityBrain,
    loadActivityButton,
    verifyAuditButton,
    loadFailuresButton,
    loadWorkforceButton,
  ]) {
    control.disabled = !enabled;
  }
}

function deterministicCoordinate(value: string, axis: number): number {
  let hash = 2_166_136_261 + axis * 1_013;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return ((hash >>> 0) / 4_294_967_295 - 0.5) * 260;
}

function moduleColor(module: string): string {
  const normalized = (deterministicCoordinate(module, 4) + 130) / 260;
  const hue = cognitiveModules.has(module)
    ? 160 + Math.round(normalized * 45)
    : Math.round(normalized * 320);
  return `hsl(${hue} 72% 62%)`;
}

function moduleClusterForce(): {
  (alpha: number): void;
  initialize(nodes: Cortex3DNode[]): void;
} {
  let forceNodes: Cortex3DNode[] = [];
  const force = (alpha: number): void => {
    for (const node of forceNodes) {
      const strength = 0.055 * alpha;
      node.vx =
        (node.vx ?? 0) + (deterministicCoordinate(node.module, 0) - (node.x ?? 0)) * strength;
      node.vy =
        (node.vy ?? 0) + (deterministicCoordinate(node.module, 1) - (node.y ?? 0)) * strength;
      node.vz =
        (node.vz ?? 0) + (deterministicCoordinate(node.module, 2) - (node.z ?? 0)) * strength;
    }
  };
  force.initialize = (nodes: Cortex3DNode[]): void => {
    forceNodes = nodes;
  };
  return force;
}

function setConnectionState(connected: boolean, message?: string): void {
  connectionStatus.textContent = message ?? (connected ? 'Conectado' : 'Desconectado');
  connectionStatus.classList.toggle('connected', connected);
  setControlsEnabled(connected);
}

function displayError(message: string): void {
  authError.textContent = message;
  authError.hidden = false;
}

function tokenFromEnvironment(text: string): string {
  const line = text
    .split(/\r?\n/u)
    .find((candidate) => candidate.trimStart().startsWith('CORTEX_API_TOKEN='));
  if (!line) return '';
  const value = line.slice(line.indexOf('=') + 1).trim();
  return value.replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2');
}

function validToken(token: string): boolean {
  return new TextEncoder().encode(token).byteLength >= 32;
}

function option(value: string, label: string): HTMLOptionElement {
  const entry = document.createElement('option');
  entry.value = value;
  entry.textContent = label;
  return entry;
}

function configureFilters(data: CortexGraphSnapshot): void {
  moduleFilter.replaceChildren(option('', 'Todos os módulos'));
  for (const module of data.stats.modules) moduleFilter.append(option(module, module));

  kindFilter.replaceChildren(option('', 'Todos os tipos'));
  for (const kind of Object.keys(data.stats.by_kind).sort()) {
    kindFilter.append(option(kind, `${kind} (${data.stats.by_kind[kind] ?? 0})`));
  }
}

function filteredSnapshot(data: CortexGraphSnapshot): CortexGraphSnapshot {
  const query = searchInput.value.trim().toLocaleLowerCase('pt-BR');
  const selectedModule = moduleFilter.value;
  const selectedKind = kindFilter.value;
  const baseNodes = data.nodes.filter(
    (node) =>
      (!selectedModule || node.module === selectedModule) &&
      (!selectedKind || node.kind === selectedKind),
  );
  const baseIds = new Set(baseNodes.map((node) => node.id));

  let visibleIds = baseIds;
  if (query) {
    const matchingIds = new Set(
      baseNodes
        .filter((node) =>
          [node.label, node.id, node.description ?? ''].some((value) =>
            value.toLocaleLowerCase('pt-BR').includes(query),
          ),
        )
        .map((node) => node.id),
    );
    visibleIds = new Set(matchingIds);
    for (const edge of data.edges) {
      if (matchingIds.has(edge.source) && baseIds.has(edge.target)) visibleIds.add(edge.target);
      if (matchingIds.has(edge.target) && baseIds.has(edge.source)) visibleIds.add(edge.source);
    }
  }

  const nodes = baseNodes.filter((node) => visibleIds.has(node.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = data.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  const kinds = Object.fromEntries(
    [...new Set(nodes.map((node) => node.kind))]
      .sort()
      .map((kind) => [kind, nodes.filter((node) => node.kind === kind).length]),
  );
  return {
    version: data.version,
    nodes,
    edges,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      module_count: new Set(nodes.map((node) => node.module)).size,
      modules: [...new Set(nodes.map((node) => node.module))].sort(),
      by_kind: kinds,
    },
  };
}

function updateMetrics(data: CortexGraphSnapshot): void {
  element('metric-nodes').textContent = data.stats.node_count.toLocaleString('pt-BR');
  element('metric-edges').textContent = data.stats.edge_count.toLocaleString('pt-BR');
  element('metric-modules').textContent = data.stats.module_count.toLocaleString('pt-BR');
  element('metric-classes').textContent = (data.stats.by_kind.class ?? 0).toLocaleString('pt-BR');
}

function layoutConfiguration(): LayoutOptions {
  switch (layoutSelect.value) {
    case 'circular':
      return { type: 'circular' };
    case 'concentric':
      return { type: 'concentric' };
    case 'grid':
      return { type: 'grid', preventOverlap: true, nodeSize: 28 };
    default:
      return {
        type: 'force',
        preventOverlap: true,
        nodeSize: 24,
        nodeSpacing: 10,
        iterations: 250,
      };
  }
}

function appendDetail(label: string, value: string): void {
  const row = document.createElement('div');
  row.className = 'detail-row';
  const key = document.createElement('span');
  key.textContent = label;
  const content = document.createElement('p');
  content.textContent = value;
  row.append(key, content);
  detailContent.append(row);
}

function showNodeDetails(nodeId: string): void {
  if (!activeSnapshot) return;
  const node = activeSnapshot.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  detailTitle.textContent = node.label;
  detailContent.replaceChildren();
  appendDetail('Tipo', node.kind);
  appendDetail('Módulo', node.module);
  appendDetail('IRI / identificador', node.id);
  appendDetail('Grau', String(node.degree));
  if (node.description) appendDetail('Definição', node.description);

  const relations = activeSnapshot.edges
    .filter((edge) => edge.source === nodeId || edge.target === nodeId)
    .slice(0, 30);
  if (relations.length > 0) {
    const heading = document.createElement('h3');
    heading.textContent = 'Relações diretas';
    const list = document.createElement('ul');
    for (const edge of relations) {
      const otherId = edge.source === nodeId ? edge.target : edge.source;
      const other = activeSnapshot.nodes.find((candidate) => candidate.id === otherId);
      const item = document.createElement('li');
      item.textContent = `${edge.label} → ${other?.label ?? otherId}`;
      list.append(item);
    }
    detailContent.append(heading, list);
  }
}

async function renderGraph(): Promise<void> {
  if (!snapshot) return;
  const sequence = ++renderSequence;
  const source = visualMode.value === 'workforce' ? workforceGraph : snapshot;
  await graph?.destroy();
  graph = null;
  cortex3d?._destructor();
  cortex3d = null;
  if (!source) {
    activeSnapshot = null;
    visibleSnapshot = null;
    updateMetrics({
      ...snapshot,
      nodes: [],
      edges: [],
      stats: { node_count: 0, edge_count: 0, module_count: 0, modules: [], by_kind: {} },
    });
    element('visual-state').textContent = 'Rede operacional · nenhum escopo real consultado';
    emptyState.hidden = false;
    emptyState.querySelector('h2')!.textContent = 'Consulte a rede operacional';
    emptyState.querySelector('p:last-child')!.textContent =
      'Informe tenant e cérebro existentes e use “Visualizar rede operacional”.';
    return;
  }
  const data = filteredSnapshot(source);
  activeSnapshot = source;
  visibleSnapshot = data;
  updateMetrics(data);
  if (sequence !== renderSequence) return;

  layoutSelect.disabled = visualMode.value === 'cortex-3d';
  element('visual-state').textContent =
    visualMode.value === 'cortex-3d'
      ? 'Mapa ontológico 3D · agrupamento visual por módulo · sem atividade inferida'
      : visualMode.value === 'workforce'
        ? 'Rede operacional 2D · somente metas, agentes e trabalhos persistidos'
        : 'Grafo ontológico 2D · classes e relações declaradas';

  if (visualMode.value === 'cortex-3d') {
    await renderCortex3d(data, sequence);
  } else {
    await renderSemanticGraph(data);
  }
  emptyState.hidden = data.nodes.length > 0;
  if (data.nodes.length === 0) {
    emptyState.querySelector('h2')!.textContent = 'Nenhum nó corresponde aos filtros';
    emptyState.querySelector('p:last-child')!.textContent =
      'Remova parte dos filtros ou altere o termo de busca.';
  }
}

function workforceVisualization(
  data: WorkforceSnapshot,
  registry: AgentRegistryView,
  version: string,
): CortexGraphSnapshot {
  const nodes: CortexGraphNode[] = [];
  const edges: CortexGraphEdge[] = [];
  const addNode = (
    id: string,
    label: string,
    kind: NodeKind,
    module: string,
    description: string | null,
  ): void => {
    nodes.push({ id, label, kind, module, description, degree: 0 });
  };
  const addEdge = (source: string, target: string, label: string): void => {
    if (!source || !target) return;
    edges.push({
      id: `workforce:${edges.length}:${source}:${target}`,
      source,
      target,
      label,
      predicate: label,
      kind: 'policy',
    });
  };
  for (const agent of registry.agents) {
    addNode(agent.id, agent.name, 'agent', agent.department, `${agent.role} · agente registrado`);
    if (agent.reports_to) addEdge(agent.id, agent.reports_to, 'reporta a');
  }
  for (const goal of data.goals) {
    addNode(goal.id, goal.title, 'goal', 'goals', `${goal.status} · ${goal.description}`);
    addEdge(goal.owner_agent_id, goal.id, 'responsável pela meta');
    if (goal.parent_goal_id) addEdge(goal.id, goal.parent_goal_id, 'submeta de');
  }
  for (const item of data.work_items) {
    addNode(item.id, item.title, 'work-item', 'work-items', `${item.status} · ${item.description}`);
    addEdge(item.goal_id, item.id, 'origina trabalho');
    addEdge(item.assigned_agent_id, item.id, 'executa');
    if (item.parent_work_item_id) addEdge(item.id, item.parent_work_item_id, 'subtarefa de');
    for (const blocker of item.blocked_by) addEdge(item.id, blocker, 'bloqueado por');
  }
  for (const routine of data.routines) {
    addNode(
      routine.id,
      routine.name,
      'routine',
      'routines',
      `${routine.status} · rotina persistida`,
    );
    addEdge(routine.goal_id, routine.id, 'agenda');
    addEdge(routine.assigned_agent_id, routine.id, 'materializa');
  }
  for (const heartbeat of data.heartbeats) {
    addNode(
      heartbeat.id,
      `Heartbeat · ${heartbeat.status}`,
      'heartbeat',
      'heartbeats',
      `${heartbeat.observed_at} · observação persistida`,
    );
    addEdge(heartbeat.agent_id, heartbeat.id, 'reporta estado');
    if (heartbeat.current_work_item_id) {
      addEdge(heartbeat.id, heartbeat.current_work_item_id, 'observado em');
    }
  }
  for (const evaluation of data.evaluations) {
    addNode(evaluation.id, 'Avaliação registrada', 'evaluation', 'evaluations', null);
    addEdge(evaluation.evaluator_id, evaluation.id, 'avalia');
    addEdge(evaluation.id, evaluation.agent_id, 'mede agente');
    addEdge(evaluation.id, evaluation.work_item_id, 'verifica trabalho');
  }
  const nodeIds = new Set(nodes.map((node) => node.id));
  const boundedEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  for (const node of nodes) {
    node.degree = boundedEdges.filter(
      (edge) => edge.source === node.id || edge.target === node.id,
    ).length;
  }
  const modules = [...new Set(nodes.map((node) => node.module))].sort();
  const byKind = Object.fromEntries(
    [...new Set(nodes.map((node) => node.kind))]
      .sort()
      .map((kind) => [kind, nodes.filter((node) => node.kind === kind).length]),
  );
  return {
    version,
    nodes,
    edges: boundedEdges,
    stats: {
      node_count: nodes.length,
      edge_count: boundedEdges.length,
      module_count: modules.length,
      modules,
      by_kind: byKind,
    },
  };
}

async function loadWorkforce(): Promise<void> {
  const tenantId = activityTenant.value.trim();
  const brainId = activityBrain.value.trim();
  if (!tenantId || !brainId) {
    workforceStatus.textContent = 'Informe tenant e cérebro reais nos campos acima.';
    return;
  }
  loadWorkforceButton.disabled = true;
  workforceStatus.textContent = 'Consultando registros operacionais persistidos…';
  try {
    const headers = { authorization: `Bearer ${apiToken}` };
    const query = new URLSearchParams({ tenant_id: tenantId, brain_id: brainId });
    const [workforceResponse, agentsResponse] = await Promise.all([
      fetch(`/v1/workforce/snapshot?${query.toString()}`, {
        cache: 'no-store',
        credentials: 'omit',
        headers,
      }),
      fetch('/v1/agents/registry', { cache: 'no-store', credentials: 'omit', headers }),
    ]);
    if (!workforceResponse.ok || !agentsResponse.ok) {
      throw new Error(`A consulta respondeu com o código ${workforceResponse.status}.`);
    }
    const workforce = (await workforceResponse.json()) as WorkforceSnapshot;
    const registry = (await agentsResponse.json()) as AgentRegistryView;
    workforceGraph = workforceVisualization(workforce, registry, snapshot?.version ?? 'unknown');
    workforceStatus.textContent =
      `${workforce.goals.length} meta(s), ${workforce.work_items.length} trabalho(s), ` +
      `${workforce.routines.length} rotina(s), ${workforce.heartbeats.length} heartbeat(s), ` +
      `${workforce.costs.event_count} evento(s) de custo medido, ` +
      `${workforce.costs.total_tokens} token(s), ${workforce.costs.cost_microusd} micro-USD.`;
    visualMode.value = 'workforce';
    configureFilters(workforceGraph);
    moduleFilter.value = '';
    kindFilter.value = '';
    await renderGraph();
  } catch (error) {
    workforceGraph = null;
    workforceStatus.textContent =
      error instanceof Error ? error.message : 'Não foi possível consultar a rede operacional.';
  } finally {
    loadWorkforceButton.disabled = false;
  }
}

async function renderSemanticGraph(data: CortexGraphSnapshot): Promise<void> {
  const labelThreshold = data.nodes.length <= 350;
  graph = new Graph({
    container: 'graph',
    autoFit: 'view',
    data: {
      nodes: data.nodes.map((node) => ({
        id: node.id,
        label: node.label,
        kind: node.kind,
        module: node.module,
        degree: node.degree,
      })),
      edges: data.edges.map((edge) => ({ ...edge })) as EdgeData[],
    },
    behaviors: ['drag-canvas', 'zoom-canvas', 'drag-element', 'click-select'],
    layout: layoutConfiguration(),
    node: {
      style: {
        size: (datum) => Math.min(38, 14 + Math.sqrt(Number(datum.degree ?? 0)) * 2.2),
        fill: (datum) => nodeColor(datum),
        stroke: '#dbeafe',
        lineWidth: 0.7,
        shadowColor: (datum) => nodeColor(datum),
        shadowBlur: 12,
        labelText: (datum) =>
          showLabels.checked && labelThreshold ? String(datum.label ?? '') : '',
        labelFill: '#dbeafe',
        labelFontSize: 10,
        labelOffsetY: 14,
        labelMaxWidth: 150,
        cursor: 'pointer',
      },
      state: {
        selected: { stroke: '#ffffff', lineWidth: 3, shadowBlur: 24 },
      },
    },
    edge: {
      style: {
        stroke: '#334a68',
        lineWidth: 0.8,
        opacity: 0.58,
        endArrow: true,
      },
      state: {
        selected: { stroke: '#67e8f9', lineWidth: 2, opacity: 1 },
      },
    },
  });
  graph.on(NodeEvent.CLICK, (event) => showNodeDetails(String((event as IElementEvent).target.id)));
  await graph.render();
}

async function renderCortex3d(data: CortexGraphSnapshot, sequence: number): Promise<void> {
  const { default: ForceGraph3D } = await import('3d-force-graph');
  if (sequence !== renderSequence || visualMode.value !== 'cortex-3d') return;
  const nodes: Cortex3DNode[] = data.nodes.map((node) => ({
    ...node,
    x: deterministicCoordinate(node.module, 0) + deterministicCoordinate(node.id, 0) * 0.22,
    y: deterministicCoordinate(node.module, 1) + deterministicCoordinate(node.id, 1) * 0.22,
    z: deterministicCoordinate(node.module, 2) + deterministicCoordinate(node.id, 2) * 0.22,
  }));
  const links: Cortex3DLink[] = data.edges.map((edge) => ({ ...edge }));
  const instance = new ForceGraph3D(element('graph'), {
    controlType: 'orbit',
    rendererConfig: { antialias: true, alpha: true },
  }) as unknown as ForceGraph3DInstance<Cortex3DNode, Cortex3DLink>;
  cortex3d = instance;
  instance
    .graphData({ nodes, links })
    .backgroundColor('#040a12')
    .showNavInfo(false)
    .nodeLabel((node) => {
      const label = document.createElement('span');
      label.textContent = showLabels.checked
        ? `${node.label} · ${node.module} · ${node.kind}`
        : node.label;
      return label;
    })
    .nodeColor((node) => moduleColor(node.module))
    .nodeVal((node) => Math.min(12, 1.8 + Math.sqrt(node.degree + 1) * 0.75))
    .nodeOpacity(0.92)
    .linkColor(() => '#35506b')
    .linkOpacity(0.34)
    .linkWidth(0.45)
    .linkDirectionalArrowLength(2.1)
    .linkDirectionalArrowRelPos(0.88)
    .d3Force('module-cluster', moduleClusterForce())
    .d3VelocityDecay(0.34)
    .warmupTicks(80)
    .cooldownTicks(220)
    .onNodeClick((node) => {
      showNodeDetails(node.id);
      const distance = 90;
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const z = node.z ?? 0;
      const ratio = 1 + distance / Math.hypot(x, y, z || 1);
      cortex3d?.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 900);
    });
  window.setTimeout(() => cortex3d?.zoomToFit(900, 55), 350);
}

function renderActivity(activity: BrainActivity[]): void {
  activityList.replaceChildren();
  activityStatus.textContent =
    activity.length === 0
      ? 'Nenhum evento persistido foi encontrado nesse escopo.'
      : `${activity.length.toLocaleString('pt-BR')} evento(s) persistido(s), do mais recente ao mais antigo.`;
  for (const event of activity) {
    const article = document.createElement('article');
    article.className = 'activity-entry';
    const heading = document.createElement('div');
    const kind = document.createElement('strong');
    kind.textContent = event.kind;
    const status = document.createElement('span');
    status.textContent = event.status;
    heading.append(kind, status);
    const subject = document.createElement('p');
    subject.textContent = event.subject_id;
    const summary = document.createElement('p');
    summary.textContent = event.summary;
    const time = document.createElement('time');
    time.dateTime = event.occurred_at;
    time.textContent = event.occurred_at;
    const trace = document.createElement('code');
    trace.textContent = `${event.operation} · ${event.trace_id}`;
    article.append(heading, subject, summary, trace, time);
    activityList.append(article);
  }
}

function renderReasoning(report: ReasoningReport): void {
  reasoningStatus.textContent = report.consistent
    ? 'Nenhuma violação lógica foi encontrada no subconjunto implementado.'
    : 'Há violações lógicas no subconjunto implementado; consulte os diagnósticos.';
  reasoningStatus.classList.toggle('danger', !report.consistent);
  const values: Array<[string, string]> = [
    ['Triplas explícitas', report.explicit_triples.toLocaleString('pt-BR')],
    ['Triplas inferidas', report.inferred_triples.toLocaleString('pt-BR')],
    ['Iterações', report.iterations.toLocaleString('pt-BR')],
    ['Diagnósticos', report.diagnostics.length.toLocaleString('pt-BR')],
    ['Truncado', report.truncated ? 'sim' : 'não'],
    ['OWL completo', report.complete_owl_reasoner ? 'sim' : 'não'],
  ];
  reasoningSummary.replaceChildren();
  for (const [label, value] of values) {
    const row = document.createElement('div');
    const key = document.createElement('span');
    key.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    row.append(key, content);
    reasoningSummary.append(row);
  }
}

async function verifyAudit(): Promise<void> {
  const tenantId = activityTenant.value.trim();
  const brainId = activityBrain.value.trim();
  if (!tenantId || !brainId) {
    auditStatus.textContent = 'Informe tenant e cérebro reais nos campos acima.';
    return;
  }
  verifyAuditButton.disabled = true;
  try {
    const query = new URLSearchParams({ tenant_id: tenantId, brain_id: brainId });
    const response = await fetch(`/v1/audit/integrity?${query.toString()}`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    const report = (await response.json()) as {
      valid?: boolean;
      checked_events?: number;
      legacy_events?: number;
      first_invalid_sequence?: number | null;
    };
    auditStatus.classList.toggle('danger', report.valid !== true);
    auditStatus.textContent = report.valid
      ? `Cadeia válida: ${report.checked_events ?? 0} evento(s) verificado(s); ${report.legacy_events ?? 0} legado(s).`
      : `Cadeia inválida na sequência ${report.first_invalid_sequence ?? 'desconhecida'}.`;
  } catch (error) {
    auditStatus.classList.add('danger');
    auditStatus.textContent =
      error instanceof Error ? error.message : 'Falha ao verificar a cadeia.';
  } finally {
    verifyAuditButton.disabled = false;
  }
}

async function loadFailures(): Promise<void> {
  loadFailuresButton.disabled = true;
  failuresStatus.textContent = 'Consultando diagnósticos sem payload…';
  try {
    const response = await fetch('/v1/observability/failures?limit=50', {
      cache: 'no-store',
      credentials: 'omit',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    if (!response.ok) throw new Error(`A consulta respondeu com o código ${response.status}.`);
    const body = (await response.json()) as { failures?: SanitizedFailure[] };
    if (!Array.isArray(body.failures)) throw new Error('Resposta de falhas fora do contrato.');
    failuresList.replaceChildren();
    failuresStatus.textContent = `${body.failures.length} falha(s) sanitizada(s).`;
    for (const failure of body.failures) {
      const article = document.createElement('article');
      article.className = 'activity-entry';
      const title = document.createElement('strong');
      title.textContent = `${failure.status_code} · ${failure.error_code}`;
      const operation = document.createElement('p');
      operation.textContent = failure.operation;
      const trace = document.createElement('code');
      trace.textContent = failure.trace_id;
      const time = document.createElement('time');
      time.dateTime = failure.occurred_at;
      time.textContent = failure.occurred_at;
      article.append(title, operation, trace, time);
      failuresList.append(article);
    }
  } catch (error) {
    failuresList.replaceChildren();
    failuresStatus.textContent = error instanceof Error ? error.message : 'Falha na consulta.';
  } finally {
    loadFailuresButton.disabled = false;
  }
}

async function loadActivity(): Promise<void> {
  const tenantId = activityTenant.value.trim();
  const brainId = activityBrain.value.trim();
  if (!tenantId || !brainId) {
    activityStatus.textContent = 'Informe tenant e cérebro reais para consultar o banco local.';
    activityList.replaceChildren();
    return;
  }
  loadActivityButton.disabled = true;
  activityStatus.textContent = 'Consultando eventos persistidos…';
  const query = new URLSearchParams({ tenant_id: tenantId, brain_id: brainId, limit: '100' });
  try {
    const response = await fetch(`/v1/brain/activity?${query.toString()}`, {
      cache: 'no-store',
      credentials: 'omit',
      headers: { authorization: `Bearer ${apiToken}` },
    });
    if (response.status === 401) throw new Error('Chave rejeitada pelo Cortex.');
    if (!response.ok) throw new Error(`A consulta respondeu com o código ${response.status}.`);
    const body = (await response.json()) as { activity?: BrainActivity[] };
    if (!Array.isArray(body.activity)) throw new Error('Resposta de atividade fora do contrato.');
    renderActivity(body.activity);
  } catch (error) {
    activityList.replaceChildren();
    activityStatus.textContent =
      error instanceof Error ? error.message : 'Não foi possível consultar a atividade.';
  } finally {
    loadActivityButton.disabled = false;
  }
}

async function connect(): Promise<void> {
  authError.hidden = true;
  const candidate = apiTokenInput.value.trim() || apiToken;
  if (!validToken(candidate)) {
    displayError(
      'A chave precisa ter pelo menos 32 bytes. Selecione o .env criado pelo instalador.',
    );
    return;
  }
  loading.hidden = false;
  try {
    const headers = { authorization: `Bearer ${candidate}` };
    const [response, reasoningResponse] = await Promise.all([
      fetch('/v1/graph', { cache: 'no-store', credentials: 'omit', headers }),
      fetch('/v1/ontology/reasoning', { cache: 'no-store', credentials: 'omit', headers }),
    ]);
    if (response.status === 401 || reasoningResponse.status === 401) {
      throw new Error('Chave rejeitada pelo Cortex.');
    }
    if (!response.ok || !reasoningResponse.ok) {
      throw new Error(`O Cortex respondeu com o código ${response.status}.`);
    }
    snapshot = (await response.json()) as CortexGraphSnapshot;
    renderReasoning((await reasoningResponse.json()) as ReasoningReport);
    apiToken = candidate;
    apiTokenInput.value = '';
    configureFilters(snapshot);
    setConnectionState(true, `Conectado · v${snapshot.version}`);
    authDialog.close();
    await renderGraph();
  } catch (error) {
    setConnectionState(false);
    displayError(error instanceof Error ? error.message : 'Não foi possível abrir o grafo.');
  } finally {
    loading.hidden = true;
  }
}

let searchTimer: number | undefined;
searchInput.addEventListener('input', () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void renderGraph(), 180);
});
for (const control of [moduleFilter, kindFilter, layoutSelect, showLabels]) {
  control.addEventListener('change', () => void renderGraph());
}
visualMode.addEventListener('change', () => {
  const source = visualMode.value === 'workforce' ? workforceGraph : snapshot;
  if (source) configureFilters(source);
  void renderGraph();
});

element<HTMLButtonElement>('open-auth').addEventListener('click', () => authDialog.showModal());
element<HTMLButtonElement>('connect').addEventListener('click', () => void connect());
loadActivityButton.addEventListener('click', () => void loadActivity());
verifyAuditButton.addEventListener('click', () => void verifyAudit());
loadFailuresButton.addEventListener('click', () => void loadFailures());
loadWorkforceButton.addEventListener('click', () => void loadWorkforce());
environmentFile.addEventListener('change', async () => {
  authError.hidden = true;
  const file = environmentFile.files?.[0];
  if (!file) return;
  const candidate = tokenFromEnvironment(await file.text());
  environmentFile.value = '';
  if (!validToken(candidate)) {
    displayError('O arquivo não contém uma CORTEX_API_TOKEN válida.');
    return;
  }
  apiToken = candidate;
  await connect();
});
fitViewButton.addEventListener('click', () => {
  if (visualMode.value === 'cortex-3d') cortex3d?.zoomToFit(700, 55);
  else void graph?.fitView();
});
exportButton.addEventListener('click', () => {
  if (!visibleSnapshot) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(visibleSnapshot, null, 2)], { type: 'application/json' }),
  );
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `cortex-graph-${visibleSnapshot.version}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
});

document.addEventListener('keydown', (event) => {
  if (event.key === '/' && document.activeElement !== searchInput && !searchInput.disabled) {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === 'Escape' && !authDialog.open) {
    detailTitle.textContent = 'Selecione um nó';
    detailContent.replaceChildren(document.createTextNode('Clique em um nó para inspecioná-lo.'));
  }
});

setConnectionState(false);
