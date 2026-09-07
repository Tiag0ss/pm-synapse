jest.mock('../../server/services/sanitizeSynapseHtml', () => ({
  sanitizeSynapseHtml: (html: string) => html,
}));

import { markdownToSafeHtml, preprocessSynapseMarkdown } from '../../server/services/markdown';

describe('smoke: markdown pipeline', () => {
  it('preprocesses bang-embed then renders HTML without throwing', () => {
    const notes = [
      { id: 42, title: 'Board', path: 'Board.md', kind: 'whiteboard' as const },
    ];
    const md = '# Hello\n\n![[Board]]\n\n![[Missing|Alias Label]]\n';
    const pre = preprocessSynapseMarkdown(md, notes);
    expect(pre).toContain('data-note-id="42"');
    expect(pre).toContain('data-note-title="Missing"');
    expect(pre).toContain('data-display-title="Alias Label"');

    const html = markdownToSafeHtml(md, notes);
    expect(html).toContain('synapse-board-embed');
    expect(html).toContain('Hello');
  });
});
