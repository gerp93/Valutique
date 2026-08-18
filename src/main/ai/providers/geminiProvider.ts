import { AiConnector, ConnectorTestResult } from '../../../shared/types/connector';
import { AiAuthError, AiCapabilityError, AiError, AiRateLimitError, resumeTimeFrom } from '../errors';
import { extractJson, schemaInstruction } from '../jsonExtract';
import { AiProvider, AiRequest, AiResponse, JsonSchema } from '../types';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
    groundingMetadata?: {
      groundingChunks?: { web?: { uri?: string } }[];
      webSearchQueries?: string[];
    };
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
  promptFeedback?: { blockReason?: string };
}

export class GeminiProvider implements AiProvider {
  constructor(private getApiKey: (connectorId: string) => string | null) {}

  async complete(connector: AiConnector, request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const apiKey = this.getApiKey(connector.id);
    if (!apiKey) {
      throw new AiAuthError(`No API key stored for "${connector.name}". Add one in Settings.`);
    }
    if (request.images.length > 0 && !connector.supportsVision) {
      throw new AiCapabilityError(`"${connector.name}" is not configured for image input.`);
    }

    const model = connector.model || 'gemini-3.7-flash';
    const base = (connector.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    const wantsSearch = Boolean(request.webSearch?.enabled) && connector.supportsWebSearch;

    // Gemini can enforce a response schema *or* ground with search, but the two
    // together are unreliable across model versions. When searching, ask for
    // JSON via mime type and prompt text and parse defensively.
    const useResponseSchema = Boolean(request.schema) && !wantsSearch && connector.supportsStructuredOutput;

    const systemText =
      request.schema && !useResponseSchema
        ? `${request.system}\n\n${schemaInstruction(request.schema)}`
        : request.system;

    const parts: GeminiPart[] = [
      ...request.images.map((image) => ({
        inline_data: { mime_type: image.mediaType, data: image.base64 },
      })),
      { text: request.prompt },
    ];

    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: 'user', parts }],
      generationConfig: {
        maxOutputTokens: request.maxTokens ?? connector.maxTokens ?? 8000,
        ...(request.schema ? { responseMimeType: 'application/json' } : {}),
        ...(useResponseSchema ? { responseSchema: toGeminiSchema(request.schema!) } : {}),
      },
      ...(wantsSearch ? { tools: [{ google_search: {} }] } : {}),
      ...connector.extraParams,
    };

    const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;

    let httpResponse: Response;
    try {
      httpResponse = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      throw new AiError(`Could not reach Gemini: ${err instanceof Error ? err.message : String(err)}`, true);
    }

    if (!httpResponse.ok) {
      throw translateHttpError(httpResponse.status, await safeText(httpResponse), httpResponse.headers.get('retry-after'));
    }

    const payload = (await httpResponse.json()) as GeminiResponse;

    if (payload.error) {
      throw new AiError(payload.error.message ?? 'Gemini returned an error.', false);
    }
    if (payload.promptFeedback?.blockReason) {
      throw new AiError(`Gemini blocked this request (${payload.promptFeedback.blockReason}).`, false);
    }

    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();

    const grounding = candidate?.groundingMetadata;
    const searchUrls = (grounding?.groundingChunks ?? [])
      .map((chunk) => chunk.web?.uri)
      .filter((uri): uri is string => Boolean(uri));

    if (!text && candidate?.finishReason === 'MAX_TOKENS') {
      throw new AiError('Response hit the token limit before producing any output. Raise Max tokens for this connector.', true);
    }

    return {
      json: request.schema ? extractJson(text) : null,
      text,
      tokensIn: payload.usageMetadata?.promptTokenCount ?? null,
      tokensOut: payload.usageMetadata?.candidatesTokenCount ?? null,
      // Gemini bills grounding per grounded request rather than per query, so
      // a grounded response counts as one regardless of how many queries ran.
      webSearches: grounding ? Math.max(1, grounding.webSearchQueries?.length ?? 1) : 0,
      searchUrls: Array.from(new Set(searchUrls)),
      model,
    };
  }

  async test(connector: AiConnector): Promise<ConnectorTestResult> {
    const started = Date.now();
    try {
      const response = await this.complete(connector, {
        system: 'You are a connection test.',
        prompt: 'Reply with the single word: ready',
        images: [],
        maxTokens: 32,
      });
      return {
        ok: true,
        message: 'Connected.',
        latencyMs: Date.now() - started,
        detail: `Model ${response.model} responded.`,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
        detail: err instanceof AiError ? err.detail ?? null : null,
      };
    }
  }
}

/**
 * Gemini's response_schema uses a stricter OpenAPI-derived subset than
 * Anthropic's structured outputs -- it rejects unknown keys like
 * `additionalProperties` outright (400, "Unknown name") instead of ignoring
 * them, at any nesting depth. Strip it recursively rather than build a
 * second schema from scratch, since `anyOf`/`enum`/`required` all carry
 * through unchanged.
 */
function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const { additionalProperties: _additionalProperties, ...rest } = schema;
  const clone: JsonSchema = { ...rest };
  if (clone.properties) {
    clone.properties = Object.fromEntries(
      Object.entries(clone.properties).map(([key, value]) => [key, toGeminiSchema(value)])
    );
  }
  if (clone.items) clone.items = toGeminiSchema(clone.items);
  if (clone.anyOf) clone.anyOf = clone.anyOf.map(toGeminiSchema);
  return clone;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 2000);
  } catch {
    return '';
  }
}

function translateHttpError(status: number, body: string, retryAfter: string | null): AiError {
  if (status === 429) {
    return new AiRateLimitError(
      'Gemini is rate limiting. The queue will resume automatically.',
      resumeTimeFrom(retryAfter, 5 * 60 * 1000),
      body
    );
  }
  if (status === 401 || status === 403) {
    return new AiAuthError('Gemini rejected the API key.', body);
  }
  if (status >= 500) {
    return new AiError('Gemini returned a server error.', true, body);
  }
  return new AiError(`Gemini request failed (${status}).`, false, body);
}
