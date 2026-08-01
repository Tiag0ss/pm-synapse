'use client';

import { useEffect, useMemo, useState } from 'react';
import VaultShareModal from '@/components/VaultShareModal';
import VaultPmSettingsModal from '@/components/VaultPmSettingsModal';

type OptionsTab = 'links' | 'share' | 'pm';

interface BrokenLinkItem {
  noteId: number;
  noteTitle: string;
  notePath: string;
  target: string;
  occurrence: number;
}

interface VaultOptionsModalProps {
  open: boolean;
  vaultId: string;
  vaultName: string;
  isOwner: boolean;
  canEdit: boolean;
  pmProjectId?: number | null;
  pmOrganizationId?: number | null;
  initialTab?: OptionsTab;
  onClose: () => void;
  onChanged: () => void;
  onOpenNote: (noteId: number) => void;
  onCreateMissingNote: (title: string, linkFromNoteId: number) => Promise<void> | void;
}

export default function VaultOptionsModal({
  open,
  vaultId,
  vaultName,
  isOwner,
  canEdit,
  pmProjectId,
  pmOrganizationId,
  initialTab = 'links',
  onClose,
  onChanged,
  onOpenNote,
  onCreateMissingNote,
}: VaultOptionsModalProps) {
  const [tab, setTab] = useState<OptionsTab>(initialTab);
  const [broken, setBroken] = useState<BrokenLinkItem[]>([]);
  const [uniqueTargets, setUniqueTargets] = useState(0);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [linksError, setLinksError] = useState('');
  const [busyTarget, setBusyTarget] = useState<string | null>(null);
  const [linksStatus, setLinksStatus] = useState('');

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
  }, [open, initialTab]);

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

  useEffect(() => {
    if (!open || tab !== 'links') return;
    void loadBroken();
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
    { id: 'share', label: 'Share' },
    { id: 'pm', label: 'Project Management', hidden: !canEdit },
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        className="flex h-[min(860px,92vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Vault options</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {vaultName} — broken links, sharing, and Project Management.
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
              onClose={onClose}
            />
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
              onOpenNote={(id) => {
                onOpenNote(id);
                onClose();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
