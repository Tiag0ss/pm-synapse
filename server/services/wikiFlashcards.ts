import { canListNoteOnWiki, effectiveVisibility } from './vaultAccess';
import { extractFoldCards, type FoldCard } from './extractFoldCards';

export type WikiFlashcardNoteRow = {
  Id: number | string;
  Title: string;
  Path: string;
  BodyMarkdown?: string | null;
  Visibility?: string | null;
  Kind?: string | null;
};

/**
 * Notes whose :::fold blocks may appear in the public-wiki flashcard deck:
 * same listability as the wiki sidebar/graph, excluding whiteboards.
 */
export function isNoteEligibleForWikiFlashcards(
  noteVisibility: string,
  kind: string | null | undefined,
  isAuthed: boolean,
  canEditVault: boolean
): boolean {
  if (String(kind || 'note') === 'whiteboard') return false;
  return canListNoteOnWiki(noteVisibility, isAuthed, canEditVault);
}

/** Filter + extract fold cards for a public wiki visitor. */
export function buildWikiFlashcards(
  notes: WikiFlashcardNoteRow[],
  vaultDefaultVisibility: unknown,
  isAuthed: boolean,
  canEditVault: boolean
): FoldCard[] {
  return notes
    .filter((n) =>
      isNoteEligibleForWikiFlashcards(
        effectiveVisibility(n.Visibility, vaultDefaultVisibility),
        n.Kind,
        isAuthed,
        canEditVault
      )
    )
    .flatMap((n) =>
      extractFoldCards(String(n.BodyMarkdown || ''), {
        noteId: Number(n.Id),
        title: String(n.Title || ''),
        path: String(n.Path || ''),
      })
    );
}
