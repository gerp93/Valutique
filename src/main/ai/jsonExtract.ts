/**
 * Pulling structured data out of a text reply.
 *
 * Providers that can enforce a JSON schema server-side return clean JSON and
 * this module is a no-op. It exists for the ones that can't -- local models,
 * both CLI connectors, and any provider whose search mode is incompatible with
 * strict output. Those wrap JSON in prose, fence it in markdown, or emit it
 * after a paragraph of preamble, and a naive `JSON.parse` on the whole reply
 * fails on all three.
 */

/** Strips markdown code fences, with or without a language tag. */
function stripFences(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n?```/i);
  return fenced ? fenced[1] : text;
}

/**
 * Finds the first balanced JSON object or array in a string, respecting string
 * literals and escapes so a brace inside a description doesn't end the scan
 * early.
 */
function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const opening = text[start];
  const closing = opening === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const char = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === opening) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

/** Best-effort parse. Returns null rather than throwing so callers decide what a miss means. */
export function extractJson(text: string): unknown | null {
  if (!text) return null;

  const attempts = [text, stripFences(text)];

  for (const attempt of attempts) {
    const trimmed = attempt.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // fall through to the balanced-scan attempt
    }
  }

  const candidate = firstBalanced(stripFences(text));
  if (candidate) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Models occasionally leave a trailing comma before a closing brace.
      try {
        return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1'));
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Rendered into the prompt for providers with no server-side schema
 * enforcement. Being explicit that the entire reply must be the object, with no
 * prose, measurably reduces the preamble those models otherwise add.
 */
export function schemaInstruction(schema: unknown): string {
  return [
    'Reply with a single JSON object and nothing else.',
    'No preamble, no explanation outside the JSON, no markdown code fences.',
    'It must match this JSON Schema exactly:',
    JSON.stringify(schema, null, 2),
    'Use null for any field you cannot determine from the evidence. Do not invent values to fill gaps.',
  ].join('\n');
}
