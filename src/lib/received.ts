/**
 * Dividends actually received, from the host's DIVIDEND activities. Pure aggregation.
 */
import { majorCurrency, toMajorFactor } from "./currency.js";

/** "YYYY-MM" bucket in UTC (same as projection.monthKey; duplicated to keep this module standalone for tests). */
const monthKey = (unix: number): string => {
  const d = new Date(unix * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export interface ReceivedDividend {
  /** unix seconds (UTC day) */
  date: number;
  symbol: string;
  /** cash that landed in the account, base currency */
  net: number;
  /** net + tax withheld, base currency */
  gross: number;
}

export interface DividendActivityLike {
  activityType: string;
  date: Date | string | number;
  amount?: string | number | null;
  tax?: string | number | null;
  /** activity currency -> ACCOUNT currency (a valuation override, usually empty) */
  fxRate?: string | number | null;
  currency: string;
  accountCurrency?: string | null;
  assetSymbol?: string;
}

/**
 * Rate from one major currency to the base currency on a given day (YYYY-MM-DD),
 * or null when unknown.
 */
export type RateLookup = (fromMajor: string, isoDate: string) => number | null;

const DAY = 86_400;

export function activityDay(date: Date | string | number): number | null {
  const t = date instanceof Date ? date.getTime() : typeof date === "number" ? date : Date.parse(date);
  return Number.isFinite(t) ? Math.floor(t / 1000 / DAY) * DAY : null;
}

export const isoDay = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);

/**
 * DIVIDEND activities -> received events in base currency, converted at the rate of the
 * day they were received (as the host's own income report does). Order of sources:
 *   1. same currency as base (after minor-unit normalization) -> no conversion
 *   2. `rateFor(currency, day)` (host FX history)
 *   3. the activity's own fxRate, only when the account currency is the base currency
 *      (fxRate converts to the ACCOUNT currency, not to base)
 * Anything else is left out and its currency reported, rather than counted 1:1.
 */
export function receivedFromActivities(
  activities: DividendActivityLike[],
  baseCurrency: string,
  rateFor: RateLookup,
): { received: ReceivedDividend[]; unconverted: string[] } {
  const baseMajor = majorCurrency(baseCurrency);
  const out: ReceivedDividend[] = [];
  const unconverted = new Set<string>();
  for (const a of activities) {
    if (a.activityType !== "DIVIDEND") continue;
    const net = Number(a.amount ?? 0);
    if (!Number.isFinite(net) || net <= 0) continue;
    const tax = Number(a.tax ?? 0) || 0;
    const date = activityDay(a.date);
    if (date == null) continue;

    const major = majorCurrency(a.currency);
    const unit = toMajorFactor(a.currency);
    let mult: number | null = null;
    if (major === baseMajor) mult = unit;
    else {
      const r = rateFor(major, isoDay(date));
      if (r != null && r > 0) mult = unit * r;
      else {
        const fx = Number(a.fxRate ?? NaN);
        if (a.accountCurrency && majorCurrency(a.accountCurrency) === baseMajor && Number.isFinite(fx) && fx > 0) mult = fx;
      }
    }
    if (mult == null) {
      unconverted.add(a.currency);
      continue;
    }
    out.push({ date, symbol: a.assetSymbol ?? "?", net: net * mult, gross: (net + tax) * mult });
  }
  return { received: out.sort((x, y) => x.date - y.date), unconverted: [...unconverted].sort() };
}

export interface MonthBucket {
  net: number;
  gross: number;
  bySymbol: Record<string, number>; // net
}

export interface YearRow {
  year: number;
  total: number; // net
  bySymbol: Record<string, number>; // net
  /** vs previous year, fraction; null without a previous year */
  growth: number | null;
}

export function byMonth(events: ReceivedDividend[]): Map<string, MonthBucket> {
  const out = new Map<string, MonthBucket>();
  for (const e of events) {
    const k = monthKey(e.date);
    const b = out.get(k) ?? { net: 0, gross: 0, bySymbol: {} };
    b.net += e.net;
    b.gross += e.gross;
    b.bySymbol[e.symbol] = (b.bySymbol[e.symbol] ?? 0) + e.net;
    out.set(k, b);
  }
  return out;
}

/** Running total of net received, one point per month with a payment (sorted). */
export function cumulative(events: ReceivedDividend[]): Array<{ month: string; total: number }> {
  const months = byMonth(events);
  const keys = [...months.keys()].sort();
  const out: Array<{ month: string; total: number }> = [];
  let acc = 0;
  for (const k of keys) {
    acc += months.get(k)!.net;
    out.push({ month: k, total: acc });
  }
  return out;
}

export function byYear(events: ReceivedDividend[]): YearRow[] {
  const years = new Map<number, YearRow>();
  for (const e of events) {
    const y = new Date(e.date * 1000).getUTCFullYear();
    const r = years.get(y) ?? { year: y, total: 0, bySymbol: {}, growth: null };
    r.total += e.net;
    r.bySymbol[e.symbol] = (r.bySymbol[e.symbol] ?? 0) + e.net;
    years.set(y, r);
  }
  const rows = [...years.values()].sort((a, b) => a.year - b.year);
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].total;
    rows[i].growth = prev > 0 ? rows[i].total / prev - 1 : null;
  }
  return rows;
}

/** Sum of net received in the 12 months ending at `now` (inclusive of the current month). */
export function trailing12(events: ReceivedDividend[], now: number): number {
  const cutoff = now - 365 * 86_400;
  return events.filter((e) => e.date > cutoff && e.date <= now).reduce((s, e) => s + e.net, 0);
}
