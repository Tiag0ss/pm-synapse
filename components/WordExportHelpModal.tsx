'use client';

interface WordExportHelpModalProps {
  open: boolean;
  onClose: () => void;
}

const BUILTIN_FIELDS: Array<[string, string]> = [
  ['{d.title}', 'Note title'],
  ['{d.path}', 'Note path (e.g. meta/risks)'],
  ['{d.body}', 'Note body as plain text (Markdown stripped)'],
  ['{d.vaultName}', 'Vault name'],
  ['{d.exportedAt}', 'Export timestamp (ISO)'],
  ['{d.author}', 'Exporter username'],
  ['{d.authorEmail}', 'Exporter email'],
];

export default function WordExportHelpModal({ open, onClose }: WordExportHelpModalProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal
        aria-labelledby="word-export-help-title"
        className="flex max-h-[min(90vh,40rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl"
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 id="word-export-help-title" className="text-lg font-semibold tracking-tight">
              How to create a Word template
            </h2>
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Carbone markers in a .docx file, filled from the note and its frontmatter
            </p>
          </div>
          <button type="button" className="btn-ghost py-1" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--muted)]">
            <li>
              Open Microsoft Word (or LibreOffice Writer) and design the layout — headers, logos,
              tables, styles.
            </li>
            <li>
              Where values should appear, type Carbone markers exactly as below (including curly
              braces). Save as <span className="text-[var(--text)]">.docx</span>.
            </li>
            <li>
              Upload the file under Word export, then use{' '}
              <span className="text-[var(--text)]">Export DOCX</span> on a note in the vault.
            </li>
          </ol>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-soft)]">
              Built-in fields
            </h3>
            <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full min-w-[24rem] text-left text-xs">
                <thead className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Marker in Word</th>
                    <th className="px-3 py-2 font-medium">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {BUILTIN_FIELDS.map(([marker, desc]) => (
                    <tr key={marker} className="border-b border-[var(--border)]/60">
                      <td className="px-3 py-1.5 font-mono text-[11px] text-[var(--accent-soft)]">
                        {marker}
                      </td>
                      <td className="px-3 py-1.5 text-[var(--muted)]">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-soft)]">
              Frontmatter
            </h3>
            <p className="mt-2 text-sm text-[var(--muted)]">
              YAML keys on the note become fields. Prefer a dedicated prefix to avoid clashes:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
              <li>
                <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-[11px] text-[var(--accent-soft)]">
                  {'{d.fm.client}'}
                </code>{' '}
                — always safe (under <code className="font-mono text-[11px]">fm</code>)
              </li>
              <li>
                <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-[11px] text-[var(--accent-soft)]">
                  {'{d.client}'}
                </code>{' '}
                — flattened on the root when the key does not collide with built-ins
              </li>
            </ul>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--surface)]/50 p-3 text-[11px] leading-relaxed text-[var(--muted)]">{`---
client: Acme Corp
status: draft
tags:
  - risk
  - q1
todos:
  - content: Follow up with legal
    status: pending
---
Note body here…`}</pre>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-soft)]">
              Lists and tables
            </h3>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Carbone repeats a Word table row or paragraph with array syntax:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--muted)]">
              <li>
                Tags:{' '}
                <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-[11px] text-[var(--accent-soft)]">
                  {'{d.tags[i]}'}
                </code>
              </li>
              <li>
                Todos:{' '}
                <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-[11px] text-[var(--accent-soft)]">
                  {'{d.todos[i].content}'}
                </code>
                ,{' '}
                <code className="rounded bg-[var(--surface-2)] px-1 font-mono text-[11px] text-[var(--accent-soft)]">
                  {'{d.todos[i].status}'}
                </code>
              </li>
            </ul>
            <p className="mt-3 text-xs text-[var(--muted)]">
              Tip: type each marker as one continuous run in Word (avoid splitting formatting). If a
              field stays blank, check the frontmatter key matches. Output is DOCX only for now.
            </p>
          </div>
        </div>

        <footer className="flex shrink-0 justify-end border-t border-[var(--border)] px-5 py-3">
          <button type="button" className="btn-primary" onClick={onClose}>
            Got it
          </button>
        </footer>
      </div>
    </div>
  );
}
