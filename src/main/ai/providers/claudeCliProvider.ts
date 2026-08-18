import { AiConnector, ConnectorTestResult } from '../../../shared/types/connector';
import { AiError, AiRateLimitError, looksRateLimited } from '../errors';
import { extractJson, schemaInstruction } from '../jsonExtract';
import { AiProvider, AiRequest, AiResponse } from '../types';
import { createWorkspace, DEFAULT_CLI_TIMEOUT_MS, isUnknownFlagError, runCli, CliResult } from './cliRunner';
import { resolveCliCommand } from '../../cliDetect';

/**
 * Claude Code as a connector.
 *
 * Runs `claude -p` against the login the user already has, so a batch consumes
 * Claude Pro/Max subscription allowance rather than API credits. It brings its
 * own Read and WebSearch tools, which means appraisals get real, citable comps
 * without a separate search bill.
 *
 * The tradeoff is speed and rate limits: each item is a process launch plus an
 * agent loop, and subscription plans enforce usage windows. The job runner
 * treats a hit window as a pause-and-resume rather than a failure.
 */

interface ClaudeJsonOutput {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  duration_ms?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** One line of `--output-format stream-json` -- shape observed from a live run, not the full spec. */
interface StreamEvent {
  type?: string;
  model?: string;
  message?: {
    content?: { type?: string; text?: string; name?: string; input?: unknown; content?: unknown; is_error?: boolean }[];
  };
  result?: string;
  is_error?: boolean;
  duration_ms?: number;
  total_cost_usd?: number;
}

/**
 * Turns one line of the CLI's streamed event log into something worth showing
 * live, or null to skip it. This is what makes an agent run watchable instead
 * of a silent black box for however many minutes it takes -- the incident that
 * prompted this: a job sat at "running" for ten minutes with zero visibility
 * into whether it was making progress or wedged.
 */
function describeStreamEvent(event: StreamEvent): string | null {
  if (event.type === 'system') {
    return event.model ? `Started (${event.model})` : 'Started';
  }

  if (event.type === 'assistant' || event.type === 'user') {
    const lines: string[] = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === 'text' && block.text) {
        lines.push(truncate(block.text.trim()));
      } else if (block.type === 'thinking') {
        // Thinking blocks carry their text under a different key across
        // versions; stringify defensively rather than assume one.
        lines.push(`Thinking: ${truncate(JSON.stringify(block).slice(0, 300))}`);
      } else if (block.type === 'tool_use' && block.name) {
        lines.push(`Using ${block.name}${block.input ? `(${truncate(JSON.stringify(block.input), 150)})` : ''}`);
      } else if (block.type === 'tool_result') {
        const summary = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        lines.push(block.is_error ? `Tool error: ${truncate(summary)}` : `Tool result: ${truncate(summary)}`);
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }

  if (event.type === 'result') {
    const seconds = event.duration_ms ? (event.duration_ms / 1000).toFixed(1) : null;
    const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : '';
    return `Finished${seconds ? ` in ${seconds}s` : ''}${cost}${event.is_error ? ' (error)' : ''}`;
  }

  return null;
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Wraps an onChunk callback with newline buffering so partial reads (which is
 * all a subprocess pipe ever guarantees) don't get parsed as partial JSON.
 * Each complete line is parsed and handed to `describeStreamEvent`.
 */
function makeStreamLineParser(onLine: (line: string) => void): (stream: 'stdout' | 'stderr', text: string) => void {
  let buffer = '';
  return (stream, text) => {
    if (stream === 'stderr') {
      if (text.trim()) onLine(text.trim());
      return;
    }
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        const described = describeStreamEvent(JSON.parse(trimmed) as StreamEvent);
        if (described) onLine(described);
      } catch {
        // Not a JSON line (the plain-text fallback path) -- show it as-is.
        onLine(trimmed);
      }
    }
  };
}

export class ClaudeCliProvider implements AiProvider {
  async complete(connector: AiConnector, request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    // Resolve rather than trust the stored value: a connector saved before
    // the tool moved -- or saved with a bare name when it lives outside this
    // process's PATH -- would otherwise fail with a misleading 'not
    // recognized' error the app already knows how to fix.
    const command = await resolveCliCommand(connector.cliCommand || 'claude');
    const workspace = createWorkspace(request.images);

    try {
      const prompt = buildPrompt(request, workspace.imageFiles);

      // Read is needed for the photos; WebSearch/WebFetch only matter for
      // appraisal. Nothing that writes is ever allowed.
      const allowedTools = request.webSearch?.enabled ? 'Read,Glob,WebSearch,WebFetch' : 'Read,Glob';

      // Every argument here is a bare flag with no spaces; the prompt itself
      // goes on stdin, so nothing needs quoting and nothing hits the Windows
      // command-line length limit.
      //
      // stream-json (over plain json) is what makes the run watchable: it
      // emits one event per turn -- a tool call, a chunk of text -- as they
      // happen, instead of staying completely silent until the whole thing
      // finishes. --verbose is required alongside it.
      const richArgs = [
        // The user's own flags go first so ours always win a conflict; the
        // Settings form already rejects the flags Valutique depends on.
        ...connector.cliArgs,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        allowedTools,
        ...(connector.model ? ['--model', connector.model] : []),
      ];

      const onChunk = request.onCliOutput ? makeStreamLineParser(request.onCliOutput) : undefined;

      let result = await runCli({
        command,
        args: richArgs,
        stdin: prompt,
        cwd: workspace.dir,
        timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
        signal,
        onChunk,
      });

      // CLI flags move between releases. Rather than pinning a version, drop
      // back to the arguments that have always existed -- plain text, no
      // streaming, since this is already a compatibility fallback.
      if (result.exitCode !== 0 && isUnknownFlagError(result)) {
        result = await runCli({
          command,
          args: ['-p'],
          stdin: prompt,
          cwd: workspace.dir,
          timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
          signal,
          onChunk: request.onCliOutput ? (stream, text) => text.trim() && request.onCliOutput!(text.trim()) : undefined,
        });
      }

      assertHealthy(result, command);

      const parsed = parseOutput(result.stdout);
      const text = parsed.text.trim();

      if (parsed.isError) {
        throw classify(text || result.stderr, 'Claude Code reported an error.');
      }
      if (!text) {
        throw classify(result.stderr, 'Claude Code returned no output.');
      }

      return {
        json: request.schema ? extractJson(text) : null,
        text,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        // Claude Code doesn't report a search count. Recording the cap rather
        // than 0 keeps the usage view honest about the fact that searching
        // happened, while the connector's billing mode means no money is
        // attached to the figure either way.
        webSearches: request.webSearch?.enabled ? request.webSearch.maxUses : 0,
        searchUrls: [],
        model: connector.model ?? null,
      };
    } finally {
      workspace.cleanup();
    }
  }

  async test(connector: AiConnector): Promise<ConnectorTestResult> {
    const command = await resolveCliCommand(connector.cliCommand || 'claude');
    const started = Date.now();
    const workspace = createWorkspace([]);

    try {
      const result = await runCli({
        command,
        args: ['-p'],
        stdin: 'Reply with the single word: ready',
        cwd: workspace.dir,
        timeoutMs: 90_000,
      });

      if (result.timedOut) {
        return {
          ok: false,
          message: 'Timed out. Run `claude` once in a terminal to confirm you are logged in.',
          latencyMs: Date.now() - started,
          detail: null,
        };
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          message: looksRateLimited(`${result.stderr}${result.stdout}`)
            ? 'Reached your Claude usage limit. It will reset shortly.'
            : classify(`${result.stderr}
${result.stdout}`, `"${command}" exited with code ${result.exitCode}.`)
                .message,
          latencyMs: Date.now() - started,
          detail: (result.stderr || result.stdout).slice(0, 500) || null,
        };
      }

      return {
        ok: true,
        message: 'Connected — using your Claude subscription, not API credits.',
        latencyMs: Date.now() - started,
        detail: parseOutput(result.stdout).text.trim().slice(0, 200) || null,
      };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - started,
        detail: null,
      };
    } finally {
      workspace.cleanup();
    }
  }
}

function buildPrompt(request: AiRequest, imageFiles: string[]): string {
  const sections: string[] = [request.system];

  if (imageFiles.length > 0) {
    sections.push(
      `Read these image files in the current directory before answering:\n${imageFiles
        .map((file) => `- ./${file}`)
        .join('\n')}`
    );
  }

  sections.push(request.prompt);

  if (request.schema) {
    sections.push(schemaInstruction(request.schema));
  }

  return sections.join('\n\n');
}

/**
 * `stream-json` prints one JSON object per line, ending with a `type:
 * "result"` line that carries the actual answer -- everything before it is
 * the turn-by-turn trace already surfaced live via onCliOutput. The plain-text
 * fallback path (no --output-format flag) has none of this, so a stdout that
 * never parses as a result line is treated as the answer itself.
 */
function parseOutput(stdout: string): {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  isError: boolean;
} {
  const trimmed = stdout.trim();
  if (!trimmed) return { text: '', tokensIn: null, tokensOut: null, isError: false };

  let resultLine: ClaudeJsonOutput | null = null;
  for (const line of trimmed.split('\n')) {
    const candidate = line.trim();
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as ClaudeJsonOutput;
      if (parsed && typeof parsed === 'object' && parsed.type === 'result') {
        resultLine = parsed;
      }
    } catch {
      // Not JSON -- either the plain-text fallback, or a non-JSON line stream-json shouldn't produce.
    }
  }

  if (resultLine) {
    return {
      text: String(resultLine.result ?? ''),
      tokensIn: resultLine.usage?.input_tokens ?? null,
      tokensOut: resultLine.usage?.output_tokens ?? null,
      isError: Boolean(resultLine.is_error),
    };
  }

  return { text: trimmed, tokensIn: null, tokensOut: null, isError: false };
}

function assertHealthy(result: CliResult, command: string): void {
  if (result.timedOut) {
    throw new AiError(
      `"${command}" did not finish in time. Long agent runs can exceed the limit — try fewer photos per item.`,
      true
    );
  }
  if (result.exitCode !== 0) {
    // Prefer the clean message stream-json's terminal line carries -- the raw
    // stdout dump is a wall of JSON now that it's multiple lines (init, any
    // turns, then the result), where before it was one clean object.
    const parsed = parseOutput(result.stdout);
    const message = parsed.text.trim() || `${result.stderr}\n${result.stdout}`;
    throw classify(message, `"${command}" exited with code ${result.exitCode}.`);
  }
}

/**
 * Subscription CLIs report a hit usage window as prose on stderr rather than a
 * status code, so the text is what has to be classified. Getting this right is
 * what turns "300 failed jobs" into "queue paused, resuming later".
 */
function classify(text: string, fallbackMessage: string): AiError {
  const detail = text.trim().slice(0, 1000);

  if (looksRateLimited(text)) {
    return new AiRateLimitError(
      'Reached your Claude usage limit. The queue will pause and resume when it resets.',
      resumeFromMessage(text),
      detail
    );
  }
  // "authenticat" (not "authentication") deliberately stems both "authenticate"
  // and "authentication" -- an expired OAuth session reports as "Failed to
  // authenticate: OAuth session expired and could not be refreshed", which the
  // narrower form missed entirely and let retry three times as a generic
  // transient failure before giving up, for something no retry could ever fix.
  if (/not logged in|unauthor|authenticat|oauth|please run .*login/i.test(text)) {
    return new AiError(
      'Claude Code is not logged in (or its session expired). Run `claude` in a terminal and sign in again.',
      false,
      detail
    );
  }

  return new AiError(fallbackMessage, true, detail);
}

/**
 * Claude often names the reset time in the message ("resets at 3pm"). Reading
 * it beats a blind cooldown, since guessing short means hammering a limit and
 * guessing long means idling for no reason.
 */
function resumeFromMessage(text: string): Date {
  const explicit = text.match(/resets?\s+at\s+([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)?/i);
  if (explicit) {
    const now = new Date();
    let hour = Number(explicit[1]);
    const minute = Number(explicit[2] ?? '0');
    const meridiem = explicit[3]?.toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;

    const target = new Date(now);
    target.setHours(hour, minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target;
  }

  return new Date(Date.now() + 30 * 60 * 1000);
}
