'use client';

import { useEffect, useMemo, useState } from 'react';

type TransferMode = 'copy' | 'move';

interface VaultOption {
  Id: number;
  Name: string;
  slug?: string;
}

interface NoteTransferModalProps {
  open: boolean;
  vaultId: string;
  noteId: number;
  noteTitle: string;
  onClose: () => void;
  onDone: (result: {
    vaultId: number;
    noteId: number;
    mode: TransferMode;
    createdVault?: boolean;
  }) => void;
}

export default function NoteTransferModal({
  open,
  vaultId,
  noteId,
  noteTitle,
  onClose,
  onDone,
}: NoteTransferModalProps) {
  const [mode, setMode] = useState<TransferMode>('copy');
  const [vaults, setVaults] = useState<VaultOption[]>([]);
  const [query, setQuery] = useState('');
  const [targetVaultId, setTargetVaultId] = useState<number | null>(null);
  const [createNew, setCreateNew] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setMode('copy');
    setQuery('');
    setTargetVaultId(null);
    setCreateNew(false);
    setNewVaultName(noteTitle ? `${noteTitle} vault` : '');
    setError('');
    void (async () => {
      const res = await fetch('/api/vaults', { credentials: 'include' });
      const data = await res.json();
      if (res.ok) {
        const list = (Array.isArray(data.data) ? data.data : []).filter(
          (v: VaultOption) => Number(v.Id) !== Number(vaultId)
        );
        setVaults(list);
      }
    })();
  }, [open, vaultId, noteTitle]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return vaults;
    return vaults.filter(
      (v) =>
        String(v.Name || '')
          .toLowerCase()
          .includes(q) ||
        String(v.slug || '')
          .toLowerCase()
          .includes(q)
    );
  }, [vaults, query]);

  if (!open) return null;

  const canSubmit = createNew
    ? newVaultName.trim().length > 0
    : targetVaultId != null;

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError('');
    try {
      const body = createNew
        ? { mode, newVault: { name: newVaultName.trim() } }
        : { mode, targetVaultId };
      const res = await fetch(`/api/vaults/${vaultId}/notes/${noteId}/transfer`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || 'Transfer failed');
        return;
      }
      onDone({
        vaultId: Number(data.data.vaultId),
        noteId: Number(data.data.noteId),
        mode,
        createdVault: Boolean(data.data.createdVault),
      });
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl shadow-black/40"
      >
        <div className="border-b border-[var(--border)] px-5 py-4">
          <h2 className="text-lg font-semibold tracking-tight text-[var(--text)]">Send note</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Copy or move <span className="text-[var(--text)]">{noteTitle || 'this note'}</span> to
            another vault. Media in the note is included; Planner links are not.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Action
            </legend>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  mode === 'copy'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]'
                    : 'border-[var(--border)] text-[var(--muted)]'
                }`}
                onClick={() => setMode('copy')}
              >
                Copy
              </button>
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  mode === 'move'
                    ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]'
                    : 'border-[var(--border)] text-[var(--muted)]'
                }`}
                onClick={() => setMode('move')}
              >
                Move
              </button>
            </div>
            {mode === 'move' && (
              <p className="mt-2 text-xs text-[var(--muted)]">
                The original note will be moved to trash in this vault after a successful transfer.
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Destination
            </legend>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  !createNew
                    ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]'
                    : 'border-[var(--border)] text-[var(--muted)]'
                }`}
                onClick={() => setCreateNew(false)}
              >
                Existing vault
              </button>
              <button
                type="button"
                className={`rounded-lg border px-3 py-1.5 text-sm ${
                  createNew
                    ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]'
                    : 'border-[var(--border)] text-[var(--muted)]'
                }`}
                onClick={() => setCreateNew(true)}
              >
                New vault
              </button>
            </div>

            {createNew ? (
              <label className="mt-3 block text-xs font-medium text-[var(--muted)]">
                Vault name
                <input
                  className="input mt-1.5 w-full"
                  value={newVaultName}
                  onChange={(e) => setNewVaultName(e.target.value)}
                  placeholder="New vault"
                  autoFocus
                />
              </label>
            ) : (
              <div className="mt-3 space-y-2">
                <input
                  className="input w-full"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search vaults…"
                  aria-label="Search vaults"
                />
                <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border border-[var(--border)] p-1">
                  {filtered.length === 0 && (
                    <li className="px-2 py-3 text-center text-sm text-[var(--muted)]">
                      No other editable vaults
                    </li>
                  )}
                  {filtered.map((v) => (
                    <li key={v.Id}>
                      <button
                        type="button"
                        className={`w-full rounded-md px-2 py-1.5 text-left text-sm ${
                          targetVaultId === Number(v.Id)
                            ? 'bg-[var(--accent)]/20 text-[var(--text)]'
                            : 'text-[var(--text)] hover:bg-[var(--surface-2)]'
                        }`}
                        onClick={() => setTargetVaultId(Number(v.Id))}
                      >
                        {v.Name}
                        {v.slug ? (
                          <span className="ml-1 text-[11px] text-[var(--muted)]">/{v.slug}</span>
                        ) : null}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </fieldset>

          {error && <p className="text-sm text-[var(--danger)]">{error}</p>}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--border)] px-5 py-4">
          <button type="button" className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!canSubmit || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Working…' : mode === 'move' ? 'Move note' : 'Copy note'}
          </button>
        </div>
      </div>
    </div>
  );
}
