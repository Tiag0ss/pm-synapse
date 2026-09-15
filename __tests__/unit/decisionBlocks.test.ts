import {
  ensureDecisionMarkers,
  listDecisionMarkerIds,
  noteHasDecisionMarker,
  parseDecisionBlocks,
  parseDecisionOptions,
} from '../../lib/decisionBlocks';
import { preprocessDecisions } from '../../lib/markdownEnhance';
import {
  buildDecisionEventPayload,
  decisionCanBeChanged,
  parseDecisionEventPayload,
  resolveDecisionChoice,
} from '../../server/services/noteDecisions';

describe('decision block markers', () => {
  it('parses :::decision blocks, options, and ensures stable markers', () => {
    const md = [
      ':::decision Should we ship?',
      '- Ship this week',
      '- Delay',
      'ignored prose',
      '* Cancel',
      ':::',
      '',
      'Done.',
    ].join('\n');
    const parsed = parseDecisionBlocks(md);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].markerId).toBeNull();
    expect(parsed[0].title).toBe('Should we ship?');
    expect(parsed[0].options).toEqual(['Ship this week', 'Delay', 'Cancel']);
    expect(parseDecisionOptions(parsed[0].bodyMarkdown)).toEqual([
      'Ship this week',
      'Delay',
      'Cancel',
    ]);

    const ensured = ensureDecisionMarkers(md);
    const ids = listDecisionMarkerIds(ensured);
    expect(ids).toHaveLength(1);
    expect(ensured).toContain(`<!--synapse:decision:${ids[0]}-->`);
    expect(ensureDecisionMarkers(ensured)).toBe(ensured);
    expect(noteHasDecisionMarker(ensured, ids[0])).toBe(true);
    expect(noteHasDecisionMarker(ensured, 'missing')).toBe(false);
  });
});

describe('decision preprocess', () => {
  it('emits synapse-decision with id, title, and options JSON', () => {
    const md = [
      ':::decision Open? <!--synapse:decision:dTestId1-->',
      '- Yes',
      '- No',
      ':::',
    ].join('\n');
    const html = preprocessDecisions(md);
    expect(html).toContain('class="synapse-decision"');
    expect(html).toContain('data-decision-id="dTestId1"');
    expect(html).toContain('data-decision-title="Open?"');
    expect(html).toContain('data-decision-options="[&quot;Yes&quot;,&quot;No&quot;]"');
  });

  it('strips mention HTML from option labels and comments from titles', () => {
    const md = [
      ':::decision Q? <!--synapse:ask:aBad--> <!--synapse:decision:dOk-->',
      '- <span class="synapse-mention"><button>Cenas</button></span> maradas',
      '- 2',
      ':::',
    ].join('\n');
    const html = preprocessDecisions(md);
    expect(html).toContain('data-decision-id="dOk"');
    expect(html).toContain('data-decision-title="Q?"');
    expect(html).toContain('Cenas maradas');
    expect(html).not.toContain('synapse-mention');
    expect(html).not.toContain('&lt;span');
  });
});

describe('resolveDecisionChoice', () => {
  const options = ['A', 'B', 'C'];

  it('accepts a valid option index', () => {
    expect(resolveDecisionChoice({ options, optionIndex: 1 })).toEqual({
      ok: true,
      choiceKind: 'option',
      optionIndex: 1,
      choiceLabel: 'B',
    });
  });

  it('rejects out-of-range option index', () => {
    expect(resolveDecisionChoice({ options, optionIndex: 9 })).toEqual({
      ok: false,
      reason: 'invalid_option',
    });
  });

  it('accepts custom text', () => {
    expect(resolveDecisionChoice({ options, customText: '  Other path  ' })).toEqual({
      ok: true,
      choiceKind: 'custom',
      optionIndex: null,
      choiceLabel: 'Other path',
    });
  });

  it('rejects missing or ambiguous choice', () => {
    expect(resolveDecisionChoice({ options })).toEqual({
      ok: false,
      reason: 'missing_choice',
    });
    expect(resolveDecisionChoice({ options, optionIndex: 0, customText: 'x' })).toEqual({
      ok: false,
      reason: 'missing_choice',
    });
  });
});

describe('decisionCanBeChanged', () => {
  it('blocks changes when locked', () => {
    expect(decisionCanBeChanged({ locked: false })).toBe(true);
    expect(decisionCanBeChanged({ locked: true })).toBe(false);
    expect(decisionCanBeChanged(null)).toBe(true);
  });
});

describe('decision event payloads', () => {
  it('builds and parses chose / lock payloads', () => {
    const chose = buildDecisionEventPayload({
      choiceKind: 'option',
      optionIndex: 0,
      choiceLabel: 'A',
      previousChoiceKind: null,
      previousOptionIndex: null,
      previousChoiceLabel: null,
    });
    expect(parseDecisionEventPayload(chose)).toEqual({
      choiceKind: 'option',
      optionIndex: 0,
      choiceLabel: 'A',
      previousChoiceKind: null,
      previousOptionIndex: null,
      previousChoiceLabel: null,
    });

    const locked = buildDecisionEventPayload({ locked: true });
    expect(parseDecisionEventPayload(locked)).toEqual({ locked: true });
  });
});
