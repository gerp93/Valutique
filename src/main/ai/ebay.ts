/**
 * eBay Browse API lookup, used to put structured listing data in front of the
 * model before it values an item.
 *
 * An important limitation, surfaced to the user rather than hidden: the Browse
 * API returns **active listings only**. Those are asking prices, not realised
 * sale prices, and asking prices systematically overstate what collectibles
 * actually fetch. Completed-sale data lives behind eBay's Marketplace Insights
 * API, which is approval-gated and rarely granted. Everything here is therefore
 * labelled as an upper bound, in the prompt and in the saved comp rows.
 */

const OAUTH_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const BROWSE_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';

export interface EbayListing {
  title: string;
  url: string;
  price: number | null;
  currency: string | null;
  condition: string | null;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

async function getToken(clientId: string, clientSecret: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${basic}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!response.ok) {
    throw new Error(`eBay auth failed (${response.status}). Check the app credentials in Settings.`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error('eBay did not return an access token.');
  }

  cachedToken = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 7200) * 1000,
  };

  return cachedToken.token;
}

interface BrowseResponse {
  itemSummaries?: {
    title?: string;
    itemWebUrl?: string;
    price?: { value?: string; currency?: string };
    condition?: string;
  }[];
}

export async function searchListings(
  credentials: { clientId: string; clientSecret: string },
  query: string,
  limit = 10
): Promise<EbayListing[]> {
  const token = await getToken(credentials.clientId, credentials.clientSecret);

  const url = new URL(BROWSE_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  if (!response.ok) {
    throw new Error(`eBay search failed (${response.status}).`);
  }

  const payload = (await response.json()) as BrowseResponse;

  return (payload.itemSummaries ?? [])
    .filter((summary) => summary.itemWebUrl)
    .map((summary) => ({
      title: summary.title ?? '',
      url: summary.itemWebUrl!,
      price: summary.price?.value ? Number(summary.price.value) : null,
      currency: summary.price?.currency ?? null,
      condition: summary.condition ?? null,
    }));
}

/** Renders listings for the prompt, labelled so the model can't mistake them for sales. */
export function formatListings(listings: EbayListing[]): string {
  if (listings.length === 0) return '';

  return listings
    .map((listing) => {
      const price = listing.price !== null ? `${listing.currency ?? ''} ${listing.price}`.trim() : 'no price';
      const condition = listing.condition ? `, ${listing.condition}` : '';
      return `- ${listing.title} — asking ${price}${condition}\n  ${listing.url}`;
    })
    .join('\n');
}
