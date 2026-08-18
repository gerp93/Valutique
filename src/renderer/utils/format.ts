import { AppraisalComp } from '@shared/types/appraisal';

export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      // Collection values are read at a glance; cents are noise above a dollar.
      maximumFractionDigits: amount >= 100 ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Per-item AI spend is routinely under a cent, so this keeps more precision than formatMoney. */
export function formatSpend(amount: number | null | undefined, currency = 'USD'): string {
  if (amount === null || amount === undefined) return '—';
  if (amount === 0) return '—';
  if (amount < 0.01) return `<${formatMoney(0.01, currency)}`;
  return formatMoney(amount, currency);
}

export function formatRange(low: number | null, high: number | null, currency: string): string {
  if (low === null && high === null) return '—';
  if (low === null) return `up to ${formatMoney(high, currency)}`;
  if (high === null) return `from ${formatMoney(low, currency)}`;
  return `${formatMoney(low, currency)} – ${formatMoney(high, currency)}`;
}

export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return '—';
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(2)}M`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';

  const diffSeconds = Math.round((then - Date.now()) / 1000);
  const absolute = Math.abs(diffSeconds);

  if (absolute < 60) return diffSeconds < 0 ? 'just now' : 'in a moment';
  if (absolute < 3600) return relative(Math.round(diffSeconds / 60), 'minute');
  if (absolute < 86400) return relative(Math.round(diffSeconds / 3600), 'hour');
  return relative(Math.round(diffSeconds / 86400), 'day');
}

function relative(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  try {
    return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(value, unit);
  } catch {
    return `${Math.abs(value)} ${unit}${Math.abs(value) === 1 ? '' : 's'} ${value < 0 ? 'ago' : 'from now'}`;
  }
}

export function formatFieldValue(value: string | number | boolean | string[] | null): string {
  if (value === null || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${Math.round(value * 100)}%`;
}

/**
 * How much weight a comparable listing deserves. Verification state and
 * listing type are shown together because they answer different questions: did
 * this link resolve, and is it evidence of a sale or just an asking price.
 */
export function describeComp(comp: AppraisalComp): { label: string; tone: 'good' | 'warn' | 'bad' } {
  if (comp.urlVerified === false) {
    return { label: 'Link did not resolve', tone: 'bad' };
  }
  if (comp.urlVerified === null) {
    return { label: 'Not verified', tone: 'warn' };
  }
  if (comp.listingType === 'active') {
    return { label: 'Asking price', tone: 'warn' };
  }
  if (comp.listingType === 'sold') {
    return { label: 'Completed sale', tone: 'good' };
  }
  return { label: 'Verified link', tone: 'good' };
}
