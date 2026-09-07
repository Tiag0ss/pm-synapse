jest.mock('../../server/services/sanitizeSynapseHtml', () => ({
  sanitizeSynapseHtml: (html: string) => html,
}));

import { preprocessSynapseMarkdown } from '../../server/services/markdown';
import type { NoteResolveEntry } from '../../server/services/notePaths';

const notes: NoteResolveEntry[] = [
  { id: 10, title: 'Existing Board', path: 'Existing Board.md', kind: 'whiteboard' },
  { id: 11, title: 'Plain Note', path: 'Plain Note.md', kind: 'note' },
];

describe('board embed markdown preprocess', () => {
  it('emits missing embed with create target (not alias) for ![[target|alias]]', () => {
    const out = preprocessSynapseMarkdown('See ![[Pessegos| Pessegos Azedos]]', notes);
    expect(out).toContain('synapse-board-embed');
    expect(out).toContain('is-missing');
    expect(out).toContain('data-note-title="Pessegos"');
    expect(out).toContain('data-display-title="Pessegos Azedos"');
    expect(out).not.toContain('data-note-title="Pessegos Azedos"');
  });

  it('emits resolved whiteboard embed for existing board', () => {
    const out = preprocessSynapseMarkdown('![[Existing Board|Pretty]]', notes);
    expect(out).toContain('synapse-board-embed');
    expect(out).not.toContain('is-missing');
    expect(out).toContain('data-note-id="10"');
    expect(out).toContain('data-note-title="Existing Board"');
    expect(out).toContain('data-display-title="Pretty"');
  });

  it('degrades non-whiteboard ![[…]] to a normal wikilink', () => {
    const out = preprocessSynapseMarkdown('![[Plain Note]]', notes);
    expect(out).not.toContain('synapse-board-embed');
    expect(out).toContain('synapse-wikilink');
    expect(out).toContain('data-note-id="11"');
  });

  it('keeps plain missing [[…]] as a missing wikilink (not board create)', () => {
    const out = preprocessSynapseMarkdown('[[Missing Note]]', notes);
    expect(out).not.toContain('synapse-board-embed');
    expect(out).toContain('synapse-wikilink');
    expect(out).toContain('is-missing');
    expect(out).toContain('data-note-title="Missing Note"');
  });
});
