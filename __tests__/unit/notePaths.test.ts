import { resolveNoteId } from '../../server/services/notePaths';

describe('resolveNoteId', () => {
  const notes = [
    { id: 1, title: 'meta/risks', path: 'meta/risks.md', kind: 'note' as const },
    { id: 2, title: 'alpha', path: 'folder/alpha.md', kind: 'note' as const },
    { id: 3, title: 'beta', path: 'other/beta.md', kind: 'whiteboard' as const },
  ];

  it('resolves by title and path stem', () => {
    expect(resolveNoteId('meta/risks', notes)).toBe(1);
    expect(resolveNoteId('folder/alpha', notes)).toBe(2);
  });

  it('resolves unique leaf names', () => {
    expect(resolveNoteId('alpha', notes)).toBe(2);
    expect(resolveNoteId('beta', notes)).toBe(3);
  });

  it('returns null when missing', () => {
    expect(resolveNoteId('nope', notes)).toBeNull();
  });
});
