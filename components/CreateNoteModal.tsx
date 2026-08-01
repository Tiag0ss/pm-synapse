'use client';

import { useEffect, useState } from 'react';
import { NOTE_TEMPLATES, type NoteTemplateId } from '@/lib/noteTemplates';

interface CreateNoteModalProps {
  open: boolean;
  onCancel: () => void;
  onConfirm: (title: string, templateId: NoteTemplateId) => void;
}

export default function CreateNoteModal({ open, onCancel, onConfirm }: CreateNoteModalProps) {
  const [title, setTitle] = useState('');
  const [templateId, setTemplateId] = useState<NoteTemplateId>('blank');

  useEffect(() => {
    if (open) {
      setTitle('');
      setTemplateId('blank');
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <form
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl shadow-black/40"
        onSubmit={(e) => {
          e.preventDefault();
          if (!title.trim()) return;
          onConfirm(title.trim(), templateId);
        }}
      >
        <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">New note</h2>
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
          Title
          <input
            autoFocus
            className="input mt-1.5 w-full"
            placeholder="meta/risks or Meeting notes"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <fieldset className="mt-4">
          <legend className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
            Template
          </legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {NOTE_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`rounded-lg border px-3 py-2 text-left transition ${
                  templateId === t.id
                    ? 'border-[var(--accent)] bg-[var(--surface-2)]'
                    : 'border-[var(--border)] hover:bg-[var(--surface)]/60'
                }`}
                onClick={() => setTemplateId(t.id)}
              >
                <span className="block text-sm font-medium text-[var(--text)]">{t.label}</span>
                <span className="mt-0.5 block text-[11px] text-[var(--muted)]">{t.description}</span>
              </button>
            ))}
          </div>
        </fieldset>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!title.trim()}>
            Create
          </button>
        </div>
      </form>
    </div>
  );
}
