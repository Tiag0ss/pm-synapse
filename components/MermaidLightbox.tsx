'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

interface MermaidLightboxProps {
  svgHtml: string | null;
  onClose: () => void;
}

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.15;
/** Leave a little margin so the diagram is fully visible. */
const FIT_PADDING = 0.9;

type Pan = { x: number; y: number };
type Size = { w: number; h: number };

function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/**
 * Measure the diagram’s painted CSS size at scale(1).
 * Prefer the wrapper box (includes padding) over viewBox units — mermaid
 * viewBox/width often disagree with what is actually drawn.
 */
function measureNaturalSize(body: HTMLElement, svg: SVGSVGElement): Size | null {
  const prev = body.style.transform;
  body.style.transform = 'translate(0px, 0px) scale(1)';
  body.style.transformOrigin = '0 0';
  void body.offsetWidth;
  const bodyRect = body.getBoundingClientRect();
  const svgRect = svg.getBoundingClientRect();
  body.style.transform = prev;
  const w = Math.max(bodyRect.width, svgRect.width);
  const h = Math.max(bodyRect.height, svgRect.height);
  if (w < 1 || h < 1) return null;
  return { w, h };
}

export default function MermaidLightbox({ svgHtml, onClose }: MermaidLightboxProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const naturalRef = useRef<Size | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [zoomEnabled, setZoomEnabled] = useState(true);
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [natural, setNatural] = useState<Size | null>(null);
  const [stageSize, setStageSize] = useState<Size>({ w: 0, h: 0 });

  const fitToStage = useCallback(() => {
    const stage = stageRef.current;
    const body = bodyRef.current;
    if (!stage || !body) return;
    const svg = body.querySelector('svg');
    if (!svg) return;

    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    if (stageW < 1 || stageH < 1) return;
    setStageSize({ w: stageW, h: stageH });

    const size = measureNaturalSize(body, svg);
    if (!size) return;

    naturalRef.current = size;
    setNatural(size);

    const fit = clampZoom(Math.min(stageW / size.w, stageH / size.h) * FIT_PADDING);
    setZoom(fit);
    setPan({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    setZoomEnabled(true);
    setDragging(false);
    dragRef.current = null;
    naturalRef.current = null;
    setNatural(null);
  }, [svgHtml]);

  useLayoutEffect(() => {
    if (!svgHtml) return;
    let cancelled = false;
    const run = () => {
      if (!cancelled) fitToStage();
    };
    const id1 = requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
      // Mermaid labels / foreignObject sometimes settle late
      window.setTimeout(run, 50);
      window.setTimeout(run, 150);
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id1);
    };
  }, [svgHtml, fitToStage]);

  useEffect(() => {
    if (!svgHtml) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (!zoomEnabled) return;
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setZoom((z) => clampZoom(z * ZOOM_STEP));
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setZoom((z) => clampZoom(z / ZOOM_STEP));
      }
      if (e.key === '0') {
        e.preventDefault();
        fitToStage();
      }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [svgHtml, onClose, zoomEnabled, fitToStage]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !svgHtml) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (zoomEnabled && (e.ctrlKey || e.metaKey)) {
        const factor = e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
        setZoom((z) => clampZoom(z * factor));
        return;
      }
      setPan((p) => ({
        x: p.x - e.deltaX,
        y: p.y - e.deltaY,
      }));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [svgHtml, zoomEnabled]);

  useEffect(() => {
    if (!svgHtml) return;
    const onResize = () => fitToStage();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [svgHtml, fitToStage]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const stage = stageRef.current;
      if (!stage) return;
      e.preventDefault();
      dragRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        originX: pan.x,
        originY: pan.y,
      };
      stage.setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [pan.x, pan.y]
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    setPan({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const stage = stageRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (stage?.hasPointerCapture(e.pointerId)) {
      stage.releasePointerCapture(e.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  }, []);

  if (!svgHtml) return null;

  const scale = zoomEnabled ? zoom : 1;
  const nw = natural?.w ?? 0;
  const nh = natural?.h ?? 0;
  const stageW = stageSize.w;
  const stageH = stageSize.h;
  // Pixel center: avoids translate(-50%)+scale clipping some diagram types
  const baseX = nw > 0 && stageW > 0 ? (stageW - nw * scale) / 2 : 0;
  const baseY = nh > 0 && stageH > 0 ? (stageH - nh * scale) / 2 : 0;

  return (
    <div
      className="synapse-mermaid-lightbox fixed inset-0 z-[80] flex flex-col bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram fullscreen"
      onClick={onClose}
    >
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-2.5">
        <p className="text-sm text-white/70">
          {zoomEnabled
            ? 'Drag to pan · Ctrl/Cmd+wheel to zoom · Esc to close'
            : 'Drag to pan · Esc to close'}
        </p>
        <div className="flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`rounded-lg px-3 py-1.5 text-sm transition ${
              zoomEnabled ? 'bg-white/20 text-white' : 'bg-white/10 text-white/70 hover:bg-white/15'
            }`}
            aria-pressed={zoomEnabled}
            title={zoomEnabled ? 'Disable zoom' : 'Enable zoom'}
            onClick={() => setZoomEnabled((v) => !v)}
          >
            Zoom {zoomEnabled ? 'on' : 'off'}
          </button>
          <button
            type="button"
            className="rounded-lg bg-white/10 px-2.5 py-1.5 text-sm text-white transition hover:bg-white/20 disabled:opacity-40"
            disabled={!zoomEnabled || zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))}
          >
            −
          </button>
          <span className="min-w-[3.25rem] text-center tabular-nums text-sm text-white/80">
            {Math.round(scale * 100)}%
          </span>
          <button
            type="button"
            className="rounded-lg bg-white/10 px-2.5 py-1.5 text-sm text-white transition hover:bg-white/20 disabled:opacity-40"
            disabled={!zoomEnabled || zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))}
          >
            +
          </button>
          <button
            type="button"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white transition hover:bg-white/20"
            title="Fit diagram to screen"
            onClick={() => fitToStage()}
          >
            Fit
          </button>
          <button
            type="button"
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white transition hover:bg-white/20"
            onClick={onClose}
            aria-label="Close"
          >
            Close
          </button>
        </div>
      </div>
      <div
        ref={stageRef}
        className={`synapse-mermaid-lightbox-stage relative min-h-0 flex-1 overflow-hidden touch-none select-none ${
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        }`}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div
          ref={bodyRef}
          className="synapse-mermaid synapse-mermaid-lightbox-body absolute left-0 top-0 will-change-transform"
          style={{
            transform: `translate(${baseX + pan.x}px, ${baseY + pan.y}px) scale(${scale})`,
            transformOrigin: '0 0',
          }}
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      </div>
    </div>
  );
}
