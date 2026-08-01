'use client';

import { useEffect } from 'react';

interface ImageLightboxProps {
  src: string | null;
  alt?: string;
  onClose: () => void;
}

export default function ImageLightbox({ src, alt, onClose }: ImageLightboxProps) {
  useEffect(() => {
    if (!src) return;
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
  }, [src, onClose]);

  if (!src) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={alt || 'Image preview'}
      onClick={onClose}
    >
      <button
        type="button"
        className="absolute right-4 top-4 rounded-lg bg-black/50 px-3 py-1.5 text-sm text-white transition hover:bg-black/70"
        onClick={onClose}
        aria-label="Close"
      >
        Close · Esc
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || ''}
        className="max-h-[92vh] max-w-[96vw] rounded-lg object-contain shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
