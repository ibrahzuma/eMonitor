import type { DependencyMap } from "@/types/api";

/** Layer nodes so every node sits right of the resources it depends on. */
export function layoutDependencyMap(map: DependencyMap): { layers: string[][]; layerOf: Map<string, number> } {
  const deps = new Map<string, string[]>();
  for (const e of map.edges) deps.set(e.from, [...(deps.get(e.from) ?? []), e.to]);
  const layerOf = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    const known = layerOf.get(id);
    if (known !== undefined) return known;
    if (stack.has(id)) return 0;
    stack.add(id);
    const l = Math.max(-1, ...(deps.get(id) ?? []).map((d) => visit(d, stack))) + 1;
    stack.delete(id);
    layerOf.set(id, l);
    return l;
  };
  map.nodes.forEach((n) => visit(n.id, new Set()));
  const layers: string[][] = [];
  for (const n of [...map.nodes].sort((a, b) => a.name.localeCompare(b.name))) {
    const l = layerOf.get(n.id) ?? 0;
    (layers[l] ??= []).push(n.id);
  }
  return { layers: layers.map((x) => x ?? []), layerOf };
}

