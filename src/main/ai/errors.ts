/**
 * Errors the job runner needs to tell apart.
 *
 * The important distinction is rate limiting versus everything else. On a
 * subscription connector, running out of allowance is the *expected* outcome of
 * a large batch, not a failure -- the queue should wait and carry on rather
 * than burn a retry budget and report 200 red rows.
 */

export class AiError extends Error {
  constructor(
    message: string,
    /** Whether trying the same request again could plausibly succeed. */
    readonly retryable: boolean = false,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'AiError';
  }
}

export class AiRateLimitError extends AiError {
  constructor(
    message: string,
    /** When the provider says (or we guess) the allowance resets. */
    readonly resumeAt: Date,
    detail?: string
  ) {
    super(message, true, detail);
    this.name = 'AiRateLimitError';
  }
}

export class AiAuthError extends AiError {
  constructor(message: string, detail?: string) {
    super(message, false, detail);
    this.name = 'AiAuthError';
  }
}

/** The connector is configured for something it cannot do (no vision, no search, no key). */
export class AiCapabilityError extends AiError {
  constructor(message: string, detail?: string) {
    super(message, false, detail);
    this.name = 'AiCapabilityError';
  }
}

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;

/**
 * Turns a provider's rate-limit signal into a resume time. `retry-after` is
 * honoured when present; otherwise we back off far enough to be past a typical
 * subscription usage window rather than hammering the provider every minute.
 */
export function resumeTimeFrom(retryAfterHeader: string | null | undefined, fallbackMs = DEFAULT_COOLDOWN_MS): Date {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return new Date(Date.now() + seconds * 1000);
    }
    const asDate = new Date(retryAfterHeader);
    if (!Number.isNaN(asDate.getTime())) return asDate;
  }
  return new Date(Date.now() + fallbackMs);
}

/** Heuristic for CLI connectors, which report limits as prose on stderr rather than a status code. */
export function looksRateLimited(text: string): boolean {
  const lowered = text.toLowerCase();
  return (
    lowered.includes('rate limit') ||
    lowered.includes('rate_limit') ||
    lowered.includes('too many requests') ||
    lowered.includes('quota') ||
    lowered.includes('usage limit') ||
    lowered.includes('limit reached') ||
    lowered.includes('resets at') ||
    lowered.includes('try again later') ||
    lowered.includes('overloaded')
  );
}
