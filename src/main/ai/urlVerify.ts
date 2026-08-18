/**
 * Comp-link verification.
 *
 * A vision model asked for comparable listings without live search will
 * confidently produce URLs that look exactly right and go nowhere. That is the
 * single most dangerous failure mode in this app, because a fabricated citation
 * is indistinguishable from a real one at a glance and quietly launders a
 * guessed number into an evidenced one.
 *
 * Two independent checks run against every comp: does the link resolve, and did
 * it actually appear in the provider's own search results.
 */

const TIMEOUT_MS = 8000;

export interface VerificationResult {
  url: string;
  /** Null when the check could not be performed at all (offline, DNS failure). */
  verified: boolean | null;
}

async function checkOne(url: string): Promise<boolean | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not even a well-formed URL -- a clear fabrication, not an inconclusive check.
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // HEAD first: cheap, and enough for the question being asked.
    let response = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });

    // Plenty of marketplaces reject HEAD outright but serve GET fine, so a 405
    // or 403 is not evidence the page is missing.
    if (response.status === 405 || response.status === 403 || response.status === 501) {
      response = await fetch(url, { method: 'GET', redirect: 'follow', signal: controller.signal });
    }

    // A 404 or 410 means the listing is not there. Anything else that responds
    // at all means the link is real, even if it needs a login.
    if (response.status === 404 || response.status === 410) return false;
    return response.status < 500;
  } catch (err) {
    // A timeout or network failure says nothing about whether the URL is
    // genuine, so report inconclusive rather than marking it fabricated.
    if (err instanceof Error && err.name === 'AbortError') return null;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyUrls(urls: string[]): Promise<Map<string, boolean | null>> {
  const unique = Array.from(new Set(urls));
  const results = await Promise.all(unique.map(async (url) => [url, await checkOne(url)] as const));
  return new Map(results);
}

/**
 * Whether a cited URL turned up in the provider's own search results. A link
 * the model produced that never appeared in a real search result is a strong
 * fabrication signal even when the URL happens to resolve -- a guessed eBay
 * search URL will load fine and prove nothing.
 */
export function appearedInSearch(url: string, searchUrls: string[]): boolean {
  if (searchUrls.length === 0) return false;

  const normalise = (value: string): string => {
    try {
      const parsed = new URL(value);
      // Tracking parameters differ between the search result and the citation,
      // so compare host and path only.
      return `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '').toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  };

  const target = normalise(url);
  return searchUrls.some((candidate) => normalise(candidate) === target);
}
