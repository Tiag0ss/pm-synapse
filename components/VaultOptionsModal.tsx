'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import VaultPmSettingsModal from '@/components/VaultPmSettingsModal';
import VaultShareModal from '@/components/VaultShareModal';
import ConfirmModal from '@/components/ConfirmModal';
import type { NoteResolveEntry } from '@/lib/notePaths';

type OptionsTab = 'links' | 'share' | 'pm' | 'vault' | 'trash';

interface BrokenLinkItem {
  noteId: number;
  noteTitle: string;
  notePath: string;
  target: string;
  occurrence: number;
}

interface TrashNote {
  Id: number;
  Title: string;
  Path: string;
  DeletedAt?: string;
}

interface VaultOptionsModalProps {
  open: boolean;
  vaultId: string;
  vaultName: string;
  vaultSlug?: string;
  isOwner: boolean;
  canEdit: boolean;
  defaultVisibility?: string;
  pmProjectId?: number | null;
  pmOrganizationId?: number | null;
  initialTab?: OptionsTab;
  notes?: NoteResolveEntry[];
  onClose: () => void;
  onChanged: () => void;
  onStatus?: (msg: string) => void;
  onOpenNote: (noteId: number) => void;
  isPersonalWork?: boolean;
  onCreateMissingNote: (title: string, linkFromNoteId: number) => Promise<void> | void;
}

export default function VaultOptionsModal({
  open,
  vaultId,
  vaultName,
  vaultSlug = '',
  isOwner,
  canEdit,
  defaultVisibility = 'private',
  pmProjectId,
  pmOrganizationId,
  initialTab = 'links',
  notes = [],
  onClose,
  onChanged,
  onStatus,
  onOpenNote,
  onCreateMissingNote,
  isPersonalWork = false,
}: VaultOptionsModalProps) {
  const router = useRouter();
  const [tab, setTab] = useState<OptionsTab>(initialTab);
  const [broken, setBroken] = useState<BrokenLinkItem[]>([]);
  const [uniqueTargets, setUniqueTargets] = useState(0);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linksError, setLinksError] = useState('');
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [linksStatus, setLinksStatus] = useState('');
  const [vaultStatus, setVaultStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deletingVault, setDeletingVault] = useState(false);
  const [trash, setTrash] = useState<TrashNote[]>([]);
  const [loadingTrash, setLoadingTrash] = useState(false);
  const [trashBusy, setTrashBusy] = useState<number | null>(null);
  const [vaultDefaultVis, setVaultDefaultVis] = useState(defaultVisibility || 'private');
  const [savingVis, setSavingVis] = useState(false);
  const [nameDraft, setNameDraft] = useState(vaultName);
  const [savingName, setSavingName] = useState(false);

  useEffect(() => {
    if (!open) return;
    const nextTab =
      initialTab === 'pm' ||
      initialTab === 'vault' ||
      initialTab === 'trash' ||
      initialTab === 'links' ||
      initialTab === 'share'
        ? initialTab
        : 'links';
    const allowed =
      nextTab === 'links' ||
      nextTab === 'vault' ||
      nextTab === 'share' ||
      (canEdit && (nextTab === 'trash' || nextTab === 'pm'));
    setTab(allowed ? nextTab : 'links');
    setVaultStatus('');
    setDeleteConfirm('');
    setVaultDefaultVis((defaultVisibility || 'private').toLowerCase());
    setNameDraft(vaultName);
  }, [open, initialTab, defaultVisibility, vaultName, canEdit]);

  const loadBroken = async () => {
    setLoadingLinks(true);
    setLinksError('');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/broken-links`, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setLinksError(data.message || 'Failed to scan links');
        setBroken([]);
        return;
      }
      setBroken(data.data?.items || []);
      setUniqueTargets(Number(data.data?.uniqueTargets || 0));
    } catch {
      setLinksError('Network error while scanning links');
    } finally {
      setLoadingLinks(false);
    }
  };

  const loadTrash = async () => {
    setLoadingTrash(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes?trash=1`, { credentials: 'include' });
      const data = await res.json();
      if (res.ok) setTrash(data.data || []);
      else setTrash([]);
    } finally {
      setLoadingTrash(false);
    }
  };

  useEffect(() => {
    if (!open || tab !== 'links') return;
    void loadBroken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, vaultId]);

  useEffect(() => {
    if (!open || tab !== 'trash') return;
    void loadTrash();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, vaultId]);

  const grouped = useMemo(() => {
    const map = new Map<number, { noteId: number; noteTitle: string; notePath: string; links: BrokenLinkItem[] }>();
    for (const item of broken) {
      const g = map.get(item.noteId) || {
        noteId: item.noteId,
        noteTitle: item.noteTitle,
        notePath: item.notePath,
        links: [],
      };
      g.links.push(item);
      map.set(item.noteId, g);
    }
    return [...map.values()];
  }, [broken]);

  if (!open) return null;

  const tabs: Array<{ id: OptionsTab; label: string; hidden?: boolean }> = [
    { id: 'links', label: 'Broken links' },
    { id: 'share', label: 'Share', hidden: isPersonalWork },
    { id: 'trash', label: 'Trash', hidden: !canEdit },
    { id: 'pm', label: 'Project Management', hidden: !canEdit || isPersonalWork },
    { id: 'vault', label: 'Vault' },
  ];

  const createMissing = async (item: BrokenLinkItem) => {
    if (!canEdit) return;
    setBusyTarget(`${item.noteId}:${item.target}`);
    setLinksStatus(`Creating “${item.target}”…`);
    try {
      await onCreateMissingNote(item.target, item.noteId);
      setLinksStatus(`Created “${item.target}”`);
      await loadBroken();
      onChanged();
    } catch {
      setLinksStatus('Could not create note');
    } finally {
      setBusyTarget(null);
    }
  };

  const saveVaultName = async () => {
    if (!isOwner) return;
    const next = nameDraft.trim();
    if (!next) {
      setVaultStatus('Name cannot be empty');
      return;
    }
    if (next === vaultName) {
      setVaultStatus('Name unchanged');
      return;
    }
    setSavingName(true);
    setVaultStatus('Saving name…');
    try {
      const res = await fetch(`/api/vaults/${vaultId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVaultStatus(data.message || 'Failed to rename vault');
        return;
      }
      setVaultStatus(`Renamed to “${next}”`);
      onChanged();
    } catch {
      setVaultStatus('Failed to rename vault');
    } finally {
      setSavingName(false);
    }
  };

  const saveDefaultVisibility = async (next: string) => {
    if (!isOwner) return;
    const value = next.toLowerCase();
    setVaultDefaultVis(value);
    setSavingVis(true);
    setVaultStatus('Saving default visibility…');
    try {
      const res = await fetch(`/api/vaults/${vaultId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultVisibility: value }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVaultStatus(data.message || 'Failed to update default visibility');
        setVaultDefaultVis((defaultVisibility || 'private').toLowerCase());
        return;
      }
      setVaultStatus(`Default visibility set to ${value}`);
      onChanged();
    } catch {
      setVaultStatus('Failed to update default visibility');
      setVaultDefaultVis((defaultVisibility || 'private').toLowerCase());
    } finally {
      setSavingVis(false);
    }
  };

  const exportZip = async () => {
    setExporting(true);
    setVaultStatus('Exporting ZIP…');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/export-zip`, { credentials: 'include' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setVaultStatus((data as { message?: string }).message || 'Export failed');
        return;
      }
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = /filename="([^"]+)"/.exec(disp);
      const fileName = match?.[1] || `${vaultName || 'vault'}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      const notes = res.headers.get('X-Synapse-Note-Count') || '?';
      const images = res.headers.get('X-Synapse-Image-Count') || '?';
      setVaultStatus(`Exported ${notes} notes · ${images} images`);
    } catch {
      setVaultStatus('Export failed');
    } finally {
      setExporting(false);
    }
  };

  const leaveVault = async () => {
    const res = await fetch(`/api/vaults/${vaultId}/leave`, {
      method: 'POST',
      credentials: 'include',
    });
    const data = await res.json();
    if (!res.ok) {
      setVaultStatus(data.message || 'Could not leave vault');
      setLeaveOpen(false);
      return;
    }
    setLeaveOpen(false);
    onClose();
    router.push('/');
  };

  const deleteVault = async () => {
    setDeletingVault(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/delete`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName: deleteConfirm }),
      });
      const data = await res.json();
      if (!res.ok) {
        setVaultStatus(data.message || 'Delete failed');
        return;
      }
      setDeleteOpen(false);
      onClose();
      router.push('/');
    } finally {
      setDeletingVault(false);
    }
  };

  const restoreNote = async (id: number) => {
    setTrashBusy(id);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${id}/restore`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setVaultStatus(data.message || 'Restore failed');
        return;
      }
      await loadTrash();
      onChanged();
      setVaultStatus('Note restored');
    } finally {
      setTrashBusy(null);
    }
  };

  const purgeNote = async (id: number) => {
    setTrashBusy(id);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${id}?hard=1`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setVaultStatus(data.message || 'Delete failed');
        return;
      }
      await loadTrash();
      setVaultStatus('Permanently deleted');
    } finally {
      setTrashBusy(null);
    }
  };

  const displayTrashPath = (path: string, id: number) => {
    const prefix = `__trash__/${id}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[min(860px,100dvh)] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl sm:h-[min(860px,92vh)] sm:rounded-2xl pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Vault options</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {vaultName} — links, sharing, trash, export, and Project Management.
            </p>
          </div>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="flex shrink-0 gap-1 border-b border-[var(--border)] px-4 pt-2">
          {tabs
            .filter((t) => !t.hidden)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                className={`rounded-t-lg px-3 py-2 text-sm transition ${
                  tab === t.id
                    ? 'bg-[var(--surface)] font-medium text-[var(--text)] ring-1 ring-[var(--border)]'
                    : 'text-[var(--muted)] hover:text-[var(--text)]'
                }`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'links' && broken.length > 0 ? ` (${broken.length})` : ''}
                {t.id === 'trash' && trash.length > 0 ? ` (${trash.length})` : ''}
              </button>
            ))}
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'links' && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-5 py-3">
                <p className="text-sm text-[var(--muted)]">
                  {loadingLinks
                    ? 'Scanning vault…'
                    : broken.length === 0
                      ? 'No broken [[wikilinks]] found.'
                      : `${broken.length} broken link${broken.length === 1 ? '' : 's'} · ${uniqueTargets} unique target${uniqueTargets === 1 ? '' : 's'}`}
                </p>
                <button
                  type="button"
                  className="btn-ghost py-1 text-xs"
                  disabled={loadingLinks}
                  onClick={() => void loadBroken()}
                >
                  Refresh
                </button>
              </div>
              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-5">
                {linksError && (
                  <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                    {linksError}
                  </p>
                )}
                {!loadingLinks && grouped.length === 0 && !linksError && (
                  <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--muted)]">
                    All wikilinks resolve to existing notes.
                  </p>
                )}
                {grouped.map((g) => (
                  <section
                    key={g.noteId}
                    className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-3"
                  >
                    <button
                      type="button"
                      className="text-left text-sm font-medium text-[var(--accent-soft)] hover:underline"
                      onClick={() => {
                        onOpenNote(g.noteId);
                        onClose();
                      }}
                    >
                      {g.noteTitle}
                    </button>
                    <p className="mt-0.5 font-mono text-[11px] text-[var(--muted)]">
                      {g.notePath.replace(/\.md$/i, '')}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {g.links.map((link) => (
                        <li
                          key={`${link.noteId}:${link.target}`}
                          className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-2)]/60"
                        >
                          <code className="min-w-0 flex-1 truncate text-xs text-[var(--danger)]">
                            [[{link.target}]]
                          </code>
                          {canEdit && (
                            <button
                              type="button"
                              className="btn-primary py-1 text-xs"
                              disabled={busyTarget === `${link.noteId}:${link.target}`}
                              onClick={() => void createMissing(link)}
                            >
                              {busyTarget === `${link.noteId}:${link.target}`
                                ? 'Creating…'
                                : 'Create note'}
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
              {linksStatus && (
                <footer className="shrink-0 border-t border-[var(--border)] px-5 py-2 text-xs text-[var(--muted)]">
                  {linksStatus}
                </footer>
              )}
            </div>
          )}

          {tab === 'share' && (
            <VaultShareModal
              open
              embedded
              vaultId={vaultId}
              vaultName={vaultName}
              isOwner={isOwner}
              canManage={isOwner}
              onClose={onClose}
            />
          )}

          {tab === 'trash' && canEdit && (
            <div className="flex h-full min-h-0 flex-col">
              <div className="border-b border-[var(--border)] px-5 py-3 text-sm text-[var(--muted)]">
                Soft-deleted notes. Restore to bring them back, or delete permanently.
              </div>
              <div className="min-h-0 flex-1 space-y-2 overflow-auto p-5">
                {loadingTrash && <p className="text-sm text-[var(--muted)]">Loading trash…</p>}
                {!loadingTrash && trash.length === 0 && (
                  <p className="rounded-xl border border-dashed border-[var(--border)] px-4 py-10 text-center text-sm text-[var(--muted)]">
                    Trash is empty.
                  </p>
                )}
                {trash.map((n) => (
                  <div
                    key={n.Id}
                    className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{n.Title}</p>
                      <p className="truncate font-mono text-[11px] text-[var(--muted)]">
                        {displayTrashPath(n.Path, n.Id)}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="btn-primary py-1 text-xs"
                      disabled={trashBusy === n.Id}
                      onClick={() => void restoreNote(n.Id)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      className="btn-danger py-1 text-xs"
                      disabled={trashBusy === n.Id}
                      onClick={() => void purgeNote(n.Id)}
                    >
                      Delete forever
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === 'pm' && canEdit && (
            <VaultPmSettingsModal
              open
              embedded
              vaultId={vaultId}
              vaultName={vaultName}
              pmProjectId={pmProjectId}
              pmOrganizationId={pmOrganizationId}
              onClose={onClose}
              onChanged={onChanged}
              onStatus={onStatus}
              notes={notes}
              onOpenNote={(id) => {
                onOpenNote(id);
                onClose();
              }}
            />
          )}

          {tab === 'vault' && (
            <div className="space-y-4 overflow-auto p-5">
              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
                <h3 className="text-sm font-semibold">Name</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Display name for this vault. The wiki slug
                  {vaultSlug ? (
                    <>
                      {' '}
                      (<code className="text-[var(--accent-soft)]">/w/{vaultSlug}</code>)
                    </>
                  ) : null}{' '}
                  stays the same so existing links keep working.
                </p>
                <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Vault name
                  <input
                    className="input mt-1.5 w-full max-w-sm"
                    value={nameDraft}
                    disabled={!isOwner || savingName}
                    onChange={(e) => setNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void saveVaultName();
                      }
                    }}
                    maxLength={255}
                  />
                </label>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={
                      !isOwner ||
                      savingName ||
                      !nameDraft.trim() ||
                      nameDraft.trim() === vaultName
                    }
                    onClick={() => void saveVaultName()}
                  >
                    {savingName ? 'Saving…' : 'Save name'}
                  </button>
                  {!isOwner && (
                    <p className="text-xs text-[var(--muted)]">Only the vault owner can rename.</p>
                  )}
                </div>
              </section>

              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
                <h3 className="text-sm font-semibold">Wiki audience (default visibility)</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Who may open this vault’s wiki when public pages are enabled. Also the default for
                  notes that use “Vault default”. Per-note overrides still apply inside the wiki.
                </p>
                <label className="mt-3 block text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                  Vault wiki audience
                  <select
                    className="input mt-1.5 w-full max-w-sm"
                    value={vaultDefaultVis}
                    disabled={!isOwner || savingVis}
                    onChange={(e) => void saveDefaultVisibility(e.target.value)}
                  >
                    <option value="private">Private — Share only</option>
                    <option value="authenticated">Authenticated — any signed-in user</option>
                    <option value="unlisted">Unlisted — link only (hidden from /w)</option>
                    <option value="public">Public — everyone</option>
                  </select>
                </label>
                {!isOwner && (
                  <p className="mt-2 text-xs text-[var(--muted)]">Only the vault owner can change this.</p>
                )}
              </section>

              <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
                <h3 className="text-sm font-semibold">Export</h3>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  Download all notes as Markdown plus images (compatible with ZIP import).
                </p>
                <button
                  type="button"
                  className="btn-primary mt-3"
                  disabled={exporting}
                  onClick={() => void exportZip()}
                >
                  {exporting ? 'Exporting…' : 'Export ZIP'}
                </button>
              </section>

              {!isOwner && (
                <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/40 p-4">
                  <h3 className="text-sm font-semibold">Leave vault</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Remove your access. You can be invited again later.
                  </p>
                  <button type="button" className="btn-danger mt-3" onClick={() => setLeaveOpen(true)}>
                    Leave vault
                  </button>
                </section>
              )}

              {isOwner && !isPersonalWork && (
                <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
                  <h3 className="text-sm font-semibold text-red-300">Delete vault</h3>
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    Permanently deletes this vault, all notes, revisions, and media. This cannot be
                    undone.
                  </p>
                  <button type="button" className="btn-danger mt-3" onClick={() => setDeleteOpen(true)}>
                    Delete vault…
                  </button>
                </section>
              )}

              {vaultStatus && <p className="text-xs text-[var(--muted)]">{vaultStatus}</p>}
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={leaveOpen}
        title="Leave vault"
        message={`Leave “${vaultName}”? You will lose access until invited again.`}
        confirmLabel="Leave"
        danger
        onConfirm={() => void leaveVault()}
        onCancel={() => setLeaveOpen(false)}
      />

      {deleteOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4">
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-md rounded-xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-2xl"
          >
            <h3 className="text-lg font-semibold tracking-tight">Delete vault</h3>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Type <strong className="text-[var(--text)]">{vaultName}</strong> to confirm permanent
              deletion.
            </p>
            <input
              className="input mt-3 w-full"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={vaultName}
              autoFocus
            />
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="btn-ghost"
                disabled={deletingVault}
                onClick={() => {
                  setDeleteOpen(false);
                  setDeleteConfirm('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-danger"
                disabled={deletingVault || deleteConfirm !== vaultName}
                onClick={() => void deleteVault()}
              >
                {deletingVault ? 'Deleting…' : 'Delete forever'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
