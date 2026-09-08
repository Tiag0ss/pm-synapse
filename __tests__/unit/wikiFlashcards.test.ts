import {
  buildWikiFlashcards,
  isNoteEligibleForWikiFlashcards,
} from '../../server/services/wikiFlashcards';

describe('wiki flashcards visibility', () => {
  const foldBody = 'Intro\n\n:::fold- What is X?\nAnswer about X\n:::\n';

  const notes = [
    {
      Id: 1,
      Title: 'Public Note',
      Path: 'Public Note.md',
      BodyMarkdown: foldBody,
      Visibility: 'public',
      Kind: 'note',
    },
    {
      Id: 2,
      Title: 'Auth Note',
      Path: 'Auth Note.md',
      BodyMarkdown: ':::fold Auth Q\nAuth A\n:::\n',
      Visibility: 'authenticated',
      Kind: 'note',
    },
    {
      Id: 3,
      Title: 'Private Note',
      Path: 'Private Note.md',
      BodyMarkdown: ':::fold Secret\nNope\n:::\n',
      Visibility: 'private',
      Kind: 'note',
    },
    {
      Id: 4,
      Title: 'Unlisted Note',
      Path: 'Unlisted Note.md',
      BodyMarkdown: ':::fold Hidden list\nBody\n:::\n',
      Visibility: 'unlisted',
      Kind: 'note',
    },
    {
      Id: 5,
      Title: 'Board',
      Path: 'Board.md',
      BodyMarkdown: ':::fold Board card\nShould skip\n:::\n',
      Visibility: 'public',
      Kind: 'whiteboard',
    },
  ];

  it('isNoteEligibleForWikiFlashcards matches list rules', () => {
    expect(isNoteEligibleForWikiFlashcards('public', 'note', false, false)).toBe(true);
    expect(isNoteEligibleForWikiFlashcards('authenticated', 'note', false, false)).toBe(false);
    expect(isNoteEligibleForWikiFlashcards('authenticated', 'note', true, false)).toBe(true);
    expect(isNoteEligibleForWikiFlashcards('private', 'note', true, false)).toBe(false);
    expect(isNoteEligibleForWikiFlashcards('unlisted', 'note', true, false)).toBe(false);
    expect(isNoteEligibleForWikiFlashcards('private', 'note', true, true)).toBe(true);
    expect(isNoteEligibleForWikiFlashcards('public', 'whiteboard', false, false)).toBe(false);
  });

  it('guest deck includes only public note folds', () => {
    const cards = buildWikiFlashcards(notes, 'private', false, false);
    expect(cards.map((c) => c.front)).toEqual(['What is X?']);
    expect(cards[0].sourceNoteId).toBe(1);
  });

  it('signed-in deck adds authenticated folds, still skips private/unlisted/whiteboard', () => {
    const cards = buildWikiFlashcards(notes, 'private', true, false);
    expect(cards.map((c) => c.front).sort()).toEqual(['Auth Q', 'What is X?']);
  });

  it('vault editor deck includes private and unlisted folds', () => {
    const cards = buildWikiFlashcards(notes, 'private', true, true);
    const fronts = cards.map((c) => c.front).sort();
    expect(fronts).toEqual(['Auth Q', 'Hidden list', 'Secret', 'What is X?']);
    expect(fronts).not.toContain('Board card');
  });
});
