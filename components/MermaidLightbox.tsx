'use client';

import { useEffect } from 'react';

interface MermaidLightboxProps {
  svgHtml: string | null;
  onClose: () => void;
}

export default function MermaidLightbox({ svgHtml, onClose }: MermaidLightboxProps) {
  useEffect(() => {
    if (!svgHtml) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [svgHtml, onClose]);

  if (!svgHtml) return null;

  return (
    <div
      className="synapse-mermaid-lightbox fixed inset-0 z-[80] flex flex-col bg-black/85 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram fullscreen"
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
        <p className="text-sm text-white/70">Scroll to pan · Esc to close</p>
        <button
          type="button"
          className="rounded-lg bg-white/10 px-3 py-1.5 text-sm text-white transition hover:bg-white/20"
          onClick={onClose}
          aria-label="Close"
        >
          Close · Esc
        </button>
      </div>
      <div
        className="synapse-mermaid-lightbox-stage min-h-0 flex-1 overflow-auto p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="synapse-mermaid synapse-mermaid-lightbox-body inline-block min-w-full"
          // SVG already rendered by Mermaid; clone for fullscreen reading only
          dangerouslySetInnerHTML={{ __html: svgHtml }}
        />
      </div>
    </div>
  );
}
