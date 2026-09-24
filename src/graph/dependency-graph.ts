export type NodeKind = 'package' | 'dependency' | 'workspace';
export interface Edge {
  name: string;
  kind: string;
  target: string;
}
export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  version: string;
  scope: string;
  edges: Edge[];
  metadata: unknown;
  uncertain: boolean;
}
export interface DependencyGraph {
  nodes: Map<string, GraphNode>;
  warnings: string[];
}

export const workspaceId = (path: string): string => `workspace:${path}`;
export const dependencyId = (path: string, section: string, name: string): string =>
  `dependency:${JSON.stringify([path, section, name])}`;

export function stable(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(node: GraphNode): string {
  // Workspace edge changes are represented by their individual dependency nodes.
  return stable({
    name: node.name,
    version: node.version,
    metadata: node.metadata,
    edges:
      node.kind === 'workspace'
        ? []
        : [...node.edges].sort((a, b) => stable(a).localeCompare(stable(b))),
  });
}
