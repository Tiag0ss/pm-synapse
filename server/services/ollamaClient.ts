import { getSetting, getSettingBool, SETTING_KEYS } from './appSettings';
import logger from '../utils/logger';

const MAX_PROPOSED = 30;

export type ProposedTodoSuggestion = {
  content: string;
  hours?: number | null;
  category?: string | null;
  status?: string;
  rationale?: string | null;
};

export class OllamaError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'OllamaError';
    this.status = status;
  }
}

function stripJsonFence(text: string): string {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJsonContent(raw: string): unknown {
  const text = stripJsonFence(raw);
  try {
    return JSON.parse(text);
  } catch {
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      try {
        return JSON.parse(text.slice(objStart, objEnd + 1));
      } catch {
        /* continue */
      }
    }
    const arrStart = text.indexOf('[');
    const arrEnd = text.lastIndexOf(']');
    if (arrStart >= 0 && arrEnd > arrStart) {
      try {
        return JSON.parse(text.slice(arrStart, arrEnd + 1));
      } catch {
        /* continue */
      }
    }
    throw new OllamaError('Ollama returned invalid JSON', 502);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function coerceHours(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;
  if (typeof raw === 'boolean') return null;
  const s = String(raw).trim().toLowerCase().replace(',', '.');
  const match = s.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const v = obj[key];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number') {
      const s = String(v).trim();
      if (s) return s;
    }
  }
  return '';
}

function normalizeOneItem(raw: unknown): ProposedTodoSuggestion | null {
  if (typeof raw === 'string') {
    const content = raw.trim();
    return content
      ? { content, hours: null, category: null, status: 'pending', rationale: null }
      : null;
  }
  if (!isPlainObject(raw)) return null;

  const content = pickString(raw, [
    'content',
    'title',
    'task',
    'name',
    'summary',
    'description',
    'text',
    'todo',
  ]).slice(0, 500);
  if (!content) return null;

  const category =
    pickString(raw, ['category', 'categoria', 'cat', 'type', 'label']).slice(0, 128) || null;
  const status = pickString(raw, ['status', 'state']).slice(0, 64) || 'pending';
  const rationale =
    pickString(raw, ['rationale', 'reason', 'why', 'note', 'explanation']).slice(0, 500) ||
    null;
  const hours = coerceHours(raw.hours ?? raw.estimate ?? raw.estimatedHours ?? raw.effort);

  return { content, hours, category, status, rationale };
}

/** Accept common model shapes: {proposed|todos|tasks|items:[]}, bare [], or single object. */
function normalizeProposedList(parsed: unknown): ProposedTodoSuggestion[] {
  let list: unknown[] = [];

  if (Array.isArray(parsed)) {
    list = parsed;
  } else if (isPlainObject(parsed)) {
    const candidates = [
      parsed.proposed,
      parsed.todos,
      parsed.tasks,
      parsed.items,
      parsed.suggestions,
      parsed.results,
      parsed.data,
    ];
    for (const c of candidates) {
      if (Array.isArray(c)) {
        list = c;
        break;
      }
      if (isPlainObject(c) && Array.isArray(c.proposed)) {
        list = c.proposed;
        break;
      }
    }
    if (!list.length) {
      const single = normalizeOneItem(parsed);
      if (single) return [single];
    }
  }

  const out: ProposedTodoSuggestion[] = [];
  for (const item of list) {
    const n = normalizeOneItem(item);
    if (n) out.push(n);
    if (out.length >= MAX_PROPOSED) break;
  }
  return out;
}

const SYSTEM_INSTRUCTIONS = `You are a careful project analyst. Read the entire note and extract concrete work items for YAML frontmatter todos.

Return ONLY valid JSON with this shape:
{"proposed":[{"content":"…","hours":2,"category":"Design","status":"pending","rationale":"…"}]}

Field rules:
- content: required string (actionable task title)
- hours: number or omit (not a string)
- category, status, rationale: optional strings

Analysis (do all of these):
1. Read every section, heading, bullet, checkbox, table, and callout — not just the opening paragraph.
2. Turn open questions, risks, decisions needed, follow-ups, and unchecked boxes into actionable todos.
3. Prefer specific deliverables over vague themes (bad: "Work on project"; good: "Draft API contract for vault media upload").
4. Infer hours when the note implies effort; otherwise omit hours.
5. Use category when clear (e.g. Design, Development, Research, Documentation, Meeting, Other).
6. Write "content" in the same language as the note body.
7. Do not invent Project Management project/task IDs.
8. Skip items that duplicate existing todos (same meaning, not only same wording).
9. Propose a thorough set when the note is rich (typically 5–20); fewer only for short notes. Cap at ${MAX_PROPOSED}.
10. Each rationale must cite what in the note triggered the todo (section/phrase), one short sentence.`;

function normalizeOllamaBaseUrl(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '');
}

/** List local models from Ollama `GET /api/tags`. */
export async function listOllamaModels(baseUrlOverride?: string | null): Promise<string[]> {
  const fromSettings = (await getSetting(SETTING_KEYS.ollamaBaseUrl)) || '';
  const baseUrl = normalizeOllamaBaseUrl(baseUrlOverride != null ? baseUrlOverride : fromSettings);
  if (!baseUrl) {
    throw new OllamaError('Ollama base URL is not configured', 400);
  }

  const url = `${baseUrl}/api/tags`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let response: Response;
  try {
    response = await fetch(url, { method: 'GET', signal: controller.signal });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new OllamaError('Ollama request timed out', 504);
    }
    logger.error('Ollama tags request failed', { error, url });
    throw new OllamaError(
      'Could not reach Ollama — check base URL and that the service is running',
      502
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new OllamaError(`Ollama returned HTTP ${response.status}`, 502);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OllamaError('Ollama returned a non-JSON response', 502);
  }

  const models =
    payload &&
    typeof payload === 'object' &&
    Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: Array<{ name?: unknown }> }).models
      : [];

  const names = models
    .map((m) => (m?.name != null ? String(m.name).trim() : ''))
    .filter(Boolean);

  return [...new Set(names)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export async function suggestTodosFromNote(input: {
  title: string;
  path?: string | null;
  bodyMarkdown: string;
  existingTodoTitles: string[];
}): Promise<ProposedTodoSuggestion[]> {
  const enabled = await getSettingBool(SETTING_KEYS.aiEnabled, false);
  if (!enabled) {
    throw new OllamaError('AI suggestions are disabled in Admin settings', 400);
  }

  const baseUrlRaw = (await getSetting(SETTING_KEYS.ollamaBaseUrl)) || '';
  const model = ((await getSetting(SETTING_KEYS.ollamaModel)) || '').trim();
  const baseUrl = normalizeOllamaBaseUrl(baseUrlRaw);
  if (!baseUrl) {
    throw new OllamaError('Ollama base URL is not configured', 400);
  }
  if (!model) {
    throw new OllamaError('Ollama model name is not configured', 400);
  }

  const fullMarkdown = String(input.bodyMarkdown || '');
  const markdownForModel =
    fullMarkdown.length > 200_000
      ? `${fullMarkdown.slice(0, 200_000)}\n\n[…truncated ${fullMarkdown.length - 200_000} chars…]`
      : fullMarkdown;

  const existingList =
    input.existingTodoTitles.length > 0
      ? input.existingTodoTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')
      : '(none)';

  const userContent = [
    'Analyze the FULL note below end-to-end. Do not stop after the first section.',
    '',
    `Note title: ${input.title || '(untitled)'}`,
    input.path ? `Note path: ${input.path}` : null,
    `Note length: ${fullMarkdown.length} characters`,
    '',
    'Existing frontmatter todos (do not duplicate these):',
    existingList,
    '',
    '===== BEGIN FULL NOTE MARKDOWN =====',
    markdownForModel,
    '===== END FULL NOTE MARKDOWN =====',
    '',
    'Respond with JSON only: {"proposed":[{"content":"task title","hours":2,"category":"Design","status":"pending","rationale":"from section X"}]}',
  ]
    .filter((line) => line != null)
    .join('\n');

  logger.info('Ollama suggest-todos request', {
    model,
    title: input.title,
    path: input.path || null,
    noteChars: fullMarkdown.length,
    promptChars: userContent.length,
    existingCount: input.existingTodoTitles.length,
  });

  const url = `${baseUrl}/api/chat`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        keep_alive: '5m',
        options: {
          temperature: 0.2,
          // Large notes (~68k chars) need a wide window; 3B models still may struggle.
          num_ctx: 32768,
          num_predict: 4096,
        },
        messages: [
          { role: 'system', content: SYSTEM_INSTRUCTIONS },
          { role: 'user', content: userContent },
        ],
      }),
    });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') {
      throw new OllamaError('Ollama request timed out', 504);
    }
    logger.error('Ollama request failed', { error, url });
    throw new OllamaError(
      'Could not reach Ollama — check base URL and that the service is running',
      502
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    logger.warn('Ollama HTTP error', { status: response.status, detail: detail.slice(0, 500) });
    throw new OllamaError(
      response.status === 404
        ? 'Ollama model not found — pull it on the Ollama host or change the model name'
        : `Ollama returned HTTP ${response.status}`,
      502
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OllamaError('Ollama returned a non-JSON response', 502);
  }

  const message =
    payload &&
    typeof payload === 'object' &&
    'message' in payload &&
    payload.message &&
    typeof payload.message === 'object' &&
    'content' in (payload.message as object)
      ? String((payload.message as { content?: unknown }).content || '')
      : '';

  if (!message.trim()) {
    logger.warn('Ollama empty message', {
      model,
      keys: payload && typeof payload === 'object' ? Object.keys(payload as object) : [],
    });
    throw new OllamaError('Ollama returned an empty message', 502);
  }

  let parsedJson: unknown;
  try {
    parsedJson = parseJsonContent(message);
  } catch (error) {
    logger.warn('Ollama JSON parse failed', {
      model,
      preview: message.slice(0, 800),
    });
    if (error instanceof OllamaError) throw error;
    throw new OllamaError('Ollama returned invalid JSON', 502);
  }

  const proposed = normalizeProposedList(parsedJson);
  if (!proposed.length) {
    logger.warn('Ollama JSON shape unmatched', {
      model,
      preview: message.slice(0, 800),
      topType: Array.isArray(parsedJson) ? 'array' : typeof parsedJson,
      topKeys: isPlainObject(parsedJson) ? Object.keys(parsedJson).slice(0, 20) : [],
    });
    throw new OllamaError(
      'Ollama returned JSON without usable todos — try again or use a larger model',
      502
    );
  }

  logger.info('Ollama suggest-todos response', {
    model,
    proposedCount: proposed.length,
  });

  return proposed;
}
