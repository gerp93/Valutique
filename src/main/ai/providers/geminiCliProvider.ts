import { AiConnector, ConnectorTestResult } from '../../../shared/types/connector';
import { AiError, AiRateLimitError, looksRateLimited, resumeTimeFrom } from '../errors';
import { extractJson, schemaInstruction } from '../jsonExtract';
import { AiProvider, AiRequest, AiResponse } from '../types';
import { createWorkspace, DEFAULT_CLI_TIMEOUT_MS, isUnknownFlagError, runCli, CliResult } from './cliRunner';
import { resolveCliCommand } from '../../cliDetect';

/**
 * Gemini CLI as a connector.
 *
 * Like the Claude Code connector this draws on an allowance the user already
 * has -- the Gemini CLI's daily quota on their Google account -- rather than
 * metered API billing, and it brings search grounding with it. The free tier is
 * generous enough that a large collection can typically be processed at no cost
 * at all, spread over a couple of days.
 */
export class GeminiCliProvider implements AiProvider {
  async complete(connector: AiConnector, request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    // Resolve rather than trust the stored value: a connector saved before
    // the tool moved -- or saved with a bare name when it lives outside this
    // process's PATH -- would otherwise fail with a misleading 'not
    // recognized' error the app already knows how to fix.
    const command = await resolveCliCommand(connector.cliCommand || 'gemini');
    const workspace = createWorkspace(request.images);

    try {
      const prompt = buildPrompt(request, workspace.imageFiles);

      // The CLI runs non-interactively when its prompt arrives on stdin, and
      // rejects a positional prompt alongside -p -- so pass no prompt argument
      // at all. That also sidesteps argument quoting and length limits.
      const richArgs = [...connector.cliArgs, ...(connector.model ? ['-m', connector.model] : [])];

      // Unlike Claude Code, this CLI has no structured event stream to parse --
      // just forward each raw line as it arrives so the run is at least
      // watchable, even without turn-by-turn tool-call detail.
      const onChunk = request.onCliOutput
        ? (_stream: 'stdout' | 'stderr', text: string) => {
            const trimmed = text.trim();
            if (trimmed) request.onCliOutput!(trimmed);
          }
        : undefined;

      let result = await runCli({
        command,
        args: richArgs,
        stdin: prompt,
        cwd: workspace.dir,
        timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
        signal,
        onChunk,
      });

      if (result.exitCode !== 0 && isUnknownFlagError(result)) {
        result = await runCli({
          command,
          args: [],
          stdin: prompt,
          cwd: workspace.dir,
          timeoutMs: DEFAULT_CLI_TIMEOUT_MS,
          signal,
          onChunk,
        });
      }

      assertHealthy(result, command);

      const text = cleanOutput(result.stdout);
      if (!text) {
        throw classify(result.stderr, 'Gemini CLI returned no output.');
      }

      return {
        json: request.schema ? extractJson(text) : null,
        text,
        // The CLI doesn't report token usage. That's acceptable here precisely
        // because this connector isn't metered -- there is no spend to compute,
        // and the usage view shows a dash rather than a fabricated number.
        tokensIn: null,
        tokensOut: null,
        webSearches: request.webSearch?.enabled ? 1 : 0,
        searchUrls: [],
        model: connector.model ?? null,
      };
    } finally {
      workspace.cleanup();
    }
  }

  async test(connector: AiConnector): Promise<ConnectorTestResult> {
    const command = await resolveCliCommand(connector.cliCommand || 'gemini');
    const started = Date.now();
    const workspace = createWorkspace([]);

    try {
      const result = await runCli({
        command,
        args: [],
        stdin: 'Reply with the single word: ready',
        cwd: workspace.dir,
        timeoutMs: 90_000,
      });

      if (result.timedOut) {
        return {
          ok: false,
          message: 'Timed out. Run `gemini` once in a terminal to confirm you are authenticated.',
          latencyMs: Date.now() - started,
          detail: null,
        };
      }
      if (result.exitCode !== 0) {
        return {
          ok: false,
          message: looksRateLimited(`${result.stderr}${result.stdout}`)
            ? 'Reached your Gemini CLI daily allowance. It resets on a daily cycle.'
            : classify(`${result.stderr}
${result.stdout}`, `"${command}" exited with code ${result.exitCode}.`)
                .message,
          latencyMs: Date.now() - started,
          detail: (result.stderr || result.stdout).slice(0, 500) || null,
        };
      }

      return {
        ok: true,
        message: 'Connected — using your Gemini CLI allowance, not API credits.',
        latencyMs: Date.now() - started,
        detail: cleanOutput(result.stdout).slice(0, 200) || null,
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

  // The CLI's @path syntax pulls a file into the prompt context directly.
  if (imageFiles.length > 0) {
    sections.push(imageFiles.map((file) => `@${file}`).join('\n'));
  }

  sections.push(request.prompt);

  if (request.schema) {
    sections.push(schemaInstruction(request.schema));
  }

  return sections.join('\n\n');
}

/**
 * The CLI prints status chatter alongside the answer. Dropping the obvious
 * banner lines keeps them out of the JSON extractor's way.
 */
function cleanOutput(stdout: string): string {
  return stdout
    .split('\n')
    .filter((line) => !/^\s*(loaded cached credentials|data collection is|using model|authenticating)/i.test(line))
    .join('\n')
    .trim();
}

function assertHealthy(result: CliResult, command: string): void {
  if (result.timedOut) {
    throw new AiError(`"${command}" did not finish in time. Try fewer photos per item.`, true);
  }
  if (result.exitCode !== 0) {
    throw classify(`${result.stderr}\n${result.stdout}`, `"${command}" exited with code ${result.exitCode}.`);
  }
}

function classify(text: string, fallbackMessage: string): AiError {
  const detail = text.trim().slice(0, 1000);

  if (looksRateLimited(text)) {
    return new AiRateLimitError(
      'Reached your Gemini CLI allowance. The queue will pause and resume when it resets.',
      resumeTimeFrom(null, 60 * 60 * 1000),
      detail
    );
  }
  // Installed but never signed in is the single most likely first-run
  // failure, and the CLI words it as "set an Auth method" rather than
  // anything containing "authenticate".
  if (/auth method|not authenticated|unauthor|GEMINI_API_KEY|please (log|sign) ?in|login|sign in/i.test(text)) {
    return new AiError(
      'Gemini CLI is installed but not signed in yet. Run `gemini` in a terminal once and choose an auth method (signing in with your Google account is the free option), then test again.',
      false,
      detail
    );
  }

  return new AiError(fallbackMessage, true, detail);
}
