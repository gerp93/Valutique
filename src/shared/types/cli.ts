/** Whether a CLI connector's command actually exists on this machine. */
export interface CliStatus {
  /** The executable we probed, e.g. "claude". */
  command: string;
  installed: boolean;
  /** Parsed from `<command> --version` when we could read it. */
  version: string | null;
  /** Why the probe failed, when it did. */
  error: string | null;
  /**
   * What the connector should actually invoke. Usually the bare command, but an
   * absolute path when the tool was found somewhere this process's PATH doesn't
   * cover -- which is common for GUI apps on Windows and macOS.
   */
  resolvedPath: string | null;
  /** False when it was only found by looking in known install directories. */
  foundOnPath: boolean;
  /** How long the probe took -- a slow one usually means a cold shim, not a problem. */
  latencyMs: number;
}

/** Everything the Settings screen needs to decide what to show for the CLI providers. */
export interface CliEnvironment {
  /** Keyed by provider id. */
  statuses: Record<string, CliStatus>;
  /** Whether npm is available, since that's what the install button uses. */
  npmAvailable: boolean;
  npmVersion: string | null;
}

export interface CliInstallResult {
  ok: boolean;
  message: string;
  /** Trailing output, shown when something went wrong. */
  log: string;
  /** Re-probed after installing, so the UI can confirm rather than assume. */
  status: CliStatus | null;
}
