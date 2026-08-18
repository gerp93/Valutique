import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CliEnvironment, CliInstallResult, CliStatus } from '../shared/types/cli';
import { PROVIDER_TEMPLATES } from '../shared/providerTemplates';

/**
 * Detection and installation for the CLI connectors.
 *
 * These connectors are the zero-cost path, so they are the ones most worth
 * offering -- but only if the command actually exists. Offering "Claude Code"
 * to someone who hasn't installed it produces a connector that fails on its
 * first job with a confusing ENOENT, which is a bad way to learn a dependency
 * is missing.
 *
 * The subtlety that makes this more than a PATH lookup: these tools ship
 * through several installers, and a GUI app's PATH is not the shell's PATH. On
 * Windows an Electron process typically does not see `~/.local/bin`, where
 * Claude Code's native installer puts itself -- so a naive probe reports "not
 * installed" for a tool the user is actively using, and then offers to install
 * a second copy over the top. So: probe PATH first, then the places these
 * installers are actually known to write, and hand back the absolute path we
 * found so the connector can run it regardless.
 */

const PROBE_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * A bare name has to go through a shell on Windows to hit the .cmd/.ps1 shims;
 * a resolved absolute path must NOT, or a path containing spaces breaks.
 */
function needsShell(command: string): boolean {
  return process.platform === 'win32' && !command.includes(path.sep) && !command.includes('/');
}

function run(
  command: string,
  args: string[],
  timeoutMs: number,
  onOutput?: (chunk: string) => void
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: needsShell(command), windowsHide: true });
    } catch (err) {
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null, timedOut: false });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Mirrors cliRunner.runCli's fix: 'close' waits for stdio pipes to fully
      // drain, which can simply never happen if a grandchild process inherited
      // them -- this exact gap once left a version-probe (which runs before
      // every CLI job) hung indefinitely, blocking the job behind it with
      // nothing in its console to show why. SIGKILL plus a failsafe below
      // guarantee this promise settles regardless of what the OS reports.
      child.kill('SIGKILL');
      setTimeout(() => finish({ stdout, stderr, code: null, timedOut }), 3000);
    }, timeoutMs);

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onOutput?.(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onOutput?.(text);
    });

    // ENOENT arrives here rather than as a throw from spawn().
    child.on('error', (err) => finish({ stdout, stderr: err.message, code: null, timedOut }));
    // 'exit' fires as soon as this process itself terminates, independent of
    // whether its stdio pipes have fully drained -- see the comment above.
    child.on('exit', (code) => finish({ stdout, stderr, code, timedOut }));
    child.on('close', (code) => finish({ stdout, stderr, code, timedOut }));
  });
}

/** First semver-looking token in the output. These CLIs pad --version with branding. */
function parseVersion(text: string): string | null {
  const match = text.match(/\d+\.\d+\.\d+(?:-[\w.]+)?/);
  return match ? match[0] : null;
}

/** npm's own global bin directory, which is where a global install actually lands. */
async function npmGlobalBin(): Promise<string | null> {
  const result = await run('npm', ['prefix', '-g'], PROBE_TIMEOUT_MS);
  const prefix = result.stdout.trim().split('\n').pop()?.trim();
  if (!prefix || result.code !== 0) return null;
  // Windows puts binaries directly in the prefix; everywhere else in <prefix>/bin.
  return process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
}

/**
 * Directories these tools are known to install into but which a GUI process
 * frequently cannot see, because its PATH was inherited from the desktop
 * session rather than a login shell.
 */
function candidateDirectories(globalBin: string | null): string[] {
  const home = os.homedir();
  const dirs: string[] = [];

  if (globalBin) dirs.push(globalBin);

  // Claude Code's native installer, on every platform.
  dirs.push(path.join(home, '.local', 'bin'));

  if (process.platform === 'win32') {
    dirs.push(path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm'));
    dirs.push(path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs'));
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', path.join(home, '.npm-global', 'bin'), path.join(home, 'bin'));
  }

  return Array.from(new Set(dirs));
}

/** Executable file names to try for one logical command, per platform. */
function executableNames(command: string): string[] {
  return process.platform === 'win32'
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
}

function findInDirectories(command: string, dirs: string[]): string | null {
  for (const dir of dirs) {
    for (const name of executableNames(command)) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable directory -- just move on.
      }
    }
  }
  return null;
}

async function probe(command: string): Promise<{ ok: boolean; version: string | null }> {
  const result = await run(command, ['--version'], PROBE_TIMEOUT_MS);
  const combined = `${result.stdout}\n${result.stderr}`;
  const version = parseVersion(combined);

  if (result.timedOut) return { ok: false, version: null };

  const missing =
    result.code === null || /ENOENT|not recognized|not found|no such file/i.test(combined) || (result.code !== 0 && !version);

  return { ok: !missing, version };
}

export async function detectCli(command: string, globalBin: string | null = null): Promise<CliStatus> {
  const started = Date.now();

  if (!command) {
    return { command, installed: false, version: null, error: null, resolvedPath: null, foundOnPath: false, latencyMs: 0 };
  }

  // 1. Straight off PATH -- the normal case, and the cheapest.
  const onPath = await probe(command);
  if (onPath.ok) {
    return {
      command,
      installed: true,
      version: onPath.version,
      error: null,
      resolvedPath: command,
      foundOnPath: true,
      latencyMs: Date.now() - started,
    };
  }

  // 2. Not on our PATH, which does not mean it isn't installed. Look where
  //    these installers actually put things.
  const discovered = findInDirectories(command, candidateDirectories(globalBin));
  if (discovered) {
    const direct = await probe(discovered);
    if (direct.ok) {
      return {
        command,
        installed: true,
        version: direct.version,
        error: null,
        // The connector stores this absolute path, so it works even though the
        // bare name would not.
        resolvedPath: discovered,
        foundOnPath: false,
        latencyMs: Date.now() - started,
      };
    }
  }

  return {
    command,
    installed: false,
    version: null,
    error: null,
    resolvedPath: null,
    foundOnPath: false,
    latencyMs: Date.now() - started,
  };
}

/**
 * Model list from an OpenAI-compatible endpoint.
 *
 * This is why the model field for that connector can be a proper picker rather
 * than free text: the set is unknowable ahead of time but every server in the
 * family -- Ollama, LM Studio, vLLM, TGI -- exposes it at /v1/models. Asking
 * beats making the user type a tag exactly right from memory.
 */
export async function listRemoteModels(baseUrl: string, apiKey: string | null): Promise<string[]> {
  const candidates = [baseUrl.replace(/\/+$/, '')];

  // Same IPv6-versus-IPv4 problem the chat endpoint has.
  try {
    const url = new URL(baseUrl);
    if (url.hostname === 'localhost') {
      url.hostname = '127.0.0.1';
      candidates.push(url.toString().replace(/\/+$/, ''));
    }
  } catch {
    // Not a parseable URL -- the single candidate will fail informatively.
  }

  for (const base of candidates) {
    try {
      const response = await fetch(`${base}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!response.ok) continue;

      const payload = (await response.json()) as { data?: { id?: string }[] };
      const ids = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string');

      if (ids.length > 0) return ids.sort((a, b) => a.localeCompare(b));
    } catch {
      // Try the next candidate.
    }
  }

  return [];
}

/**
 * Cache of bare command -> the executable that actually runs, so resolution
 * costs one probe per session rather than one per job.
 */
const resolvedCommands = new Map<string, string>();

/**
 * What to actually spawn for a stored connector command.
 *
 * A connector records whatever was correct when it was created, but that can go
 * stale: the tool gets reinstalled elsewhere, a PATH entry disappears, or -- the
 * common case -- the connector was saved with a bare name before we learned the
 * tool lives outside this process's PATH. Resolving at call time means the
 * connector keeps working without the user re-adding it, and a job never fails
 * for a reason the app could have fixed itself.
 */
export async function resolveCliCommand(command: string): Promise<string> {
  if (!command) return command;

  const cached = resolvedCommands.get(command);
  if (cached) return cached;

  const status = await detectCli(command);
  if (!status.installed || !status.resolvedPath) {
    // Genuinely missing. Return the original so the error names what the user
    // configured rather than something they never typed.
    return command;
  }

  resolvedCommands.set(command, status.resolvedPath);
  return status.resolvedPath;
}

export async function detectEnvironment(): Promise<CliEnvironment> {
  const cliTemplates = PROVIDER_TEMPLATES.filter((template) => template.transport === 'cli');

  const npm = await run('npm', ['--version'], PROBE_TIMEOUT_MS);
  const npmVersion = parseVersion(`${npm.stdout}\n${npm.stderr}`);
  const npmAvailable = npm.code === 0 && Boolean(npmVersion);

  const globalBin = npmAvailable ? await npmGlobalBin() : null;

  const statuses = await Promise.all(
    cliTemplates.map(async (template) => {
      const status = await detectCli(template.defaultCliCommand ?? '', globalBin);
      return [template.provider, status] as const;
    })
  );

  return { statuses: Object.fromEntries(statuses), npmAvailable, npmVersion };
}

/**
 * Installs a CLI connector's package globally.
 *
 * Deliberately restricted to the packages named in the provider templates --
 * this runs a package manager on the user's machine, and the package name must
 * never be something the renderer can choose.
 */
export async function installCli(provider: string, onOutput?: (chunk: string) => void): Promise<CliInstallResult> {
  const template = PROVIDER_TEMPLATES.find((entry) => entry.provider === provider);

  if (!template || template.transport !== 'cli' || !template.npmPackage) {
    return { ok: false, message: 'That connector has nothing to install.', log: '', status: null };
  }

  const npm = await run('npm', ['--version'], PROBE_TIMEOUT_MS);
  if (npm.code !== 0) {
    return {
      ok: false,
      message: 'npm was not found. Install Node.js first, then try again.',
      log: `${npm.stdout}\n${npm.stderr}`.trim(),
      status: null,
    };
  }

  // Guard against installing over a copy that is already present but was only
  // invisible to us before -- detection is re-run by the UI, but a stale click
  // shouldn't put a second install on the machine.
  const globalBin = await npmGlobalBin();
  const existing = await detectCli(template.defaultCliCommand ?? '', globalBin);
  if (existing.installed) {
    return {
      ok: true,
      message: `${template.label} was already installed${existing.version ? ` (v${existing.version})` : ''}. Nothing to do.`,
      log: '',
      status: existing,
    };
  }

  const result = await run('npm', ['install', '-g', template.npmPackage], INSTALL_TIMEOUT_MS, onOutput);
  const log = `${result.stdout}\n${result.stderr}`.trim();

  if (result.timedOut) {
    return { ok: false, message: 'The install timed out.', log, status: null };
  }

  if (result.code !== 0) {
    // The overwhelmingly common failure on Windows and macOS is a permissions
    // problem writing to the global prefix, so name that rather than dumping
    // npm's output and leaving the user to interpret it.
    const permissionProblem = /EACCES|EPERM|permission denied|access is denied/i.test(log);
    return {
      ok: false,
      message: permissionProblem
        ? `npm could not write to its global folder. Run "npm install -g ${template.npmPackage}" in a terminal with the right permissions.`
        : `npm install failed. Run "npm install -g ${template.npmPackage}" in a terminal to see the full error.`,
      log,
      status: null,
    };
  }

  // Confirm rather than assume: a global install can land somewhere this
  // process cannot see, in which case the app still cannot run it.
  const status = await detectCli(template.defaultCliCommand ?? '', globalBin);

  if (!status.installed) {
    return {
      ok: false,
      message: `Installed, but Valutique still can't find "${template.defaultCliCommand}". Restart the app — if it's still missing, npm's global folder isn't somewhere this app can see.`,
      log,
      status,
    };
  }

  return {
    ok: true,
    message: `${template.label} installed${status.version ? ` (v${status.version})` : ''}. ${template.postInstallHint ?? ''}`.trim(),
    log,
    status,
  };
}
