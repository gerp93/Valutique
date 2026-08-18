import { AiConnector, ConnectorTestResult } from '../../../shared/types/connector';
import { AiAuthError, AiCapabilityError, AiError, AiRateLimitError, resumeTimeFrom } from '../errors';
import { extractJson, schemaInstruction } from '../jsonExtract';
import { AiProvider, AiRequest, AiResponse } from '../types';

/**
 * Speaks the OpenAI chat-completions wire format, which is the lingua franca
 * for everything that isn't Anthropic or Google: OpenAI itself, OpenRouter,
 * GitHub Models, and -- the reason this matters most here -- every local
 * inference server. Ollama, LM Studio, llama.cpp, vLLM, and Hugging Face TGI
 * all expose it, so running a local Hugging Face vision model needs no code of
 * its own, just a base URL.
 *
 * Local servers implement the spec loosely, so this provider is deliberately
 * forgiving: it degrades from strict schema enforcement to plain JSON mode to
 * prompt-only, rather than failing on a server that doesn't support the
 * newest parameter.
 */

interface ChatResponse {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
  model?: string;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export class OpenAiCompatibleProvider implements AiProvider {
  constructor(private getApiKey: (connectorId: string) => string | null) {}

  async complete(connector: AiConnector, request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    if (request.images.length > 0 && !connector.supportsVision) {
      throw new AiCapabilityError(
        `"${connector.name}" is not configured for image input. Point it at a vision-capable model.`
      );
    }

    const base = (connector.baseUrl || 'http://localhost:11434/v1').replace(/\/+$/, '');
    const model = connector.model || 'qwen2.5vl';
    const apiKey = this.getApiKey(connector.id);

    const systemText = request.schema ? `${request.system}\n\n${schemaInstruction(request.schema)}` : request.system;

    const parts: ContentPart[] = [
      ...request.images.map(
        (image): ContentPart => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${image.base64}` },
        })
      ),
      { type: 'text', text: request.prompt },
    ];

    const baseBody: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? connector.maxTokens ?? 8000,
      messages: [
        { role: 'system', content: systemText },
        { role: 'user', content: parts },
      ],
      ...connector.extraParams,
    };

    // Try the strongest output constraint the connector claims, then fall back.
    // A local server rejecting `json_schema` is common and shouldn't fail a job
    // when the prompt already carries the schema.
    const attempts: Record<string, unknown>[] = [];
    if (request.schema && connector.supportsStructuredOutput) {
      attempts.push({
        ...baseBody,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'result', schema: request.schema, strict: false },
        },
      });
      attempts.push({ ...baseBody, response_format: { type: 'json_object' } });
    } else if (request.schema) {
      attempts.push({ ...baseBody, response_format: { type: 'json_object' } });
    }
    attempts.push(baseBody);

    let lastError: AiError | null = null;

    for (const body of attempts) {
      try {
        return await this.send(connector, base, model, apiKey, body, request, signal);
      } catch (err) {
        const aiError = err instanceof AiError ? err : new AiError(String(err), true);
        // Only a 4xx is worth degrading over -- an auth failure or a rate limit
        // will fail identically on the next attempt.
        if (aiError instanceof AiAuthError || aiError instanceof AiRateLimitError || aiError.retryable) {
          throw aiError;
        }
        lastError = aiError;
      }
    }

    throw lastError ?? new AiError('Request failed.', false);
  }

  private async send(
    connector: AiConnector,
    base: string,
    model: string,
    apiKey: string | null,
    body: Record<string, unknown>,
    request: AiRequest,
    signal?: AbortSignal
  ): Promise<AiResponse> {
    const headers = {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    };
    const payloadBody = JSON.stringify(body);

    // Local servers are commonly reachable on one IP family only. Ollama binds
    // to 127.0.0.1 and not ::1, and Node resolves "localhost" to ::1 first, so
    // a server the user can plainly see in a browser refuses us instantly.
    // Retrying on the literal IPv4 address closes that gap.
    const endpoints = [`${base}/chat/completions`];
    const ipv4Alternate = toIpv4Localhost(base);
    if (ipv4Alternate) endpoints.push(`${ipv4Alternate}/chat/completions`);

    let httpResponse: Response | null = null;
    let lastNetworkError = '';

    for (const endpoint of endpoints) {
      try {
        httpResponse = await fetch(endpoint, { method: 'POST', headers, body: payloadBody, signal });
        break;
      } catch (err) {
        lastNetworkError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!httpResponse) {
      throw new AiError(describeNetworkFailure(base, endpoints.length > 1, lastNetworkError), true);
    }

    if (!httpResponse.ok) {
      const text = await safeText(httpResponse);
      throw translateHttpError(httpResponse.status, text, httpResponse.headers.get('retry-after'));
    }

    const payload = (await httpResponse.json()) as ChatResponse;
    if (payload.error) {
      throw new AiError(payload.error.message ?? 'Request failed.', false);
    }

    const choice = payload.choices?.[0];
    const text = (choice?.message?.content ?? '').trim();

    if (!text && choice?.finish_reason === 'length') {
      throw new AiError('Response hit the token limit before producing any output. Raise Max tokens for this connector.', true);
    }

    return {
      json: request.schema ? extractJson(text) : null,
      text,
      tokensIn: payload.usage?.prompt_tokens ?? null,
      tokensOut: payload.usage?.completion_tokens ?? null,
      // No provider in this family offers server-side web search through this
      // endpoint. Appraisals here are model memory only, which is why the
      // connector declares supportsWebSearch false and the UI warns about it.
      webSearches: 0,
      searchUrls: [],
      model: payload.model ?? model,
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

/** The same URL with a `localhost` host swapped for 127.0.0.1, or null if it isn't local. */
function toIpv4Localhost(base: string): string | null {
  try {
    const url = new URL(base);
    if (url.hostname !== 'localhost' && url.hostname !== '::1' && url.hostname !== '[::1]') return null;
    url.hostname = '127.0.0.1';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function describeNetworkFailure(base: string, triedIpv4: boolean, detail: string): string {
  const isLocal = /localhost|127\.0\.0\.1|::1/.test(base);

  if (!isLocal) {
    return `Could not reach ${base}: ${detail}`;
  }

  // Being specific matters here: "is it running?" is actively unhelpful advice
  // when the user is looking at the server's own status page in a browser.
  return triedIpv4
    ? `Could not reach the local server at ${base}, on either IPv6 or IPv4. Check the server is listening on port ${portOf(base)} and that the base URL ends in /v1.`
    : `Could not reach the local server at ${base}: ${detail}`;
}

function portOf(base: string): string {
  try {
    return new URL(base).port || '(default)';
  } catch {
    return '(unknown)';
  }
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
      'The endpoint is rate limiting. The queue will resume automatically.',
      resumeTimeFrom(retryAfter, 5 * 60 * 1000),
      body
    );
  }
  if (status === 401 || status === 403) {
    return new AiAuthError('The endpoint rejected the API key.', body);
  }
  if (status === 404) {
    // "Model not found" and "wrong URL entirely" look identical at this layer,
    // and the fix is different for each -- so tell them apart before the
    // connector gets blamed for the wrong thing.
    const modelMissing = /model.*not found|no such model|not_found_error/i.test(body);
    return new AiError(
      modelMissing
        ? "That model isn't available on this server. Use \"List models\" in the connector's settings to see what it actually has."
        : 'Nothing answered at that URL. Check the base URL — it usually needs to end in /v1.',
      false,
      body
    );
  }
  if (status >= 500) {
    return new AiError('The endpoint returned a server error.', true, body);
  }
  return new AiError(`Request failed (${status}).`, false, body);
}
