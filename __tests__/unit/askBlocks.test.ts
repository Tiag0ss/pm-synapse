import {
  ensureAskMarkers,
  listAskMarkerIds,
  noteHasAskMarker,
  parseAskBlocks,
} from '../../lib/askBlocks';
import { preprocessAsks } from '../../lib/markdownEnhance';
import {
  buildAskEventPayload,
  filterAskAnswersForShare,
  filterAskAnswersForWikiPreview,
  guestCanMutateAskAnswer,
  parseAskEventPayload,
} from '../../server/services/noteAskAnswers';

describe('ask block markers', () => {
  it('parses :::ask blocks and ensures stable markers', () => {
    const md = [':::ask What is the risk?', 'Optional hint', ':::', '', 'Done.'].join('\n');
    const parsed = parseAskBlocks(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].markerId).toBeNull();
    expect(parsed[0].question).toBe('What is the risk?');
    expect(parsed[0].bodyMarkdown).toBe('Optional hint');

    const ensured = ensureAskMarkers(md);
    const ids = listAskMarkerIds(ensured);
    expect(ids).toHaveLength(1);
    expect(ensured).toContain(`<!--synapse:ask:${ids[0]}-->`);
    expect(ensureAskMarkers(ensured)).toBe(ensured);
    expect(noteHasAskMarker(ensured, ids[0])).toBe(true);
    expect(noteHasAskMarker(ensured, 'missing')).toBe(false);
  });
});

describe('ask preprocess', () => {
  it('emits synapse-ask with data-ask-id and data-ask-question', () => {
    const md = [
      ':::ask Open question? <!--synapse:ask:aTestId1-->',
      'Hint body',
      ':::',
    ].join('\n');
    const html = preprocessAsks(md);
    expect(html).toContain('class="synapse-ask"');
    expect(html).toContain('data-ask-id="aTestId1"');
    expect(html).toContain('data-ask-question="Open question?"');
    expect(html).toContain('synapse-ask-hint');
  });
});

describe('ask answer filters', () => {
  const rows = [
    { id: 1, status: 'pending', deletedAt: null },
    { id: 2, status: 'approved', deletedAt: null },
    { id: 3, status: 'approved', deletedAt: '2026-01-01T00:00:00.000Z' },
    { id: 4, status: 'pending', DeletedAt: '2026-01-02T00:00:00.000Z' },
  ];

  it('share keeps non-deleted of any status', () => {
    expect(filterAskAnswersForShare(rows).map((r) => r.id)).toEqual([1, 2]);
  });

  it('wiki/preview keeps approved non-deleted only', () => {
    expect(filterAskAnswersForWikiPreview(rows).map((r) => r.id)).toEqual([2]);
  });
});

describe('ask event payloads', () => {
  it('builds and parses submitted / status / deleted payloads', () => {
    const submitted = buildAskEventPayload({
      body: 'Hello',
      authorName: 'Ada',
      toStatus: 'pending',
    });
    expect(JSON.parse(submitted)).toEqual({
      body: 'Hello',
      authorName: 'Ada',
      toStatus: 'pending',
    });

    const approved = buildAskEventPayload({
      body: 'Hello',
      authorName: 'Ada',
      fromStatus: 'pending',
      toStatus: 'approved',
    });
    expect(parseAskEventPayload(approved)).toEqual({
      body: 'Hello',
      authorName: 'Ada',
      fromStatus: 'pending',
      toStatus: 'approved',
    });

    const deleted = buildAskEventPayload({
      body: 'Gone',
      authorName: 'Bob',
      fromStatus: 'approved',
    });
    expect(parseAskEventPayload(deleted)).toEqual({
      body: 'Gone',
      authorName: 'Bob',
      fromStatus: 'approved',
    });

    const edited = buildAskEventPayload({
      body: 'New',
      authorName: 'Ada',
      previousBody: 'Old',
      previousAuthorName: 'Ada',
      fromStatus: 'pending',
      toStatus: 'pending',
    });
    expect(parseAskEventPayload(edited)).toMatchObject({
      body: 'New',
      previousBody: 'Old',
    });
  });
});

describe('guestCanMutateAskAnswer', () => {
  it('allows only pending non-deleted answers', () => {
    expect(guestCanMutateAskAnswer({ status: 'pending', deletedAt: null })).toBe(true);
    expect(guestCanMutateAskAnswer({ status: 'approved', deletedAt: null })).toBe(false);
    expect(
      guestCanMutateAskAnswer({ status: 'pending', deletedAt: '2026-01-01T00:00:00.000Z' })
    ).toBe(false);
  });
});
