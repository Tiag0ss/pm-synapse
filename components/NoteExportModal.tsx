'use client';

import { useEffect, useState } from 'react';

type ExportTemplate = {
  id: number;
  label: string;
  description: string | null;
  originalName: string;
};

interface NoteExportModalProps {
  open: boolean;
  vaultId: string;
  noteId: number | null;
  noteTitle: string;
  /** Flush unsaved editor changes before export (server reads DB). */
  onBeforeExport?: () => Promise<boolean>;
  onClose: () => void;
}

export default function NoteExportModal({
  open,
  vaultId,
  noteId,
  noteTitle,
  onBeforeExport,
  onClose,
}: NoteExportModalProps) {
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setLoading(true);
    void (async () => {
      try {
        const res = await fetch('/api/export-templates', { credentials: 'include' });
        const json = await res.json();
        if (!res.ok) {
          setError(json.message || 'Failed to load templates');
          setTemplates([]);
          return;
        }
        const list = (json.data || []) as ExportTemplate[];
        setTemplates(list);
        setSelectedId(list[0]?.id ?? null);
      } catch {
        setError('Network error');
      } finally {
        setLoading(false);
      }
    })();
  }, [open]);

  if (!open) return null;

  const download = async () => {
    if (!noteId || selectedId == null) return;
    setBusy(true);
    setError('');
    try {
      if (onBeforeExport) {
        const ok = await onBeforeExport();
        if (!ok) {
          setError('Save failed — fix save errors before exporting');
          return;
        }
      }
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/export-docx`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exportTemplateId: selectedId }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.message || 'Export failed');
        return;
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/i.exec(disp);
      const name = match?.[1] || `${noteTitle || 'note'}.docx`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal
        aria-labelledby="note-export-title"
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 id="note-export-title" className="text-lg font-semibold tracking-tight">
              Export to Word
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Fill an app Word template with this note and its frontmatter
              {noteTitle ? ` · ${noteTitle}` : ''}
            </p>
          </div>
          <button type="button" className="btn-ghost py-1" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          {error && (
            <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
          {loading ? (
            <p className="text-sm text-[var(--muted)]">Loading templates…</p>
          ) : templates.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">
              No Word templates yet. An admin can upload them under Settings → Word export.
            </p>
          ) : (
            <label className="block text-sm">
              Template
              <select
                className="input mt-1 w-full"
                value={selectedId ?? ''}
                onChange={(e) => setSelectedId(Number(e.target.value) || null)}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                    {t.description ? ` — ${t.description}` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-[11px] text-[var(--muted)]">
            Use Carbone markers such as {'{d.title}'}, {'{d.body}'}, {'{d.fm.<key>}'}, and{' '}
            {'{d.<list>[i].<field>}'} for grids. See Settings → Word export → How to create
            templates.
          </p>
        </div>

        <footer className="flex justify-end gap-2 border-t border-[var(--border)] px-5 py-3">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !noteId || selectedId == null || templates.length === 0}
            onClick={() => void download()}
          >
            {busy ? 'Exporting…' : 'Download DOCX'}
          </button>
        </footer>
      </div>
    </div>
  );
}
