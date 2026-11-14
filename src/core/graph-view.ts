import type { Docify } from "./docify.ts";

// The active generation's graph, shaped for the web viewer. Read-only, like every query.

export interface GraphViewNode {
  id: string;
  label: string;
  type: string;
  // Document path the node was extracted from; null when Graphify named no known file.
  page: string | null;
  url: string | null;
  degree: number;
  // Hyperedge group index into `groups`, or -1.
  group: number;
  grounding: null | {
    passages: number;
    // The longest grounding passage, as the most telling sample.
    passage: string;
    headingPath: string[];
    lines: [number, number];
    excerpt: string;
  };
}

export interface GraphView {
  source: string;
  generation: number | null;
  // ok | partial | skipped | null (not prepared)
  graphStatus: string | null;
  stats: {
    documents: number | null;
    nodes: number;
    edges: number;
    grounded: number;
    missingDocuments: string[];
    // Documents kept out of the graph by the source's graphIgnore patterns; they are not missing.
    ignoredDocuments: number;
    model: string | null;
    graphMs: number | null;
    costEstimate: string | null;
  };
  nodes: GraphViewNode[];
  // Pairs of node indexes plus relation; one entry per connected pair.
  edges: { source: number; target: number; relation: string }[];
  groups: { label: string; size: number }[];
}

const EXCERPT_CHARS = 320;

export function graphView(docify: Docify, sourceId: string): GraphView {
  // One read transaction, so a concurrent activation cannot mix two generations.
  return docify.db.transaction(() => {
    const source = docify.requireSource(sourceId);
    const gen = source.active_generation ? docify.getGeneration(source.active_generation) : null;
    const stats = gen ? (JSON.parse(gen.stats) as Record<string, unknown>) : {};
    const empty: GraphView = {
      source: sourceId,
      generation: gen?.id ?? null,
      graphStatus: gen?.graph_status ?? null,
      stats: {
        documents: typeof stats.documents === "number" ? stats.documents : null,
        nodes: 0,
        edges: 0,
        grounded: 0,
        missingDocuments: Array.isArray(stats.graphMissing) ? (stats.graphMissing as string[]) : [],
        ignoredDocuments: typeof stats.graphIgnored === "number" ? stats.graphIgnored : 0,
        model: typeof stats.graphModel === "string" ? stats.graphModel : null,
        graphMs: typeof stats.graphMs === "number" ? stats.graphMs : null,
        costEstimate: typeof stats.graphCostEstimate === "string" ? stats.graphCostEstimate : null,
      },
      nodes: [],
      edges: [],
      groups: [],
    };
    if (!gen || (gen.graph_status !== "ok" && gen.graph_status !== "partial")) return empty;

    const rows = docify.db
      .query<{ node_id: string; label: string; node_type: string | null; path: string | null; url: string | null }, [number]>(
        `SELECT n.node_id, n.label, n.node_type, d.path, d.url
         FROM graph_nodes n LEFT JOIN documents d ON d.id = n.document_id
         WHERE n.generation_id = ? ORDER BY n.node_id`,
      )
      .all(gen.id);
    const index = new Map(rows.map((r, i) => [r.node_id, i]));

    const edgeRows = docify.db
      .query<{ src: string; dst: string; relation: string; confidence: string | null }, [number]>(
        "SELECT src, dst, relation, confidence FROM graph_edges WHERE generation_id = ?",
      )
      .all(gen.id);
    const degree = new Array<number>(rows.length).fill(0);
    const pairs = new Map<string, { source: number; target: number; relation: string }>();
    // Hyperedges were stored as hub -> member edges named "group:<label>".
    const groupMembers = new Map<string, Set<number>>();
    for (const e of edgeRows) {
      const s = index.get(e.src);
      const t = index.get(e.dst);
      if (s === undefined || t === undefined || s === t) continue;
      if (e.confidence === "HYPEREDGE" && e.relation.startsWith("group:")) {
        const label = e.relation.slice("group:".length);
        const members = groupMembers.get(label) ?? new Set<number>();
        members.add(s).add(t);
        groupMembers.set(label, members);
        continue;
      }
      const key = s < t ? `${s}:${t}` : `${t}:${s}`;
      if (pairs.has(key)) continue;
      pairs.set(key, { source: s, target: t, relation: e.relation });
      degree[s]!++;
      degree[t]!++;
    }

    // Largest groups first; a node keeps the first (largest) group it belongs to.
    const groups = [...groupMembers].map(([label, members]) => ({ label, members })).sort((a, b) => b.members.size - a.members.size || a.label.localeCompare(b.label));
    const groupOf = new Array<number>(rows.length).fill(-1);
    groups.forEach((g, gi) => g.members.forEach((m) => { if (groupOf[m] === -1) groupOf[m] = gi; }));

    const ground = new Map<string, { count: number; best: { id: string; heading_path: string; start_line: number; end_line: number; text: string } }>();
    const groundRows = docify.db
      .query<{ node_id: string; id: string; heading_path: string; start_line: number; end_line: number; text: string }, [number]>(
        `SELECT np.node_id, p.id, p.heading_path, p.start_line, p.end_line, p.text
         FROM node_passages np JOIN passages p ON p.rowid = np.passage_rowid
         WHERE np.generation_id = ?`,
      )
      .all(gen.id);
    for (const r of groundRows) {
      const g = ground.get(r.node_id);
      if (!g) ground.set(r.node_id, { count: 1, best: r });
      else {
        g.count++;
        if (r.text.length > g.best.text.length) g.best = r;
      }
    }

    const nodes: GraphViewNode[] = rows.map((r, i) => {
      const g = ground.get(r.node_id);
      return {
        id: r.node_id,
        label: r.label,
        type: r.node_type ?? "concept",
        page: r.path,
        url: r.url,
        degree: degree[i]!,
        group: groupOf[i]!,
        grounding: g
          ? {
              passages: g.count,
              passage: g.best.id,
              headingPath: JSON.parse(g.best.heading_path) as string[],
              lines: [g.best.start_line, g.best.end_line],
              excerpt: g.best.text.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS),
            }
          : null,
      };
    });

    return {
      ...empty,
      stats: { ...empty.stats, nodes: nodes.length, edges: pairs.size, grounded: ground.size },
      nodes,
      edges: [...pairs.values()],
      groups: groups.map((g) => ({ label: g.label, size: g.members.size })),
    };
  })();
}
