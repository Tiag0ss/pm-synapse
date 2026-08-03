'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import MarkdownNoteEditor from '@/components/MarkdownNoteEditor';
import CreateNoteModal, { type SelectedTemplate } from '@/components/CreateNoteModal';
import QuickSwitcher from '@/components/QuickSwitcher';
import NoteGraphMindmap from '@/components/NoteGraphMindmap';
import RevisionDiffModal, { type RevisionSnapshot } from '@/components/RevisionDiffModal';
import VaultOptionsModal from '@/components/VaultOptionsModal';
import VaultPmSettingsModal from '@/components/VaultPmSettingsModal';
import NoteTasksPanel from '@/components/NoteTasksPanel';
import NoteExportModal from '@/components/NoteExportModal';
import NotesFolderTree from '@/components/NotesFolderTree';
import NoteIconPicker from '@/components/NoteIconPicker';
import VaultSwitcher, { rememberLastVault } from '@/components/VaultSwitcher';
import { noteLeafName } from '@/lib/notePaths';
import { normalizeNoteIcon, type NoteIconId } from '@/lib/noteIcons';
import { applyNoteTemplateBody } from '@/lib/noteTemplates';
import ConfirmModal from '@/components/ConfirmModal';
import AppUserMenu from '@/components/AppUserMenu';
import { useIsLgUp } from '@/lib/useMediaQuery';

interface NoteListItem {
  Id: number;
  Path: string;
  Title: string;
  Visibility?: string | null;
  PmTaskId?: number | null;
  Icon?: string | null;
}

interface Revision {
  RevisionNumber: number;
  Title: string;
  CreatedAt: string;
}

interface Backlink {
  Id: number;
  Title: string;
  Path: string;
  Kind: string;
}

type CenterMode = 'editor' | 'mindmap';

function FullMindmapPane({
  graph,
  graphToken,
  selectedId,
  onBack,
  onOpenNote,
}: {
  graph: {
    nodes: Array<{ Id: number; Title: string }>;
    edges: Array<{ FromNoteId: number; ToNoteId: number; Kind: string }>;
  };
  graphToken: number;
  selectedId: number | null;
  onBack: () => void;
  onOpenNote: (id: number) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(520);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setHeight(Math.max(360, el.clientHeight));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Full vault mindmap</h2>
          <p className="text-xs text-[var(--muted)]">
            {graph.nodes.length} notes · {graph.edges.length} links · click a node to open it in the editor
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={onBack}>
          Back to editor
        </button>
      </div>
      <div ref={boxRef} className="min-h-0 flex-1">
        <NoteGraphMindmap
          nodes={graph.nodes}
          edges={graph.edges}
          height={height}
          focusId={selectedId}
          variant="full"
          reloadToken={graphToken}
          onNodeClick={onOpenNote}
        />
      </div>
    </div>
  );
}

export default function VaultWorkspacePage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const vaultId = String(params.id);
  const deepNoteOpenedRef = useRef(false);

  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [noteIcon, setNoteIcon] = useState<NoteIconId | null>(null);
  const [visibility, setVisibility] = useState<string>('');
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [references, setReferences] = useState<Backlink[]>([]);
  const [graph, setGraph] = useState<{
    nodes: Array<{ Id: number; Title: string }>;
    edges: Array<{ FromNoteId: number; ToNoteId: number; Kind: string }>;
  } | null>(null);
  const [graphToken, setGraphToken] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [vaultMeta, setVaultMeta] = useState<{
    Name?: string;
    PmProjectId?: number | null;
    PmOrganizationId?: number | null;
    slug?: string;
    AllowPublicPages?: number | boolean;
    DefaultVisibility?: string;
    AccessRole?: 'owner' | 'edit' | 'read';
  }>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [vaultOptionsOpen, setVaultOptionsOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [centerMode, setCenterMode] = useState<CenterMode>('editor');
  const [notesOpen, setNotesOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const isLgUp = useIsLgUp();
  const mindmapFull = centerMode === 'mindmap';
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffRestoring, setDiffRestoring] = useState(false);
  const [diffRevision, setDiffRevision] = useState<RevisionSnapshot | null>(null);
  const [pmTasksOpen, setPmTasksOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [vaultOptionsTab, setVaultOptionsTab] = useState<
    'links' | 'share' | 'pm' | 'vault' | 'trash' | undefined
  >(undefined);
  const [diffRevNumber, setDiffRevNumber] = useState<number | null>(null);
  const [zipImporting, setZipImporting] = useState(false);
  const [zipOverwriteOpen, setZipOverwriteOpen] = useState(false);
  const [pendingZipBase64, setPendingZipBase64] = useState<string | null>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const [savedSnapshot, setSavedSnapshot] = useState({
    title: '',
    body: '',
    visibility: '',
    icon: null as NoteIconId | null,
  });
  const [saveState, setSaveState] = useState<'idle' | 'dirty' | 'saving' | 'saved' | 'error'>('idle');
  const [pendingSwitchId, setPendingSwitchId] = useState<number | null>(null);
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextAutosaveRef = useRef(false);

  const noteIndex = useMemo(
    () => notes.map((n) => ({ id: n.Id, title: n.Title, path: n.Path })),
    [notes]
  );

  const HISTORY_PREVIEW = 5;
  const visibleRevisions = historyExpanded ? revisions : revisions.slice(0, HISTORY_PREVIEW);

  const effectiveNoteVisibility = (visibility || vaultMeta.DefaultVisibility || 'private').toLowerCase();
  const accessRole = vaultMeta.AccessRole || 'owner';
  const canEdit = accessRole === 'owner' || accessRole === 'edit';
  const isOwner = accessRole === 'owner';
  const notePublicUrl =
    vaultMeta.slug &&
    selectedId &&
    Number(vaultMeta.AllowPublicPages) === 1 &&
    (effectiveNoteVisibility === 'public' ||
      effectiveNoteVisibility === 'unlisted' ||
      effectiveNoteVisibility === 'authenticated')
      ? `/w/${vaultMeta.slug}?n=${selectedId}`
      : null;

  const dirty =
    selectedId != null &&
    canEdit &&
    (title !== savedSnapshot.title ||
      body !== savedSnapshot.body ||
      visibility !== savedSnapshot.visibility ||
      noteIcon !== savedSnapshot.icon);

  useEffect(() => {
    if (!dirty) {
      if (saveState === 'dirty') setSaveState('idle');
      return;
    }
    setSaveState('dirty');
  }, [dirty, saveState]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const loadNotes = useCallback(async () => {
    const res = await fetch(`/api/vaults/${vaultId}/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`, {
      credentials: 'include',
    });
    const data = await res.json();
    setNotes(data.data || []);
  }, [vaultId, q]);

  const loadVault = useCallback(async () => {
    const res = await fetch(`/api/vaults/${vaultId}`, { credentials: 'include' });
    const data = await res.json();
    if (data.data) setVaultMeta(data.data);
  }, [vaultId]);

  const loadGraph = useCallback(async () => {
    const res = await fetch(`/api/vaults/${vaultId}/graph`, { credentials: 'include' });
    const data = await res.json();
    if (res.ok) {
      setGraph(data.data || { nodes: [], edges: [] });
      setGraphToken((t) => t + 1);
    }
  }, [vaultId]);

  useEffect(() => {
    void loadVault();
    void loadGraph();
  }, [loadVault, loadGraph]);

  useEffect(() => {
    if (vaultId) rememberLastVault(vaultId);
  }, [vaultId]);

  // notes load via debounced q effect

  const openNote = async (id: number, opts?: { force?: boolean }) => {
    if (!opts?.force && dirty && selectedId != null && selectedId !== id) {
      setPendingSwitchId(id);
      return;
    }
    const res = await fetch(`/api/vaults/${vaultId}/notes/${id}`, { credentials: 'include' });
    const data = await res.json();
    if (!res.ok) return;
    const n = data.data;
    skipNextAutosaveRef.current = true;
    setSelectedId(n.Id);
    setTitle(n.Title);
    setBody(n.BodyMarkdown || '');
    setVisibility(n.Visibility || '');
    const icon = normalizeNoteIcon(n.Icon);
    setNoteIcon(icon);
    setSavedSnapshot({
      title: String(n.Title || ''),
      body: String(n.BodyMarkdown || ''),
      visibility: String(n.Visibility || ''),
      icon,
    });
    setSaveState('idle');
    setCenterMode('editor');
    setNotesOpen(false);
    setContextOpen(false);
    setMoreOpen(false);
    setHistoryExpanded(false);
    const [revRes, blRes] = await Promise.all([
      fetch(`/api/vaults/${vaultId}/notes/${id}/revisions`, { credentials: 'include' }),
      fetch(`/api/vaults/${vaultId}/notes/${id}/backlinks`, { credentials: 'include' }),
    ]);
    setRevisions((await revRes.json()).data || []);
    const blData = (await blRes.json()).data;
    if (Array.isArray(blData)) {
      setBacklinks(blData);
      setReferences([]);
    } else {
      setBacklinks(blData?.backlinks || []);
      setReferences(blData?.references || []);
    }
  };

  // Deep-link from PM: /vaults/:id?note=:noteId
  useEffect(() => {
    if (deepNoteOpenedRef.current) return;
    const noteParam = searchParams.get('note');
    if (!noteParam) return;
    const noteId = Number(noteParam);
    if (!Number.isFinite(noteId) || noteId <= 0) return;
    deepNoteOpenedRef.current = true;
    void openNote(noteId, { force: true });
  }, [searchParams, vaultId]);

  const saveNote = async (opts?: { reason?: 'manual' | 'auto' }) => {
    if (!selectedId || !canEdit) return false;
    const reason = opts?.reason || 'manual';
    setSaveState('saving');
    setStatus(reason === 'auto' ? 'Autosaving…' : 'Saving…');
    const payload = {
      title,
      bodyMarkdown: body,
      visibility: visibility || null,
      icon: noteIcon,
    };
    const res = await fetch(`/api/vaults/${vaultId}/notes/${selectedId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setSaveState('error');
      setStatus(data.message || 'Save failed');
      return false;
    }
    setSavedSnapshot({
      title,
      body,
      visibility,
      icon: noteIcon,
    });
    setSaveState('saved');
    setStatus(reason === 'auto' ? 'Autosaved' : 'Saved');
    await loadNotes();
    // Refresh revisions quietly without resetting editor cursor
    const revRes = await fetch(`/api/vaults/${vaultId}/notes/${selectedId}/revisions`, {
      credentials: 'include',
    });
    if (revRes.ok) setRevisions((await revRes.json()).data || []);
    if (reason === 'manual') await loadGraph();
    return true;
  };

  // Debounced autosave
  useEffect(() => {
    if (!canEdit || !selectedId || !dirty) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      void saveNote({ reason: 'auto' });
    }, 2500);
    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body, visibility, noteIcon, selectedId, canEdit, dirty]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && quickOpen) {
        setQuickOpen(false);
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 's') {
        e.preventDefault();
        if (canEdit && selectedId) void saveNote({ reason: 'manual' });
      } else if (k === 'o') {
        e.preventDefault();
        setQuickOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, selectedId, title, body, visibility, noteIcon, quickOpen]);

  // Debounce title/path/body search filter
  useEffect(() => {
    const t = window.setTimeout(() => {
      void loadNotes();
    }, q ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [q, loadNotes]);

  const createNote = async (
    name: string,
    opts?: {
      linkFromNoteId?: number | null;
      skipOpen?: boolean;
      template?: SelectedTemplate;
    }
  ) => {
    setCreateOpen(false);
    const trimmed = name.trim();
    if (!trimmed) return;

    const linkFromNoteId = opts?.linkFromNoteId ?? null;
    const skipOpen = Boolean(opts?.skipOpen);
    const bodyMarkdown = opts?.template
      ? applyNoteTemplateBody(opts.template.bodyMarkdown, noteLeafName(trimmed))
      : applyNoteTemplateBody(`# {{title}}\n\n`, noteLeafName(trimmed));

    const rebuildSourceGraph = async () => {
      if (!linkFromNoteId) return;
      await fetch(`/api/vaults/${vaultId}/notes/${linkFromNoteId}/rebuild-graph`, {
        method: 'POST',
        credentials: 'include',
      }).catch(() => null);
    };

    const existingId = noteIndex.find(
      (n) =>
        n.title.replace(/\\/g, '/').toLowerCase() === trimmed.replace(/\\/g, '/').toLowerCase() ||
        n.path.replace(/\.md$/i, '').replace(/\\/g, '/').toLowerCase() ===
          trimmed.replace(/\.md$/i, '').replace(/\\/g, '/').toLowerCase()
    )?.id;
    if (existingId) {
      await rebuildSourceGraph();
      await loadGraph();
      if (!skipOpen) await openNote(existingId);
      return;
    }

    const res = await fetch(`/api/vaults/${vaultId}/notes`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: trimmed,
        bodyMarkdown,
        ...(linkFromNoteId ? { linkFromNoteId } : {}),
      }),
    });
    const data = await res.json();
    if (res.status === 409 && data.data?.id) {
      await loadNotes();
      await loadGraph();
      if (!skipOpen) await openNote(Number(data.data.id));
      return;
    }
    if (!res.ok) {
      setStatus(data.message || 'Create failed');
      throw new Error(data.message || 'Create failed');
    }

    const newId = Number(data.data.id);
    const newPath = String(data.data.path || `${trimmed}.md`);
    const newTitle = String(data.data.title || trimmed);
    setNotes((prev) => {
      if (prev.some((n) => n.Id === newId)) return prev;
      return [
        ...prev,
        {
          Id: newId,
          Path: newPath,
          Title: newTitle,
          Visibility: null,
          PmTaskId: null,
          Icon: null,
        },
      ];
    });

    setStatus(`Created “${trimmed}”`);
    await loadNotes();
    await loadGraph();
    if (!skipOpen) await openNote(newId, { force: true });
  };

  const deleteNote = async () => {
    if (!selectedId || !canEdit) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${selectedId}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.message || 'Delete failed');
        return;
      }
      setDeleteOpen(false);
      setSelectedId(null);
      setTitle('');
      setBody('');
      setNoteIcon(null);
      setVisibility('');
      setSavedSnapshot({ title: '', body: '', visibility: '', icon: null });
      setSaveState('idle');
      setRevisions([]);
      setBacklinks([]);
      setReferences([]);
      setStatus('Note moved to trash');
      await loadNotes();
      await loadGraph();
    } finally {
      setDeleting(false);
    }
  };

  const openRevisionDiff = async (rev: number) => {
    if (!selectedId) return;
    setDiffRevNumber(rev);
    setDiffOpen(true);
    setDiffLoading(true);
    setDiffRevision(null);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${selectedId}/revisions/${rev}`, {
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.message || 'Could not load revision');
        setDiffOpen(false);
        return;
      }
      const r = data.data;
      setDiffRevision({
        RevisionNumber: Number(r.RevisionNumber),
        Title: String(r.Title || ''),
        Path: String(r.Path || ''),
        BodyMarkdown: String(r.BodyMarkdown || ''),
        Visibility: r.Visibility ? String(r.Visibility) : null,
        CreatedAt: r.CreatedAt ? String(r.CreatedAt) : undefined,
      });
    } finally {
      setDiffLoading(false);
    }
  };

  const restore = async (rev: number) => {
    if (!selectedId) return;
    setDiffRestoring(true);
    try {
      const res = await fetch(`/api/vaults/${vaultId}/notes/${selectedId}/revisions/${rev}/restore`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      setStatus(data.message || (res.ok ? 'Restored' : 'Restore failed'));
      if (res.ok) {
        setDiffOpen(false);
        setDiffRevision(null);
        await openNote(selectedId);
        await loadGraph();
      }
    } finally {
      setDiffRestoring(false);
    }
  };

  const toggleFullMindmap = () => {
    if (centerMode === 'mindmap') {
      setCenterMode('editor');
      return;
    }
    void loadGraph().then(() => setCenterMode('mindmap'));
  };

  const openPmTasks = () => {
    if (!vaultMeta.PmProjectId) {
      setStatus('Link a PM project in Vault options first');
      setVaultOptionsTab('pm');
      setVaultOptionsOpen(true);
      return;
    }
    setPmTasksOpen(true);
  };

  const runZipImport = async (dataBase64: string, overwrite: boolean) => {
    setZipImporting(true);
    setStatus(overwrite ? 'Importing ZIP (overwrite)…' : 'Importing ZIP…');
    try {
      const res = await fetch(`/api/vaults/${vaultId}/import-zip`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64, overwrite }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(data.message || 'ZIP import failed');
        return;
      }
      const d = data.data || {};
      setStatus(
        `Import: ${d.created || 0} created, ${d.updated || 0} updated, ${d.skipped || 0} skipped, ${d.images || 0} images` +
          (d.errors?.length ? ` · ${d.errors.length} errors` : '')
      );
      await loadNotes();
      await loadGraph();
    } catch {
      setStatus('ZIP import failed');
    } finally {
      setZipImporting(false);
      setPendingZipBase64(null);
    }
  };

  const onZipFileChosen = async (file: File | null) => {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) {
      setStatus('Please choose a .zip file');
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setStatus('ZIP too large (max 20 MB)');
      return;
    }
    const dataBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    setPendingZipBase64(dataBase64);
    setZipOverwriteOpen(true);
  };

  return (
    <div className="flex h-dvh flex-col">
      <header className="relative z-40 shrink-0 border-b border-[var(--border)] bg-[var(--panel)]/95 backdrop-blur-md">
        {/* Mobile: identity row + action strip */}
        <div className="lg:hidden">
          <div className="flex h-12 items-center gap-1.5 px-2.5 pt-[env(safe-area-inset-top)]">
            {!mindmapFull && (
              <button
                type="button"
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                  notesOpen
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                }`}
                aria-label="Notes"
                aria-pressed={notesOpen}
                onClick={() => {
                  setNotesOpen((v) => !v);
                  setContextOpen(false);
                  setMoreOpen(false);
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M4 7h16M4 12h16M4 17h10"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
            <div className="min-w-0 flex-1 px-1">
              <h1 className="truncate text-[15px] font-semibold tracking-tight">
                {vaultMeta.Name || `Vault #${vaultId}`}
              </h1>
              {(accessRole !== 'owner' || saveState === 'dirty' || saveState === 'saving') && (
                <p className="truncate text-[11px] text-[var(--muted)]">
                  {saveState === 'saving'
                    ? 'Saving…'
                    : saveState === 'dirty'
                      ? 'Unsaved'
                      : `${accessRole} access`}
                </p>
              )}
            </div>
            {!mindmapFull && (
              <button
                type="button"
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                  contextOpen
                    ? 'bg-[var(--accent)] text-[var(--accent-fg)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                }`}
                aria-label="Info"
                aria-pressed={contextOpen}
                onClick={() => {
                  setContextOpen((v) => !v);
                  setNotesOpen(false);
                  setMoreOpen(false);
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
                  <path
                    d="M12 11v5M12 8h.01"
                    stroke="currentColor"
                    strokeWidth="1.75"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            )}
            <div className="relative">
              <button
                type="button"
                className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition ${
                  moreOpen
                    ? 'bg-[var(--surface-2)] text-[var(--text)]'
                    : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
                }`}
                aria-label="More actions"
                aria-expanded={moreOpen}
                onClick={() => {
                  setMoreOpen((v) => !v);
                  setNotesOpen(false);
                  setContextOpen(false);
                }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="6" cy="12" r="1.6" />
                  <circle cx="12" cy="12" r="1.6" />
                  <circle cx="18" cy="12" r="1.6" />
                </svg>
              </button>
              {moreOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-50 min-w-[12.5rem] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] py-1 shadow-2xl shadow-black/40">
                  {vaultMeta.slug && Number(vaultMeta.AllowPublicPages) === 1 && (
                    <Link
                      href={`/w/${vaultMeta.slug}`}
                      className="block px-3.5 py-2.5 text-sm text-[var(--text)] no-underline hover:bg-[var(--surface-2)]"
                      target="_blank"
                      rel="noreferrer"
                      onClick={() => setMoreOpen(false)}
                    >
                      Open public wiki
                    </Link>
                  )}
                  {isOwner && (
                    <button
                      type="button"
                      className="block w-full px-3.5 py-2.5 text-left text-sm hover:bg-[var(--surface-2)]"
                      onClick={async () => {
                        setMoreOpen(false);
                        const enable = Number(vaultMeta.AllowPublicPages) !== 1;
                        const res = await fetch(`/api/vaults/${vaultId}`, {
                          method: 'PATCH',
                          credentials: 'include',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ allowPublicPages: enable }),
                        });
                        setStatus(
                          res.ok
                            ? enable
                              ? 'Public wiki enabled'
                              : 'Public wiki disabled'
                            : 'Failed to update public wiki'
                        );
                        await loadVault();
                      }}
                    >
                      {Number(vaultMeta.AllowPublicPages) === 1
                        ? 'Disable public wiki'
                        : 'Enable public wiki'}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="block w-full px-3.5 py-2.5 text-left text-sm hover:bg-[var(--surface-2)]"
                      disabled={zipImporting}
                      onClick={() => {
                        setMoreOpen(false);
                        zipInputRef.current?.click();
                      }}
                    >
                      {zipImporting ? 'Importing…' : 'Import ZIP'}
                    </button>
                  )}
                  {canEdit && (
                    <button
                      type="button"
                      className="block w-full px-3.5 py-2.5 text-left text-sm hover:bg-[var(--surface-2)]"
                      onClick={() => {
                        setMoreOpen(false);
                        openPmTasks();
                      }}
                    >
                      PM tasks
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="pl-0.5">
              <AppUserMenu dense />
            </div>
          </div>
          <div className="flex items-center gap-1 border-t border-[var(--border)] bg-[var(--surface)]/40 px-2 py-1.5">
            <button
              type="button"
              className="inline-flex h-9 flex-1 items-center justify-center rounded-lg text-xs font-medium text-[var(--muted)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              onClick={() => setQuickOpen(true)}
            >
              Jump
            </button>
            {canEdit && (
              <button
                type="button"
                className="inline-flex h-9 flex-1 items-center justify-center rounded-lg bg-[var(--accent)] text-xs font-semibold text-[var(--accent-fg)]"
                onClick={() => setCreateOpen(true)}
              >
                New note
              </button>
            )}
            <button
              type="button"
              className={`inline-flex h-9 flex-1 items-center justify-center rounded-lg text-xs font-medium transition ${
                centerMode === 'mindmap'
                  ? 'bg-[var(--surface-2)] text-[var(--accent-soft)]'
                  : 'text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]'
              }`}
              onClick={() => {
                setNotesOpen(false);
                setContextOpen(false);
                setMoreOpen(false);
                void toggleFullMindmap();
              }}
            >
              {centerMode === 'mindmap' ? 'Editor' : 'Mindmap'}
            </button>
          </div>
        </div>

        {/* Desktop */}
        <div className="hidden items-center gap-3 px-4 py-2.5 lg:flex">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold tracking-tight">
              {vaultMeta.Name || `Vault #${vaultId}`}
            </h1>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--muted)]">
              {vaultMeta.slug && <span>/{vaultMeta.slug}</span>}
              {accessRole !== 'owner' && (
                <>
                  <span aria-hidden>·</span>
                  <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 capitalize text-[var(--accent-soft)]">
                    {accessRole} access
                  </span>
                </>
              )}
              {vaultMeta.slug && Number(vaultMeta.AllowPublicPages) === 1 && (
                <>
                  <span aria-hidden>·</span>
                  <Link
                    href={`/w/${vaultMeta.slug}`}
                    className="text-[var(--accent-soft)] no-underline hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Public wiki
                  </Link>
                  {isOwner && (
                    <>
                      <span aria-hidden>·</span>
                      <button
                        type="button"
                        className="text-[var(--muted)] hover:text-[var(--danger)] hover:underline"
                        onClick={async () => {
                          const res = await fetch(`/api/vaults/${vaultId}`, {
                            method: 'PATCH',
                            credentials: 'include',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ allowPublicPages: false }),
                          });
                          setStatus(res.ok ? 'Public wiki disabled' : 'Failed to disable public wiki');
                          await loadVault();
                        }}
                      >
                        Disable
                      </button>
                    </>
                  )}
                </>
              )}
              {isOwner && Number(vaultMeta.AllowPublicPages) !== 1 && (
                <button
                  type="button"
                  className="text-[var(--accent-soft)] hover:underline"
                  onClick={async () => {
                    const res = await fetch(`/api/vaults/${vaultId}`, {
                      method: 'PATCH',
                      credentials: 'include',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ allowPublicPages: true }),
                    });
                    setStatus(res.ok ? 'Public wiki enabled' : 'Failed to enable public wiki');
                    await loadVault();
                  }}
                >
                  Enable public wiki
                </button>
              )}
            </div>
          </div>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <input
              className="input w-44 py-1.5"
              placeholder="Filter notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              title="Filters by title, path, or body"
            />
            <button
              type="button"
              className="btn-ghost py-1.5"
              onClick={() => setQuickOpen(true)}
              title="Jump to note (Ctrl/Cmd+O)"
            >
              Jump…
            </button>
            {canEdit && (
              <button type="button" className="btn-primary py-1.5" onClick={() => setCreateOpen(true)}>
                New note
              </button>
            )}
            <button
              type="button"
              className={`py-1.5 ${centerMode === 'mindmap' ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => void toggleFullMindmap()}
              title="Show full vault mindmap in the editor area"
            >
              {centerMode === 'mindmap' ? 'Back to editor' : 'Full mindmap'}
            </button>
            {canEdit && (
              <button
                type="button"
                className="btn-ghost py-1.5"
                disabled={zipImporting}
                onClick={() => zipInputRef.current?.click()}
                title="Import Markdown notes from a ZIP"
              >
                {zipImporting ? 'Importing…' : 'Import ZIP'}
              </button>
            )}
            {canEdit && (
              <button type="button" className="btn-ghost py-1.5" onClick={() => openPmTasks()}>
                PM tasks
              </button>
            )}
            {(status || saveState === 'dirty' || saveState === 'saving' || saveState === 'saved') && (
              <span className="max-w-[220px] truncate rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-[11px] text-[var(--muted)]">
                {saveState === 'saving'
                  ? 'Saving…'
                  : saveState === 'dirty'
                    ? 'Unsaved changes'
                    : status || (saveState === 'saved' ? 'Saved' : '')}
              </span>
            )}
            <AppUserMenu dense />
          </div>
        </div>

        <input
          ref={zipInputRef}
          type="file"
          accept=".zip,application/zip"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0] || null;
            e.target.value = '';
            void onZipFileChosen(file);
          }}
        />
      </header>

      <div
        className={`relative grid min-h-0 flex-1 ${
          isLgUp && !mindmapFull ? 'grid-cols-[260px_1fr_300px]' : 'grid-cols-1'
        }`}
      >
        {!isLgUp && !mindmapFull && (notesOpen || contextOpen) && (
          <button
            type="button"
            className="fixed inset-0 z-40 bg-black/55 lg:hidden"
            aria-label="Close panel"
            onClick={() => {
              setNotesOpen(false);
              setContextOpen(false);
            }}
          />
        )}

        <aside
          className={`flex min-h-0 flex-col border-[var(--border)] bg-[var(--panel)] ${
            isLgUp && !mindmapFull
              ? 'border-r bg-[var(--panel)]/40'
              : mindmapFull
                ? 'hidden'
                : `fixed inset-y-0 left-0 z-50 w-[min(100%,18rem)] border-r shadow-2xl transition-transform duration-200 ease-out ${
                    notesOpen ? 'translate-x-0' : '-translate-x-full'
                  } pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`
          }`}
        >
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <div className="mb-2 flex items-center justify-between gap-2 px-2 lg:block">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                Notes · {notes.length}
              </p>
              <button
                type="button"
                className="btn-ghost py-1 text-xs lg:hidden"
                onClick={() => setNotesOpen(false)}
              >
                Close
              </button>
            </div>
            <input
              className="input mb-3 w-full py-1.5 lg:hidden"
              placeholder="Filter notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <NotesFolderTree
              notes={notes}
              selectedId={selectedId}
              onOpenNote={(id) => void openNote(id)}
            />
          </div>
          <VaultSwitcher
            currentVaultId={vaultId}
            currentVaultName={vaultMeta.Name || `Vault #${vaultId}`}
            onOpenOptions={() => setVaultOptionsOpen(true)}
          />
        </aside>

        <section className="flex min-h-0 flex-col gap-3 p-3 sm:p-4">
          {centerMode === 'mindmap' && graph ? (
            <FullMindmapPane
              graph={graph}
              graphToken={graphToken}
              selectedId={selectedId}
              onBack={() => setCenterMode('editor')}
              onOpenNote={(id) => void openNote(id)}
            />
          ) : selectedId ? (
            <>
              {/* Mobile note chrome: title first, then compact actions */}
              <div className="space-y-2 lg:hidden">
                <div className="flex items-center gap-2">
                  <NoteIconPicker value={noteIcon} onChange={setNoteIcon} disabled={!canEdit} />
                  <input
                    className="input min-w-0 flex-1 py-2 text-base font-semibold tracking-tight"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    aria-label="Note title"
                    placeholder="meta/risks"
                    title="Use folder/name for nesting (e.g. meta/risks)"
                    disabled={!canEdit}
                  />
                </div>
                {title.includes('/') && (
                  <p className="truncate pl-12 text-[11px] text-[var(--muted)]">
                    → {noteLeafName(title)} in folder
                  </p>
                )}
                <div className="flex items-center gap-1.5">
                  <select
                    className="input min-w-0 flex-1 py-1.5 text-xs"
                    value={visibility}
                    onChange={(e) => setVisibility(e.target.value)}
                    aria-label="Visibility"
                    disabled={!canEdit}
                  >
                    <option value="">
                      Default ({(vaultMeta.DefaultVisibility || 'private').toLowerCase()})
                    </option>
                    <option value="private">Private</option>
                    <option value="authenticated">Authenticated</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public</option>
                  </select>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn-primary shrink-0 px-3 py-1.5 text-sm"
                      disabled={saveState === 'saving'}
                      onClick={() => void saveNote({ reason: 'manual' })}
                      title="Save (Ctrl/Cmd+S)"
                    >
                      {saveState === 'saving' ? '…' : dirty ? 'Save*' : 'Save'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-ghost shrink-0 px-2.5 py-1.5 text-sm"
                    onClick={() => setExportOpen(true)}
                    title="Export this note as DOCX"
                    aria-label="Export"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                      <path
                        d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  {canEdit && (
                    <button
                      type="button"
                      className="btn-danger shrink-0 px-2.5 py-1.5 text-sm"
                      onClick={() => setDeleteOpen(true)}
                      title="Move this note to trash"
                      aria-label="Delete"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                        <path
                          d="M4 7h16M9 7V5h6v2m-8 0v12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V7"
                          stroke="currentColor"
                          strokeWidth="1.75"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              {/* Desktop note chrome */}
              <div className="hidden flex-wrap items-center gap-2 lg:flex">
                <NoteIconPicker value={noteIcon} onChange={setNoteIcon} disabled={!canEdit} />
                <input
                  className="input min-w-0 flex-1 py-2 text-base font-semibold tracking-tight"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  aria-label="Note title"
                  placeholder="meta/risks"
                  title="Use folder/name for nesting (e.g. meta/risks)"
                  disabled={!canEdit}
                />
                {title.includes('/') && (
                  <span className="text-[11px] text-[var(--muted)]">
                    → {noteLeafName(title)} in folder
                  </span>
                )}
                <select
                  className="input max-w-full"
                  value={visibility}
                  onChange={(e) => setVisibility(e.target.value)}
                  aria-label="Visibility"
                  disabled={!canEdit}
                >
                  <option value="">
                    Vault default ({(vaultMeta.DefaultVisibility || 'private').toLowerCase()})
                  </option>
                  <option value="private">Private (vault editors only on wiki)</option>
                  <option value="authenticated">Authenticated users</option>
                  <option value="unlisted">Unlisted (link only)</option>
                  <option value="public">Public</option>
                </select>
                {canEdit && (
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={saveState === 'saving'}
                    onClick={() => void saveNote({ reason: 'manual' })}
                    title="Save (Ctrl/Cmd+S)"
                  >
                    {saveState === 'saving' ? 'Saving…' : dirty ? 'Save*' : 'Save'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => setExportOpen(true)}
                  title="Export this note as DOCX"
                >
                  Export
                </button>
                {canEdit && (
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() => setDeleteOpen(true)}
                    title="Move this note to trash"
                  >
                    Delete
                  </button>
                )}
              </div>
              <MarkdownNoteEditor
                value={body}
                onChange={setBody}
                vaultId={vaultId}
                noteId={selectedId}
                notes={noteIndex}
                onOpenNote={(id) => void openNote(id)}
                onCreateNoteFromWikilink={
                  canEdit
                    ? (wikilinkTitle) =>
                        void createNote(wikilinkTitle, { linkFromNoteId: selectedId })
                    : undefined
                }
                onStatus={setStatus}
                readOnly={!canEdit}
                compact={!isLgUp}
              />
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] bg-[var(--panel)]/30 px-6 text-center sm:px-8">
              <p className="text-lg font-semibold tracking-tight">Select a note</p>
              <p className="mt-2 max-w-md text-sm text-[var(--muted)]">
                Or create one. Wikilinks like{' '}
                <code className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[var(--accent-soft)]">
                  [[Note title]]
                </code>{' '}
                resolve in the live preview.
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  className="btn-ghost lg:hidden"
                  onClick={() => setNotesOpen(true)}
                >
                  Browse notes
                </button>
                {canEdit && (
                  <button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}>
                    New note
                  </button>
                )}
              </div>
            </div>
          )}
        </section>

        <aside
          className={`flex min-h-0 flex-col overflow-hidden border-[var(--border)] bg-[var(--panel)] ${
            isLgUp && !mindmapFull
              ? 'border-l bg-[var(--panel)]/40'
              : mindmapFull
                ? 'hidden'
                : `fixed inset-y-0 right-0 z-50 w-[min(100%,20rem)] border-l shadow-2xl transition-transform duration-200 ease-out ${
                    contextOpen ? 'translate-x-0' : 'translate-x-full'
                  } pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]`
          }`}
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2 lg:hidden">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">Info</p>
            <button type="button" className="btn-ghost py-1 text-xs" onClick={() => setContextOpen(false)}>
              Close
            </button>
          </div>
          <div className="shrink-0 border-b border-[var(--border)] p-3">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Focused mindmap
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">Current note + direct links</p>
            <div className="mt-2">
              {graph ? (
                <NoteGraphMindmap
                  nodes={graph.nodes}
                  edges={graph.edges}
                  height={220}
                  focusId={selectedId}
                  variant="focus"
                  reloadToken={`${graphToken}-${selectedId ?? 'none'}`}
                  compactLegend
                  onNodeClick={(id) => void openNote(id)}
                />
              ) : (
                <div className="flex h-[220px] items-center justify-center rounded-xl border border-dashed border-[var(--border)] text-xs text-[var(--muted)]">
                  Loading mindmap…
                </div>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto p-4 text-sm">
            {selectedId && (
              <div className="mb-6">
                <NoteTasksPanel
                  vaultId={vaultId}
                  noteId={selectedId}
                  noteTitle={title}
                  body={body}
                  hasProject={!!vaultMeta.PmProjectId}
                  onBodyChange={setBody}
                  onStatus={setStatus}
                  compact
                  readOnly={!canEdit}
                />
              </div>
            )}

            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              References
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">Links from this note</p>
            <div className="mt-2 space-y-1">
              {references.length === 0 && <p className="text-[var(--muted)]">None yet</p>}
              {references.map((b) => (
                <button
                  key={`ref-${b.Id}-${b.Kind}`}
                  type="button"
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-[var(--accent-soft)] transition hover:bg-[var(--surface-2)]"
                  onClick={() => void openNote(b.Id)}
                >
                  → {b.Title}{' '}
                  <span className="text-[11px] text-[var(--muted)]">({b.Kind})</span>
                </button>
              ))}
            </div>

            <h2 className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              Backlinks
            </h2>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">Notes that link here</p>
            <div className="mt-2 space-y-1">
              {backlinks.length === 0 && <p className="text-[var(--muted)]">None yet</p>}
              {backlinks.map((b) => (
                <button
                  key={`bl-${b.Id}-${b.Kind}`}
                  type="button"
                  className="block w-full rounded-lg px-2 py-1.5 text-left text-[var(--accent-soft)] transition hover:bg-[var(--surface-2)]"
                  onClick={() => void openNote(b.Id)}
                >
                  ← {b.Title}{' '}
                  <span className="text-[11px] text-[var(--muted)]">({b.Kind})</span>
                </button>
              ))}
            </div>

            <h2 className="mb-2 mt-6 text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
              History
            </h2>
            {revisions.length === 0 && <p className="text-[var(--muted)]">No revisions</p>}
            {visibleRevisions.map((r) => (
              <div key={r.RevisionNumber} className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[11px] text-[var(--muted)]">
                  #{r.RevisionNumber} · {new Date(r.CreatedAt).toLocaleString()}
                </span>
                <button
                  type="button"
                  className="text-[11px] font-medium text-[var(--accent-soft)]"
                  onClick={() => void openRevisionDiff(r.RevisionNumber)}
                >
                  Compare
                </button>
              </div>
            ))}
            {revisions.length > HISTORY_PREVIEW && (
              <button
                type="button"
                className="mt-1 text-[11px] font-medium text-[var(--accent-soft)]"
                onClick={() => setHistoryExpanded((v) => !v)}
              >
                {historyExpanded
                  ? 'Show less'
                  : `Show ${revisions.length - HISTORY_PREVIEW} older…`}
              </button>
            )}

            {selectedId && (
              <div className="mt-6 border-t border-[var(--border)] pt-4">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)]">
                  Public page
                </h2>
                {notePublicUrl ? (
                  <Link
                    href={notePublicUrl}
                    className="mt-2 inline-block text-xs text-[var(--accent-soft)]"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open this note on the wiki →
                  </Link>
                ) : (
                  <p className="mt-2 text-[11px] leading-relaxed text-[var(--muted)]">
                    {Number(vaultMeta.AllowPublicPages) !== 1
                      ? 'Enable the public wiki in the vault header first.'
                      : 'Wiki audience is set by vault default visibility. Override this note to public, unlisted, or authenticated to publish it; private notes stay hidden from Share Read viewers.'}
                  </p>
                )}
              </div>
            )}
          </div>
        </aside>
      </div>

      <CreateNoteModal
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onConfirm={(v, template) => void createNote(v, { template })}
      />

      <QuickSwitcher
        open={quickOpen}
        vaultId={vaultId}
        notes={noteIndex}
        onClose={() => setQuickOpen(false)}
        onOpenNote={(id) => void openNote(id)}
      />

      <ConfirmModal
        open={pendingSwitchId != null}
        title="Unsaved changes"
        message="You have unsaved edits on this note. Discard them and open the other note, or cancel and save first."
        confirmLabel="Discard & open"
        cancelLabel="Stay"
        danger
        onConfirm={() => {
          const id = pendingSwitchId;
          setPendingSwitchId(null);
          if (id != null) void openNote(id, { force: true });
        }}
        onCancel={() => setPendingSwitchId(null)}
      />

      <ConfirmModal
        open={deleteOpen}
        title="Move to trash"
        message={`Move “${title || 'this note'}” to trash? You can restore it from Vault options → Trash.`}
        confirmLabel={deleting ? 'Deleting…' : 'Move to trash'}
        cancelLabel="Cancel"
        danger
        onConfirm={() => {
          if (!deleting) void deleteNote();
        }}
        onCancel={() => {
          if (!deleting) setDeleteOpen(false);
        }}
      />

      <ConfirmModal
        open={zipOverwriteOpen}
        title="Import ZIP"
        message="Markdown files become notes; folders become paths (e.g. meta/risks.md). Images in the ZIP are uploaded and relative image links are rewritten when possible."
        confirmLabel="Import (skip existing)"
        altConfirmLabel="Import & overwrite"
        cancelLabel="Cancel"
        onConfirm={() => {
          setZipOverwriteOpen(false);
          if (pendingZipBase64) void runZipImport(pendingZipBase64, false);
        }}
        onAltConfirm={() => {
          setZipOverwriteOpen(false);
          if (pendingZipBase64) void runZipImport(pendingZipBase64, true);
        }}
        onCancel={() => {
          setZipOverwriteOpen(false);
          setPendingZipBase64(null);
        }}
      />

      <RevisionDiffModal
        open={diffOpen}
        loading={diffLoading}
        revision={diffRevision}
        current={{
          title,
          path: notes.find((n) => n.Id === selectedId)?.Path || `${title}.md`,
          bodyMarkdown: body,
          visibility,
        }}
        restoring={diffRestoring}
        onClose={() => {
          if (diffRestoring) return;
          setDiffOpen(false);
          setDiffRevision(null);
          setDiffRevNumber(null);
        }}
        onRestore={() => {
          if (diffRevNumber != null) void restore(diffRevNumber);
        }}
      />

      <VaultOptionsModal
        open={vaultOptionsOpen}
        vaultId={vaultId}
        vaultName={vaultMeta.Name || `Vault #${vaultId}`}
        isOwner={isOwner}
        canEdit={canEdit}
        defaultVisibility={vaultMeta.DefaultVisibility || 'private'}
        pmProjectId={vaultMeta.PmProjectId}
        pmOrganizationId={vaultMeta.PmOrganizationId}
        initialTab={vaultOptionsTab || 'links'}
        onClose={() => {
          setVaultOptionsOpen(false);
          setVaultOptionsTab(undefined);
        }}
        onChanged={() => {
          void loadVault();
          void loadNotes();
          void loadGraph();
        }}
        onOpenNote={(id) => {
          setVaultOptionsOpen(false);
          setVaultOptionsTab(undefined);
          void openNote(id);
        }}
        onCreateMissingNote={async (wikilinkTitle, linkFromNoteId) => {
          await createNote(wikilinkTitle, { linkFromNoteId, skipOpen: true });
        }}
      />

      <VaultPmSettingsModal
        open={pmTasksOpen}
        vaultId={vaultId}
        vaultName={vaultMeta.Name || `Vault #${vaultId}`}
        pmProjectId={vaultMeta.PmProjectId}
        pmOrganizationId={vaultMeta.PmOrganizationId}
        onClose={() => setPmTasksOpen(false)}
        onChanged={() => {
          void loadVault();
          void loadNotes();
        }}
        onOpenNote={(id) => {
          setPmTasksOpen(false);
          void openNote(id);
        }}
      />

      <NoteExportModal
        open={exportOpen}
        vaultId={vaultId}
        noteId={selectedId}
        noteTitle={title}
        onClose={() => setExportOpen(false)}
      />
    </div>
  );
}
