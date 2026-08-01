'use client';

import { useEffect, useState } from 'react';

interface PromptModalProps {
  open: boolean;
  title: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

export default function PromptModal({
  open,
  title,
  label,
  placeholder,
  initialValue = '',
  confirmLabel = 'Create',
  onConfirm,
  onCancel,
}: PromptModalProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl shadow-black/40"
        onSubmit={(e) => {
          e.preventDefault();
          if (!value.trim()) return;
          onConfirm(value.trim());
        }}
      >
        <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">{title}</h2>
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          {label}
          <input
            autoFocus
            className="input mt-1.5 w-full"
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!value.trim()}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
