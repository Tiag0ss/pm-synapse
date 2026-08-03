'use client';

interface WordExportHelpModalProps {
  open: boolean;
  onClose: () => void;
}

const BUILTIN_FIELDS: Array<[string, string]> = [
  ['{d.title}', 'Note title'],
  ['{d.path}', 'Note path'],
  ['{d.body}', 'Note Markdown body (see Body section below)'],
  ['{d.vaultName}', 'Vault name'],
  ['{d.exportedAt}', 'Export timestamp (ISO)'],
  ['{d.author}', 'Exporter username'],
  ['{d.authorEmail}', 'Exporter email'],
  ['{d.fm.<key>}', 'Any frontmatter scalar, e.g. {d.fm.status}'],
  ['{d.<key>}', 'Frontmatter scalar flattened on the root when it does not collide'],
  ['{d.<list>[i].<field>}', 'One cell in a repeating table row (see Grids)'],
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
              Generic Carbone .docx guide — markers are filled from the note and its frontmatter
            </p>
          </div>
          <button type="button" className="btn-ghost py-1" onClick={onClose}>
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--muted)]">
            <li>Design the layout in Word (styles, headers, tables). Save as .docx.</li>
            <li>
              Insert Carbone markers such as{' '}
              <code className="font-mono text-[11px] text-[var(--accent-soft)]">{'{d.title}'}</code>{' '}
              as a single unbroken run (do not bold only part of the marker).
            </li>
            <li>Upload the file here. Users export a note with Export DOCX in a vault.</li>
          </ol>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 py-3 text-sm text-[var(--muted)]">
            <p className="font-medium text-[var(--text)]">Grids (repeating rows)</p>
            <p className="mt-1">
              Put field markers on <span className="text-[var(--text)]">one</span> sample data row
              using <code className="font-mono text-[11px]">[i]</code>. Synapse adds the Carbone end
              marker and repeats that row for each item in the matching frontmatter array. You do
              not need to create many empty rows in advance.
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2 text-[11px] text-[var(--accent-soft)]">{`Column A | Column B
{d.items[i].name} | {d.items[i].value}`}</pre>
            <p className="mt-2 text-xs">
              The array name (<code className="font-mono">items</code> above) must match a YAML list
              key in the note frontmatter. Style the sample row in Word; clones keep that
              formatting.
            </p>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 py-3 text-sm text-[var(--muted)]">
            <p className="font-medium text-[var(--text)]">Nested / indented rows</p>
            <p className="mt-1">
              Add <code className="font-mono text-[11px]">indent: 1</code> (or{' '}
              <code className="font-mono text-[11px]">level</code>) on nested list items. Synapse
              prefixes label-like fields (<code className="font-mono text-[11px]">Task</code>,{' '}
              <code className="font-mono text-[11px]">name</code>,{' '}
              <code className="font-mono text-[11px]">title</code>, …) with em-spaces, so a normal{' '}
              <code className="font-mono text-[11px] text-[var(--accent-soft)]">
                {'{d.items[i].name}'}
              </code>{' '}
              cell already shows nesting. You can also use{' '}
              <code className="font-mono text-[11px] text-[var(--accent-soft)]">
                {'{d.items[i].indentPrefix}'}
              </code>{' '}
              explicitly.
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2 text-[11px] text-[var(--muted)]">{`items:
  - name: Parent group
    indent: 0
    value: ""
  - name: Child row
    indent: 1
    value: 10`}</pre>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 py-3 text-sm text-[var(--muted)]">
            <p className="font-medium text-[var(--text)]">Body and headings</p>
            <p className="mt-1">
              Place{' '}
              <code className="font-mono text-[11px] text-[var(--accent-soft)]">{'{d.body}'}</code>{' '}
              <span className="text-[var(--text)]">alone</span> in its own paragraph. Synapse
              replaces it with the note Markdown: Heading 1–4 styles, GFM tables, fenced code
              (monospace), callouts, footnote text, math (KaTeX → readable text), vault images, and
              Mermaid as PNG (white background, teal Synapse accents, ELK-style orthogonal edges)
              when render succeeds.
            </p>
            <p className="mt-2 text-xs">
              Fixed section titles that always appear in the document should be typed in Word and
              given Heading 1 / Heading 2 styles there — Carbone only fills markers; it does not
              invent a TOC by itself.
            </p>
          </div>

          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/50 px-3 py-3 text-sm text-[var(--muted)]">
            <p className="font-medium text-[var(--text)]">Table of contents</p>
            <p className="mt-1">
              Insert a native Word table of contents in the template (References → Table of
              Contents). After export, open the file in Word and update the field (right-click →
              Update field) so it picks up Heading styles from the filled body and fixed titles.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--accent-soft)]">
              Built-in markers
            </h3>
            <div className="mt-2 overflow-x-auto rounded-xl border border-[var(--border)]">
              <table className="w-full min-w-[24rem] text-left text-xs">
                <thead className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2 font-medium">Marker</th>
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

          <p className="text-xs text-[var(--muted)]">
            Frontmatter example (generic): define any keys your template markers expect — scalars
            under <code className="font-mono">{'{d.fm.*}'}</code>, lists for table loops.
          </p>
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
