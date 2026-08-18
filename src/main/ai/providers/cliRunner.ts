import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { AiImage } from '../types';
import { AiError } from '../errors';

/**
 * Shared plumbing for the subscription-backed CLI connectors.
 *
 * These connectors are the reason Valutique can run at zero incremental cost:
 * instead of a metered API call they invoke an agent CLI the user is already
 * signed in to, so the work draws on a subscription rather than API credits.
 * From the app's side it is still one call in, one answer out -- whatever
 * agentic looping the CLI does happens inside its own process.
 */

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export interface CliRunOptions {
  command: string;
  args: string[];
  /**
   * The prompt, delivered on stdin rather than as an argument.
   *
   * This is not a stylistic choice. Passing a prompt as an argv entry breaks in
   * two ways on Windows: `shell: true` joins arguments into one command string
   * without quoting them, so anything containing a space is re-split by cmd.exe
   * into extra positional arguments; and the whole command line is capped at
   * 8,191 characters, which a prompt carrying a JSON schema and field hints
   * comfortably exceeds. stdin has neither problem.
   */
  stdin?: string;
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Fired as raw output arrives, so a caller can show/log progress while the process is still running. */
  onChunk?: (stream: 'stdout' | 'stderr', text: string) => void;
}

/** Agentic CLI runs are slow by nature -- searching and reading take real time. */
export const DEFAULT_CLI_TIMEOUT_MS = 6 * 60 * 1000;

export async function runCli(options: CliRunOptions): Promise<CliResult> {
  const started = Date.now();

  return new Promise<CliResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        // A bare name needs a shell on Windows to resolve the .cmd/.ps1 shim.
        // An absolute path must not use one, or a path containing spaces gets
        // split by cmd.exe -- and detection hands us absolute paths whenever
        // the tool was found outside this process's PATH.
        shell: process.platform === 'win32' && !/[\\/]/.test(options.command),
        windowsHide: true,
      });
    } catch (err) {
      reject(
        new AiError(
          `Could not start "${options.command}". Is it installed and on your PATH?`,
          false,
          err instanceof Error ? err.message : String(err)
        )
      );
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const clearTimers = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // A stuck agent loop won't always honour SIGTERM, and on Windows an
      // MCP server or helper process it spawned can hold the stdout/stderr
      // pipes open even after this process is gone -- which means 'close'
      // never fires and the job would otherwise sit at "running" forever,
      // silently past its own timeout, invisible to the queue. SIGKILL is
      // the escalation; the failsafe below is what actually guarantees this
      // promise settles even if the OS never reports the pipes as closed.
      killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        setTimeout(() => {
          finish({
            stdout,
            stderr: stderr || 'Process did not report exit after being killed; treating as timed out.',
            exitCode: null,
            timedOut: true,
            durationMs: Date.now() - started,
          });
        }, 5000);
      }, 5000);
    }, options.timeoutMs);

    const onAbort = () => {
      child.kill('SIGTERM');
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (result: CliResult) => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    if (options.stdin !== undefined) {
      // A closed pipe mid-write means the child died early; the exit handler
      // below reports that properly, so swallow the write error here.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(options.stdin, 'utf-8');
    }

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onChunk?.('stdout', text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onChunk?.('stderr', text);
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimers();
      options.signal?.removeEventListener('abort', onAbort);
      const message =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? `"${options.command}" was not found. Install it, or correct the command in Settings.`
          : err.message;
      reject(new AiError(message, false));
    });

    // 'exit' fires as soon as our own child process terminates. 'close' waits
    // for its stdio pipes to fully drain, which never happens if a grandchild
    // process (an MCP server, a helper the CLI spawned) inherited them and is
    // still alive -- a real, observed failure mode where the child was
    // provably dead at the OS level but this promise still never settled.
    // Racing both and taking whichever fires first keeps the normal case
    // exactly as before while closing that hang.
    child.on('exit', (code) => {
      finish({ stdout, stderr, exitCode: code, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, exitCode: code, timedOut, durationMs: Date.now() - started });
    });
  });
}

export interface CliWorkspace {
  dir: string;
  /** File names, relative to `dir`, in the order the images were supplied. */
  imageFiles: string[];
  cleanup: () => void;
}

/**
 * Writes the downscaled photos into a scratch directory and runs the CLI with
 * that directory as its working directory.
 *
 * This matters for more than convenience: agent CLIs restrict file reads to
 * their working directory, so handing them a private scratch dir is what lets
 * them see the photos without granting access to anything else on disk.
 */
export function createWorkspace(images: AiImage[]): CliWorkspace {
  const dir = path.join(os.tmpdir(), `valutique-${uuidv4()}`);
  fs.mkdirSync(dir, { recursive: true });

  const imageFiles = images.map((image, index) => {
    const extension = image.mediaType === 'image/png' ? 'png' : 'jpg';
    const name = `photo-${index + 1}.${extension}`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(image.base64, 'base64'));
    return name;
  });

  return {
    dir,
    imageFiles,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // A leftover temp directory is not worth failing a completed job over.
      }
    },
  };
}

/**
 * Detects the "you passed a flag I don't understand" case so a provider can
 * retry with a minimal argument list. CLI flags move between versions, and a
 * new flag name shouldn't take the whole connector down.
 */
export function isUnknownFlagError(result: CliResult): boolean {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    text.includes('unknown option') ||
    text.includes('unknown argument') ||
    text.includes('unrecognized option') ||
    text.includes('unexpected argument') ||
    text.includes("does not exist. did you mean")
  );
}
