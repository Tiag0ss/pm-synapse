'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

export interface GraphNode {
  Id: number;
  Title: string;
  Path?: string;
  VaultId?: number;
  VaultSlug?: string | null;
  VaultName?: string | null;
  /** True when the viewer cannot open this note's vault */
  Restricted?: boolean;
  /** True when the note lives outside the current vault graph */
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
  /** focus = neighborhood around current note; full = entire vault */
  variant?: 'focus' | 'full';
  /** Change to force a full re-layout (e.g. after save) */
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
}

function kindColor(kind: string): string {
  if (kind === 'wikilink') return '#5eead4';
  if (kind === 'mention') return '#7dd3fc';
  return '#94a3b8';
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
  // Always keep focus note even if missing from nodes list briefly
  if (!filteredNodes.some((n) => n.Id === focusId)) {
    const focus = nodes.find((n) => n.Id === focusId);
    if (focus) filteredNodes.unshift(focus);
  }
  const filteredEdges = edges.filter(
    (e) => neighborIds.has(e.FromNoteId) && neighborIds.has(e.ToNoteId)
  );
  return { nodes: filteredNodes, edges: filteredEdges };
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
  const dragOffset = useRef({ x: 0, y: 0 });
  const simRef = useRef<SimNode[]>([]);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  const { nodes, edges } = useMemo(() => {
    if (variant === 'focus') return egoSubgraph(allNodes, allEdges, focusId);
    return { nodes: allNodes, edges: allEdges };
  }, [allNodes, allEdges, variant, focusId]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setWidth(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);

  const degree = useMemo(() => {
    const d = new Map<number, number>();
    for (const n of nodes) d.set(n.Id, 0);
    for (const e of edges) {
      d.set(e.FromNoteId, (d.get(e.FromNoteId) || 0) + 1);
      d.set(e.ToNoteId, (d.get(e.ToNoteId) || 0) + 1);
    }
    return d;
  }, [nodes, edges]);

  // Seed / rebuild simulation when graph or focus changes
  useEffect(() => {
    const cx = width / 2;
    const cy = height / 2;
    const others = nodes.filter((n) => n.Id !== focusId);
    const n = others.length || 1;
    const ring = variant === 'focus' ? Math.min(90, Math.max(48, width * 0.32)) : 40 + Math.min(160, 28 * Math.sqrt(nodes.length || 1));

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
        };
      }
      const idx = variant === 'focus' ? others.findIndex((o) => o.Id === node.Id) : i;
      const angle = ((idx < 0 ? i : idx) / n) * Math.PI * 2 - Math.PI / 2;
      return {
        id: node.Id,
        title: node.Title,
        x: cx + Math.cos(angle) * ring + (Math.random() - 0.5) * 8,
        y: cy + Math.sin(angle) * ring + (Math.random() - 0.5) * 8,
        vx: 0,
        vy: 0,
        degree: degree.get(node.Id) || 0,
        pinned: false,
        restricted: Boolean(node.Restricted),
        external: Boolean(node.External),
      };
    });
    simRef.current = seeded;
    setPositions(seeded.map((s) => ({ ...s })));
  }, [nodes, edges, width, height, degree, focusId, variant, reloadToken]);

  // Force simulation tick
  useEffect(() => {
    if (!nodes.length) return;
    let frame = 0;
    let ticks = 0;
    const edgeList = edges.map((e) => ({
      a: e.FromNoteId,
      b: e.ToNoteId,
    }));

    const step = () => {
      const sim = simRef.current;
      if (!sim.length) return;
      const cx = width / 2;
      const cy = height / 2;

      for (let i = 0; i < sim.length; i++) {
        for (let j = i + 1; j < sim.length; j++) {
          let dx = sim[i].x - sim[j].x;
          let dy = sim[i].y - sim[j].y;
          let dist = Math.hypot(dx, dy) || 0.01;
          const minDist = variant === 'focus' ? 56 : 70;
          const f =
            dist < minDist
              ? ((minDist - dist) / dist) * 0.1
              : 380 / (dist * dist) / dist;
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
      for (const e of edgeList) {
        const a = byId.get(e.a);
        const b = byId.get(e.b);
        if (!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const ideal = variant === 'focus' ? 78 : 110;
        const f = (dist - ideal) * 0.018;
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
        s.vx += (cx - s.x) * (variant === 'focus' ? 0.002 : 0.004);
        s.vy += (cy - s.y) * (variant === 'focus' ? 0.002 : 0.004);
        s.vx *= 0.8;
        s.vy *= 0.8;
        s.x += s.vx;
        s.y += s.vy;
        s.x = Math.max(36, Math.min(width - 36, s.x));
        s.y = Math.max(24, Math.min(height - 24, s.y));
      }

      ticks += 1;
      if (ticks % 2 === 0) setPositions(sim.map((s) => ({ ...s })));
      if (ticks < 200 || dragId != null) {
        frame = requestAnimationFrame(step);
      }
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [nodes, edges, width, height, dragId, variant, reloadToken]);

  const posMap = useMemo(() => new Map(positions.map((p) => [p.id, p])), [positions]);

  const onPointerDown = (id: number, e: React.PointerEvent) => {
    e.preventDefault();
    const p = posMap.get(id);
    if (!p) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragId(id);
    dragOffset.current = { x: e.clientX - p.x, y: e.clientY - p.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (dragId == null) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const sim = simRef.current;
    const node = sim.find((s) => s.id === dragId);
    if (!node) return;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    if (node.pinned) node.pinned = false;
    setPositions(sim.map((s) => ({ ...s })));
  };

  const onPointerUp = (id: number, moved: boolean) => {
    setDragId(null);
    if (moved || !onNodeClick) return;
    const node = nodes.find((n) => n.Id === id);
    if (!node || node.Restricted) return;
    onNodeClick(id, node);
  };

  if (!nodes.length) {
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

  return (
    <div
      ref={wrapRef}
      className="relative overflow-hidden rounded-xl border border-[var(--border)] bg-[radial-gradient(ellipse_at_center,_#132029_0%,_#0a0e13_70%)]"
      style={{ height }}
      onPointerMove={onPointerMove}
      onPointerUp={() => setDragId(null)}
      onPointerLeave={() => setDragId(null)}
    >
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

        {edges.map((e, i) => {
          const a = posMap.get(e.FromNoteId);
          const b = posMap.get(e.ToNoteId);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const nx = -dy * 0.12;
          const ny = dx * 0.12;
          const color = kindColor(e.Kind);
          return (
            <path
              key={`${e.FromNoteId}-${e.ToNoteId}-${e.Kind}-${i}`}
              d={`M ${a.x} ${a.y} Q ${mx + nx} ${my + ny} ${b.x} ${b.y}`}
              fill="none"
              stroke={color}
              strokeOpacity={0.55}
              strokeWidth={e.Kind === 'wikilink' ? 2 : 1.25}
              strokeDasharray={e.Kind === 'mention' ? '4 4' : undefined}
            />
          );
        })}

        {positions.map((p) => {
          const focused = focusId === p.id;
          const r = (focused ? 14 : 9) + Math.min(8, p.degree * 1.5);
          const restricted = Boolean(p.restricted);
          const external = Boolean(p.external);
          const fill = restricted
            ? '#1a1f24'
            : focused
              ? '#14b8a6'
              : external
                ? '#1a2430'
                : '#1a2a36';
          const stroke = restricted
            ? '#64748b'
            : focused
              ? '#5eead4'
              : external
                ? '#38bdf8'
                : '#2dd4bf';
          const label = restricted
            ? `${p.title.length > labelMax - 6 ? `${p.title.slice(0, labelMax - 7)}…` : p.title}`
            : p.title.length > labelMax
              ? `${p.title.slice(0, labelMax - 1)}…`
              : p.title;
          return (
            <g
              key={p.id}
              transform={`translate(${p.x},${p.y})`}
              style={{ cursor: restricted ? 'not-allowed' : onNodeClick ? 'pointer' : 'grab' }}
              opacity={restricted ? 0.72 : 1}
              onPointerDown={(e) => {
                dragStart.current = { x: e.clientX, y: e.clientY };
                onPointerDown(p.id, e);
              }}
              onPointerUp={(e) => {
                const start = dragStart.current;
                const moved =
                  !!start && (Math.abs(e.clientX - start.x) > 4 || Math.abs(e.clientY - start.y) > 4);
                onPointerUp(p.id, moved);
              }}
            >
              <title>
                {restricted
                  ? `${p.title} — You don't have access to this note`
                  : external
                    ? p.title
                    : p.title}
              </title>
              <circle
                r={r + 6}
                fill={
                  restricted
                    ? 'rgba(100,116,139,0.16)'
                    : focused
                      ? 'rgba(20,184,166,0.28)'
                      : 'rgba(20,184,166,0.08)'
                }
                filter={focused && !restricted ? `url(#node-glow-${variant})` : undefined}
              />
              <circle
                r={r}
                fill={fill}
                stroke={stroke}
                strokeWidth={focused ? 2.5 : 1.5}
                strokeDasharray={restricted ? '3 2' : undefined}
              />
              <text
                y={r + 13}
                textAnchor="middle"
                fill={restricted ? '#94a3b8' : '#e8eef6'}
                fontSize={compactLegend ? 10 : 11}
                fontFamily="DM Sans, sans-serif"
                fontWeight={focused ? 700 : 500}
              >
                {label}
              </text>
              {restricted ? (
                <text
                  y={r + 25}
                  textAnchor="middle"
                  fill="#94a3b8"
                  fontSize={9}
                  fontFamily="DM Sans, sans-serif"
                  fontWeight={600}
                >
                  No access
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {!compactLegend && (
        <div className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-3 text-[10px] text-[var(--muted)]">
          <span>
            <span className="mr-1 inline-block h-0.5 w-3 bg-teal-300 align-middle" /> Wikilink
          </span>
          <span>
            <span className="mr-1 inline-block h-0.5 w-3 border-t border-dashed border-sky-300 align-middle" />{' '}
            Mention
          </span>
          <span>
            <span className="mr-1 inline-block h-2 w-2 rounded-full border border-dashed border-slate-400 align-middle" />{' '}
            No access
          </span>
          <span>Drag · click to open</span>
        </div>
      )}
    </div>
  );
}
