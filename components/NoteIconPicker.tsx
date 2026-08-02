'use client';

import { useEffect, useRef, useState } from 'react';
import NoteIcon from '@/components/NoteIcon';
import { NOTE_ICON_IDS, type NoteIconId } from '@/lib/noteIcons';

interface NoteIconPickerProps {
  value: NoteIconId | null;
  onChange: (icon: NoteIconId | null) => void;
  disabled?: boolean;
}

export default function NoteIconPicker({ value, onChange, disabled }: NoteIconPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        disabled={disabled}
        className="btn-ghost flex h-10 w-10 items-center justify-center p-0"
        title="Note icon"
        aria-label="Choose note icon"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <NoteIcon icon={value} size={18} className="text-[var(--accent-soft)]" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-[17.5rem] rounded-xl border border-[var(--border)] bg-[var(--panel)] p-2 shadow-2xl shadow-black/40">
          <div className="mb-2 flex items-center justify-between gap-2 px-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Note icon
            </p>
            <button
              type="button"
              className="text-[11px] text-[var(--accent-soft)]"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              Default
            </button>
          </div>
          <div className="grid max-h-56 grid-cols-6 gap-1 overflow-auto">
            {NOTE_ICON_IDS.map((id) => {
              const selected = value === id || (!value && id === 'note');
              return (
                <button
                  key={id}
                  type="button"
                  title={id}
                  className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${
                    selected
                      ? 'bg-[var(--surface-2)] ring-1 ring-[var(--accent)]/50 text-[var(--accent-soft)]'
                      : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                  }`}
                  onClick={() => {
                    onChange(id === 'note' ? null : id);
                    setOpen(false);
                  }}
                >
                  <NoteIcon icon={id} size={16} />
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
