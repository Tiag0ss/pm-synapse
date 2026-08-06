'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pathStem } from '@/lib/notePaths';

export interface GraphNode {
  Id: number;
  Title: string;
  Path?: string;
  VaultId?: number;
  VaultSlug?: string | null;
  VaultName?: string | null;
  Restricted?: boolean;
  External?: boolean;
}

export interface GraphEdge {
  FromNoteId: number;
  ToNoteId: number;
  Kind: string;
}

interface NoteGraphMindmapProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  height?: number;
  focusId?: number | null;
  variant?: 'focus' | 'full';
  reloadToken?: string | number;
  compactLegend?: boolean;
  onNodeClick?: (id: number, node: GraphNode) => void;
}

interface SimNode {
  id: number;
  title: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  pinned?: boolean;
  restricted?: boolean;
  external?: boolean;
  /** Folder meta-node */
  isFolder?: boolean;
  folderKey?: string;
  noteCount?: number;
  linkCount?: number;
}

type KindFilter = 'all' | 'wikilink' | 'mention' | 'other';
type GraphViewMode = 'folders' | 'notes';

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
const ROOT_FOLDER = '(root)';
/** Prefer folder clusters when the vault graph has more than this many links. */
const FOLDER_VIEW_LINK_THRESHOLD = 25;

function kindColor(kind: string): string {
  if (kind === 'wikilink') return '#5eead4';
  if (kind === 'mention') return '#7dd3fc';
  return '#94a3b8';
}

function edgeKindBucket(kind: string): 'wikilink' | 'mention' | 'other' {
  if (kind === 'wikilink') return 'wikilink';
  if (kind === 'mention') return 'mention';
  return 'other';
}

/** Top-level folder segment from path/title (e.g. meta/risks → meta). */
export function topFolderKey(node: Pick<GraphNode, 'Path' | 'Title'>): string {
  const stem = pathStem(node.Path || node.Title || '');
  const parts = stem.split('/').filter(Boolean);
  if (parts.length <= 1) return ROOT_FOLDER;
  return parts[0];
}

function folderLabel(key: string): string {
  return key === ROOT_FOLDER ? 'Root' : key;
}

function egoSubgraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  focusId: number | null
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (focusId == null) return { nodes, edges };
  const neighborIds = new Set<number>([focusId]);
  for (const e of edges) {
    if (e.FromNoteId === focusId) neighborIds.add(e.ToNoteId);
    if (e.ToNoteId === focusId) neighborIds.add(e.FromNoteId);
  }
  const filteredNodes = nodes.filter((n) => neighborIds.has(n.Id));
  if (!filteredNodes.some((n) => n.Id === focusId)) {
    const focus = nodes.find((n) => n.Id === focusId);
    if (focus) filteredNodes.unshift(focus);
  }
  const filteredEdges = edges.filter(
    (e) => neighborIds.has(e.FromNoteId) && neighborIds.has(e.ToNoteId)
  );
  return { nodes: filteredNodes, edges: filteredEdges };
}

type FolderMetaEdge = {
  fromKey: string;
  toKey: string;
  count: number;
  kind: string;
};

function buildFolderModel(
  nodes: GraphNode[],
  edges: GraphEdge[],
  kindFilter: KindFilter
): {
  folders: Map<string, GraphNode[]>;
  folderEdges: FolderMetaEdge[];
  noteFolder: Map<number, string>;
} {
  const folders = new Map<string, GraphNode[]>();
  const noteFolder = new Map<number, string>();
  for (const n of nodes) {
    const key = topFolderKey(n);
    noteFolder.set(n.Id, key);
    const list = folders.get(key) || [];
    list.push(n);
    folders.set(key, list);
  }

  const pairMap = new Map<string, FolderMetaEdge>();
  for (const e of edges) {
    if (kindFilter !== 'all' && edgeKindBucket(e.Kind) !== kindFilter) continue;
    const a = noteFolder.get(e.FromNoteId);
    const b = noteFolder.get(e.ToNoteId);
    if (!a || !b || a === b) continue;
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const id = `${lo}||${hi}`;
    const existing = pairMap.get(id);
    if (existing) {
      existing.count += 1;
      if (e.Kind === 'wikilink') existing.kind = 'wikilink';
    } else {
      pairMap.set(id, {
        fromKey: lo,
        toKey: hi,
        count: 1,
        kind: edgeKindBucket(e.Kind) === 'wikilink' ? 'wikilink' : e.Kind,
      });
    }
  }

  return { folders, folderEdges: [...pairMap.values()], noteFolder };
}

export default function NoteGraphMindmap({
  nodes: allNodes,
  edges: allEdges,
  height = 420,
  focusId = null,
  variant = 'full',
  reloadToken = 0,
  compactLegend = false,
  onNodeClick,
}: NoteGraphMindmapProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [positions, setPositions] = useState<SimNode[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);
  const simRef = useRef<SimNode[]>([]);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const panDrag = useRef<{
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [kindFilter, setKindFilter] = useState<KindFilter>('wikilink');
  const [titleQuery, setTitleQuery] = useState('');
  const [viewMode, setViewMode] = useState<GraphViewMode>('notes');
  /** null = folder overview; string = drilled into that folder */
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const metaEdgesRef = useRef<FolderMetaEdge[]>([]);

  const isFull = variant === 'full';
  const useFolders = isFull && viewMode === 'folders';
  const folderOverview = useFolders && openFolder == null;

  const baseGraph = useMemo(() => {
    if (variant === 'focus') return egoSubgraph(allNodes, allEdges, focusId);
    return { nodes: allNodes, edges: allEdges };
  }, [allNodes, allEdges, variant, focusId]);

  const folderModel = useMemo(
    () => buildFolderModel(baseGraph.nodes, baseGraph.edges, kindFilter),
    [baseGraph, kindFilter]
  );

  const { nodes, edges, metaEdges } = useMemo(() => {
    if (!isFull) {
      return { nodes: baseGraph.nodes, edges: baseGraph.edges, metaEdges: [] as FolderMetaEdge[] };
    }

    const q = titleQuery.trim().toLowerCase();

    // Classic note graph
    if (viewMode === 'notes') {
      let nextEdges = baseGraph.edges;
      if (kindFilter !== 'all') {
        nextEdges = nextEdges.filter((e) => edgeKindBucket(e.Kind) === kindFilter);
      }
      const linked = new Set<number>();
      for (const e of nextEdges) {
        linked.add(e.FromNoteId);
        linked.add(e.ToNoteId);
      }
      let nextNodes =
        kindFilter === 'all'
          ? baseGraph.nodes
          : baseGraph.nodes.filter((n) => linked.has(n.Id) || n.Id === focusId);
      if (q) {
        nextNodes = nextNodes.filter(
          (n) =>
            n.Title.toLowerCase().includes(q) ||
            String(n.Path || '').toLowerCase().includes(q)
        );
        const keep = new Set(nextNodes.map((n) => n.Id));
        nextEdges = nextEdges.filter((e) => keep.has(e.FromNoteId) && keep.has(e.ToNoteId));
      }
      return { nodes: nextNodes, edges: nextEdges, metaEdges: [] as FolderMetaEdge[] };
    }

    if (openFolder == null) {
      // Folder overview: synthetic folder nodes + aggregated edges
      let folderEntries = [...folderModel.folders.entries()];
      if (q) {
        folderEntries = folderEntries.filter(([key]) =>
          folderLabel(key).toLowerCase().includes(q)
        );
      }
      const keepKeys = new Set(folderEntries.map(([key]) => key));
      const folderNodes: GraphNode[] = folderEntries.map(([key]) => ({
        Id: -Math.abs(hashFolderId(key)),
        Title: folderLabel(key),
        Path: key === ROOT_FOLDER ? '' : `${key}/`,
      }));
      return {
        nodes: folderNodes,
        edges: [] as GraphEdge[],
        metaEdges: folderModel.folderEdges.filter(
          (e) => keepKeys.has(e.fromKey) && keepKeys.has(e.toKey)
        ),
      };
    }

    // Drilled into a folder: notes in this folder + neighbors in other folders linked from here
    const inFolder = new Set(
      (folderModel.folders.get(openFolder) || []).map((n) => n.Id)
    );
    const neighborIds = new Set<number>();
    const nextEdges: GraphEdge[] = [];
    for (const e of baseGraph.edges) {
      if (kindFilter !== 'all' && edgeKindBucket(e.Kind) !== kindFilter) continue;
      const aIn = inFolder.has(e.FromNoteId);
      const bIn = inFolder.has(e.ToNoteId);
      if (aIn && bIn) {
        nextEdges.push(e);
      } else if (aIn || bIn) {
        nextEdges.push(e);
        if (aIn) neighborIds.add(e.ToNoteId);
        if (bIn) neighborIds.add(e.FromNoteId);
      }
    }
    let nextNodes = baseGraph.nodes.filter(
      (n) => inFolder.has(n.Id) || neighborIds.has(n.Id)
    );
    if (q) {
      nextNodes = nextNodes.filter(
        (n) =>
          n.Title.toLowerCase().includes(q) ||
          String(n.Path || '').toLowerCase().includes(q)
      );
      const keep = new Set(nextNodes.map((n) => n.Id));
      return {
        nodes: nextNodes,
        edges: nextEdges.filter((e) => keep.has(e.FromNoteId) && keep.has(e.ToNoteId)),
        metaEdges: [] as FolderMetaEdge[],
      };
    }
    return { nodes: nextNodes, edges: nextEdges, metaEdges: [] as FolderMetaEdge[] };
  }, [isFull, viewMode, openFolder, folderModel, baseGraph, kindFilter, titleQuery, focusId]);

  metaEdgesRef.current = metaEdges;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const resetCamera = useCallback(() => {
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }, []);

  useEffect(() => {
    resetCamera();
    setOpenFolder(null);
    setViewMode(allEdges.length > FOLDER_VIEW_LINK_THRESHOLD ? 'folders' : 'notes');
  }, [reloadToken, variant, allEdges.length, resetCamera]);

  const degree = useMemo(() => {
    const d = new Map<number, number>();
    for (const n of nodes) d.set(n.Id, 0);
    for (const e of edges) {
      d.set(e.FromNoteId, (d.get(e.FromNoteId) || 0) + 1);
      d.set(e.ToNoteId, (d.get(e.ToNoteId) || 0) + 1);
    }
    for (const me of metaEdges) {
      // folder synthetic ids
      for (const key of [me.fromKey, me.toKey]) {
        const id = -Math.abs(hashFolderId(key));
        d.set(id, (d.get(id) || 0) + me.count);
      }
    }
    return d;
  }, [nodes, edges, metaEdges]);

  // Seed simulation
  useEffect(() => {
    const cx = width / 2;
    const cy = height / 2;
    const n = nodes.length || 1;

    if (folderOverview) {
      // Spread folder nodes on a wide ring so clusters stay apart
      const ring = Math.min(Math.min(width, height) * 0.38, 40 + 70 * Math.sqrt(n));
      const seeded: SimNode[] = nodes.map((node, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
        const key =
          [...folderModel.folders.keys()].find(
            (k) => -Math.abs(hashFolderId(k)) === node.Id
          ) || ROOT_FOLDER;
        const noteCount = folderModel.folders.get(key)?.length || 0;
        const linkCount = metaEdges
          .filter((e) => e.fromKey === key || e.toKey === key)
          .reduce((s, e) => s + e.count, 0);
        return {
          id: node.Id,
          title: node.Title,
          x: cx + Math.cos(angle) * ring,
          y: cy + Math.sin(angle) * ring,
          vx: 0,
          vy: 0,
          degree: degree.get(node.Id) || 0,
          isFolder: true,
          folderKey: key,
          noteCount,
          linkCount,
        };
      });
      simRef.current = seeded;
      setPositions(seeded.map((s) => ({ ...s })));
      return;
    }

    const others = nodes.filter((node) => node.Id !== focusId);
    const ring =
      variant === 'focus'
        ? Math.min(90, Math.max(48, width * 0.32))
        : 100 + Math.min(360, 48 * Math.sqrt(n));

    const seeded: SimNode[] = nodes.map((node, i) => {
      if (variant === 'focus' && focusId != null && node.Id === focusId) {
        return {
          id: node.Id,
          title: node.Title,
          x: cx,
          y: cy,
          vx: 0,
          vy: 0,
          degree: degree.get(node.Id) || 0,
          pinned: true,
          restricted: Boolean(node.Restricted),
          external: Boolean(node.External),
          folderKey: folderModel.noteFolder.get(node.Id),
        };
      }
      const idx = variant === 'focus' ? others.findIndex((o) => o.Id === node.Id) : i;
      const angle = ((idx < 0 ? i : idx) / (others.length || n)) * Math.PI * 2 - Math.PI / 2;
      // In drill mode, keep open-folder notes near center, neighbors farther out
      const inOpen =
        openFolder != null && folderModel.noteFolder.get(node.Id) === openFolder;
      const localRing = openFolder != null ? (inOpen ? ring * 0.55 : ring * 1.05) : ring;
      return {
        id: node.Id,
        title: node.Title,
        x: cx + Math.cos(angle) * localRing + (Math.random() - 0.5) * 20,
        y: cy + Math.sin(angle) * localRing + (Math.random() - 0.5) * 20,
        vx: 0,
        vy: 0,
        degree: degree.get(node.Id) || 0,
        pinned: false,
        restricted: Boolean(node.Restricted),
        external: Boolean(node.External) || (openFolder != null && !inOpen),
        folderKey: folderModel.noteFolder.get(node.Id),
      };
    });
    simRef.current = seeded;
    setPositions(seeded.map((s) => ({ ...s })));
  }, [
    nodes,
    edges,
    metaEdges,
    width,
    height,
    degree,
    focusId,
    variant,
    reloadToken,
    folderOverview,
    folderModel,
    openFolder,
  ]);

  // Force tick
  useEffect(() => {
    if (!nodes.length) return;
    let frame = 0;
    let ticks = 0;
    const edgeList = edges.map((e) => ({ a: e.FromNoteId, b: e.ToNoteId }));
    const folderEdgeList = metaEdges.map((e) => ({
      a: -Math.abs(hashFolderId(e.fromKey)),
      b: -Math.abs(hashFolderId(e.toKey)),
      w: e.count,
    }));

    const minDist = folderOverview ? 160 : variant === 'focus' ? 56 : 100;
    const ideal = folderOverview ? 220 : variant === 'focus' ? 78 : 160;
    const charge = folderOverview ? 1400 : variant === 'focus' ? 380 : 800;
    const gravity = folderOverview ? 0.0008 : variant === 'focus' ? 0.002 : 0.001;
    const worldPad = isFull ? 900 : 36;

    const step = () => {
      const sim = simRef.current;
      if (!sim.length) return;
      const cx = width / 2;
      const cy = height / 2;

      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          let dx = sim[i].x - sim[j].x;
          let dy = sim[i].y - sim[j].y;
          const dist = Math.hypot(dx, dy) || 0.01;
          const f =
            dist < minDist
              ? ((minDist - dist) / dist) * (folderOverview ? 0.22 : 0.14)
              : charge / (dist * dist) / dist;
          dx *= f;
          dy *= f;
          if (sim[i].id !== dragId && !sim[i].pinned) {
            sim[i].vx += dx;
            sim[i].vy += dy;
          }
          if (sim[j].id !== dragId && !sim[j].pinned) {
            sim[j].vx -= dx;
            sim[j].vy -= dy;
          }
        }
      }

      const byId = new Map(sim.map((s) => [s.id, s]));
      const springEdges = folderOverview
        ? folderEdgeList.map((e) => ({ a: e.a, b: e.b, ideal: ideal + Math.min(80, e.w * 4) }))
        : edgeList.map((e) => ({ a: e.a, b: e.b, ideal }));

      for (const e of springEdges) {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const f = (dist - e.ideal) * (folderOverview ? 0.01 : 0.014);
        dx = (dx / dist) * f;
        dy = (dy / dist) * f;
        if (a.id !== dragId && !a.pinned) {
          a.vx += dx;
          a.vy += dy;
        }
        if (b.id !== dragId && !b.pinned) {
          b.vx -= dx;
          b.vy -= dy;
        }
      }

      for (const s of sim) {
        if (s.pinned && s.id !== dragId) {
          s.x = cx;
          s.y = cy;
          s.vx = 0;
          s.vy = 0;
          continue;
        }
        if (s.id === dragId) continue;
        s.vx += (cx - s.x) * gravity;
        s.vy += (cy - s.y) * gravity;
        s.vx *= 0.84;
        s.vy *= 0.84;
        s.x += s.vx;
        s.y += s.vy;
        if (variant === 'focus') {
          s.x = Math.max(36, Math.min(width - 36, s.x));
          s.y = Math.max(24, Math.min(height - 24, s.y));
        } else {
          s.x = Math.max(-worldPad, Math.min(width + worldPad, s.x));
          s.y = Math.max(-worldPad, Math.min(height + worldPad, s.y));
        }
      }

      ticks += 1;
      if (ticks % 2 === 0) setPositions(sim.map((s) => ({ ...s })));
      if (ticks < (folderOverview ? 240 : 260) || dragId != null) {
        frame = requestAnimationFrame(step);
      } else if (isFull && ticks === (folderOverview ? 240 : 260)) {
        // Fit camera to content once layout settles
        fitToContent(sim);
      }
    };

    const fitToContent = (sim: SimNode[]) => {
      if (!sim.length || !wrapRef.current) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const s of sim) {
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x);
        maxY = Math.max(maxY, s.y);
      }
      const pad = 48;
      const bw = Math.max(80, maxX - minX);
      const bh = Math.max(80, maxY - minY);
      const scale = Math.min(
        ZOOM_MAX,
        Math.max(ZOOM_MIN, Math.min((width - pad * 2) / bw, (height - pad * 2) / bh) * 0.92)
      );
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      const nextPan = {
        x: width / 2 - midX * scale,
        y: height / 2 - midY * scale,
      };
      zoomRef.current = scale;
      panRef.current = nextPan;
      setZoom(scale);
      setPan(nextPan);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [nodes, edges, metaEdges, width, height, dragId, variant, reloadToken, folderOverview, isFull]);

  const posMap = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions]);

  const screenToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const z = zoomRef.current;
    const p = panRef.current;
    return { x: (sx - p.x) / z, y: (sy - p.y) / z };
  }, []);

  const applyZoomAt = useCallback((nextZoom: number, clientX: number, clientY: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const z0 = zoomRef.current;
    const z1 = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));
    if (z1 === z0) return;
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    const p0 = panRef.current;
    const wx = (sx - p0.x) / z0;
    const wy = (sy - p0.y) / z0;
    const p1 = { x: sx - wx * z1, y: sy - wy * z1 };
    zoomRef.current = z1;
    panRef.current = p1;
    setZoom(z1);
    setPan(p1);
  }, []);

  const onWheel = (e: React.WheelEvent) => {
    if (!isFull) return;
    e.preventDefault();
    applyZoomAt(zoomRef.current * (e.deltaY > 0 ? 0.9 : 1.1), e.clientX, e.clientY);
  };

  const onBgPointerDown = (e: React.PointerEvent) => {
    if (!isFull || e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('[data-graph-node]')) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    panDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: panRef.current.x,
      originY: panRef.current.y,
    };
    setPanning(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (panDrag.current && isFull) {
      const next = {
        x: panDrag.current.originX + (e.clientX - panDrag.current.startX),
        y: panDrag.current.originY + (e.clientY - panDrag.current.startY),
      };
      panRef.current = next;
      setPan(next);
      return;
    }
    if (dragId == null) return;
    const world = screenToWorld(e.clientX, e.clientY);
    const sim = simRef.current;
    const node = sim.find((s) => s.id === dragId);
    if (!node) return;
    node.x = world.x;
    node.y = world.y;
    node.vx = 0;
    node.vy = 0;
    if (node.pinned) node.pinned = false;
    setPositions(sim.map((s) => ({ ...s })));
  };

  const endPan = () => {
    panDrag.current = null;
    setPanning(false);
  };

  const onNodePointerDown = (id: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragStart.current = { x: e.clientX, y: e.clientY };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragId(id);
  };

  const onNodePointerUp = (id: number, e: React.PointerEvent) => {
    setDragId(null);
    const start = dragStart.current;
    const moved =
      !!start && (Math.abs(e.clientX - start.x) > 4 || Math.abs(e.clientY - start.y) > 4);
    if (moved) return;

    const simNode = positions.find((p) => p.id === id);
    if (useFolders && simNode?.isFolder && simNode.folderKey) {
      setOpenFolder(simNode.folderKey);
      resetCamera();
      return;
    }

    if (!onNodeClick) return;
    const node = baseGraph.nodes.find((n) => n.Id === id);
    if (!node || node.Restricted) return;
    onNodeClick(id, node);
  };

  if (!baseGraph.nodes.length) {
    return (
      <div
        ref={wrapRef}
        className="flex items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface)]/40 text-sm text-[var(--muted)]"
        style={{ height }}
      >
        {variant === 'focus' && focusId == null
          ? 'Select a note to focus the mindmap'
          : 'No linked notes yet'}
      </div>
    );
  }

  const labelMax = compactLegend || width < 280 ? 14 : 22;
  const folderCount = folderModel.folders.size;
  const crossLinks = folderModel.folderEdges.reduce((s, e) => s + e.count, 0);

  return (
    <div
      ref={wrapRef}
      className={`relative overflow-hidden rounded-xl border border-[var(--border)] bg-[radial-gradient(ellipse_at_center,_#132029_0%,_#0a0e13_70%)] ${
        isFull ? (panning ? 'cursor-grabbing' : 'cursor-grab') : ''
      }`}
      style={{ height }}
      onWheel={onWheel}
      onPointerDown={onBgPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => {
        setDragId(null);
        endPan();
      }}
      onPointerLeave={() => {
        setDragId(null);
        endPan();
      }}
    >
      {isFull && (
        <div className="absolute left-2 top-2 z-10 flex max-w-[calc(100%-1rem)] flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)]/90 p-1.5 text-[10px] shadow-lg backdrop-blur">
          <select
            value={viewMode}
            onChange={(e) => {
              const next = e.target.value as GraphViewMode;
              setViewMode(next);
              setOpenFolder(null);
              resetCamera();
            }}
            className="input h-7 px-1.5 py-0 text-[11px]"
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Mindmap view"
            title="Mindmap view"
          >
            <option value="folders">Folders</option>
            <option value="notes">All notes</option>
          </select>
          {useFolders && openFolder != null ? (
            <button
              type="button"
              className="toolbar-btn min-h-7 px-2"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setOpenFolder(null);
                resetCamera();
              }}
            >
              ← Folders
            </button>
          ) : useFolders ? (
            <span className="px-1.5 text-[var(--muted)]">
              {folderCount} folders · {crossLinks} cross-folder links
            </span>
          ) : (
            <span className="px-1.5 text-[var(--muted)]">
              {nodes.length} notes · {edges.length} links
            </span>
          )}
          <input
            type="search"
            value={titleQuery}
            onChange={(e) => setTitleQuery(e.target.value)}
            placeholder={useFolders && openFolder == null ? 'Filter folders…' : 'Filter notes…'}
            className="input h-7 min-w-[7rem] flex-1 px-2 py-0 text-[11px]"
            onPointerDown={(e) => e.stopPropagation()}
          />
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as KindFilter)}
            className="input h-7 px-1.5 py-0 text-[11px]"
            onPointerDown={(e) => e.stopPropagation()}
            aria-label="Filter by link kind"
          >
            <option value="wikilink">Wikilinks</option>
            <option value="all">All links</option>
            <option value="mention">Mentions</option>
            <option value="other">Other</option>
          </select>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              className="toolbar-btn min-h-7 px-2"
              title="Zoom out"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const rect = wrapRef.current?.getBoundingClientRect();
                if (!rect) return;
                applyZoomAt(zoomRef.current * 0.85, rect.left + rect.width / 2, rect.top + rect.height / 2);
              }}
            >
              −
            </button>
            <button
              type="button"
              className="toolbar-btn min-h-7 px-2"
              title="Zoom in"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const rect = wrapRef.current?.getBoundingClientRect();
                if (!rect) return;
                applyZoomAt(zoomRef.current * 1.15, rect.left + rect.width / 2, rect.top + rect.height / 2);
              }}
            >
              +
            </button>
            <button
              type="button"
              className="toolbar-btn min-h-7 px-2"
              title="Reset view"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={resetCamera}
            >
              Reset
            </button>
          </div>
          <span className="px-1 text-[var(--muted)]">{Math.round(zoom * 100)}%</span>
          {useFolders && openFolder != null ? (
            <span className="px-1 font-medium text-[var(--accent-soft)]">
              {folderLabel(openFolder)}
            </span>
          ) : null}
        </div>
      )}

      <svg width={width} height={height} className="block touch-none select-none">
        <defs>
          <filter id={`node-glow-${variant}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
          {folderOverview
            ? metaEdges.map((e) => {
                const a = posMap.get(-Math.abs(hashFolderId(e.fromKey)));
                const b = posMap.get(-Math.abs(hashFolderId(e.toKey)));
                if (!a || !b) return null;
                const color = kindColor(e.kind);
                const sw = Math.min(8, 1.5 + Math.sqrt(e.count));
                return (
                  <g key={`${e.fromKey}-${e.toKey}`}>
                    <line
                      x1={a.x}
                      y1={a.y}
                      x2={b.x}
                      y2={b.y}
                      stroke={color}
                      strokeOpacity={0.55}
                      strokeWidth={sw / Math.sqrt(zoom)}
                    />
                    <title>
                      {folderLabel(e.fromKey)} ↔ {folderLabel(e.toKey)} · {e.count} links
                    </title>
                  </g>
                );
              })
            : edges.map((e, i) => {
                const a = posMap.get(e.FromNoteId);
                const b = posMap.get(e.ToNoteId);
                if (!a || !b) return null;
                const crossFolder =
                  openFolder != null &&
                  (a.folderKey !== openFolder || b.folderKey !== openFolder);
                const color = kindColor(e.Kind);
                return (
                  <path
                    key={`${e.FromNoteId}-${e.ToNoteId}-${e.Kind}-${i}`}
                    d={`M ${a.x} ${a.y} L ${b.x} ${b.y}`}
                    fill="none"
                    stroke={color}
                    strokeOpacity={crossFolder ? 0.25 : 0.55}
                    strokeWidth={(crossFolder ? 1 : e.Kind === 'wikilink' ? 2 : 1.25) / Math.sqrt(zoom)}
                    strokeDasharray={e.Kind === 'mention' ? '4 4' : undefined}
                  />
                );
              })}

          {positions.map((p) => {
            if (p.isFolder) {
              const r = 22 + Math.min(18, (p.noteCount || 1) * 2.2);
              return (
                <g
                  key={p.id}
                  data-graph-node
                  transform={`translate(${p.x},${p.y})`}
                  style={{ cursor: 'pointer' }}
                  onPointerDown={(e) => onNodePointerDown(p.id, e)}
                  onPointerUp={(e) => onNodePointerUp(p.id, e)}
                >
                  <title>
                    {p.title} — {p.noteCount} notes · {p.linkCount || 0} links to other folders.
                    Click to open.
                  </title>
                  <circle r={r + 8} fill="rgba(20,184,166,0.12)" />
                  <circle r={r} fill="#132029" stroke="#5eead4" strokeWidth={2.5} />
                  <text
                    textAnchor="middle"
                    y={-4}
                    fill="#e8eef6"
                    fontSize={12}
                    fontFamily="DM Sans, sans-serif"
                    fontWeight={700}
                  >
                    {p.title.length > 16 ? `${p.title.slice(0, 15)}…` : p.title}
                  </text>
                  <text
                    textAnchor="middle"
                    y={12}
                    fill="#8b98a8"
                    fontSize={10}
                    fontFamily="DM Sans, sans-serif"
                  >
                    {p.noteCount} notes
                  </text>
                </g>
              );
            }

            const focused = focusId === p.id;
            const inOpen = openFolder == null || p.folderKey === openFolder;
            const r = (focused ? 12 : 8) + Math.min(6, p.degree);
            const restricted = Boolean(p.restricted);
            const external = Boolean(p.external) || !inOpen;
            const fill = restricted
              ? '#1a1f24'
              : focused
                ? '#14b8a6'
                : external
                  ? '#15202a'
                  : '#1a2a36';
            const stroke = restricted
              ? '#64748b'
              : focused
                ? '#5eead4'
                : external
                  ? '#64748b'
                  : '#2dd4bf';
            const label =
              p.title.length > labelMax ? `${p.title.slice(0, labelMax - 1)}…` : p.title;

            return (
              <g
                key={p.id}
                data-graph-node
                transform={`translate(${p.x},${p.y})`}
                style={{ cursor: restricted ? 'not-allowed' : onNodeClick ? 'pointer' : 'grab' }}
                opacity={restricted ? 0.72 : external ? 0.55 : 1}
                onPointerDown={(e) => onNodePointerDown(p.id, e)}
                onPointerUp={(e) => onNodePointerUp(p.id, e)}
              >
                <title>
                  {restricted
                    ? `${p.title} — no access`
                    : external
                      ? `${p.title} (${p.folderKey || 'other folder'})`
                      : p.title}
                </title>
                <circle
                  r={r + 5}
                  fill={
                    focused ? 'rgba(20,184,166,0.28)' : 'rgba(20,184,166,0.06)'
                  }
                  filter={focused && !restricted ? `url(#node-glow-${variant})` : undefined}
                />
                <circle
                  r={r}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={focused ? 2.5 : 1.5}
                  strokeDasharray={restricted || external ? '3 2' : undefined}
                />
                <text
                  y={r + 12}
                  textAnchor="middle"
                  fill={restricted || external ? '#94a3b8' : '#e8eef6'}
                  fontSize={compactLegend ? 10 : 11}
                  fontFamily="DM Sans, sans-serif"
                  fontWeight={focused ? 700 : 500}
                >
                  {label}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {!compactLegend && (
        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-3 text-[10px] text-[var(--muted)]">
          {folderOverview ? (
            <>
              <span>Folder clusters</span>
              <span>
                <span className="mr-1 inline-block h-0.5 w-3 bg-teal-300 align-middle" /> Cross-folder
                links
              </span>
              <span>Click a folder to open · drag background to pan</span>
            </>
          ) : useFolders ? (
            <>
              <span>
                <span className="mr-1 inline-block h-0.5 w-3 bg-teal-300 align-middle" /> Wikilink
              </span>
              <span>Dashed = other folder · ← Folders to go back</span>
            </>
          ) : (
            <>
              <span>
                <span className="mr-1 inline-block h-0.5 w-3 bg-teal-300 align-middle" /> Wikilink
              </span>
              <span>
                <span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-sky-300 align-middle" />{' '}
                Mention
              </span>
              <span>All-notes view · pan / zoom · click to open</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function hashFolderId(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) | 0;
  }
  return h === 0 ? 1 : h;
}
