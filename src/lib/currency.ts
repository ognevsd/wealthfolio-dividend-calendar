/**
 * Currency units. Pure, no host imports (unit-tested).
 *
 * Wealthfolio normalizes minor-unit quote currencies (GBp, ZAc, ILA, ...) to the major unit
 * for holdings: `localCurrency` becomes GBP, `price`, `marketValue.local` and `fxRate` are in
 * pounds. Dividend history from `market.fetchDividends` is NOT normalized: it is the raw
 * provider amount, which for Yahoo LSE listings is usually in pence, but not always.
 * The rule table mirrors the host's `crates/core/src/fx/currency.rs`.
 */

export interface MinorUnitRule {
  major: string;
  /** minor amount * factor = major amount */
  factor: number;
}

const RULES: Record<string, MinorUnitRule> = {
  GBp: { major: "GBP", factor: 0.01 },
  GBX: { major: "GBP", factor: 0.01 },
  ZAc: { major: "ZAR", factor: 0.01 },
  ZAC: { major: "ZAR", factor: 0.01 },
  ILA: { major: "ILS", factor: 0.01 },
  KWF: { major: "KWD", factor: 0.001 },
  USX: { major: "USD", factor: 0.01 },
};

/** Rule for a minor-unit code, or null. Case-sensitive where it matters: "GBP" is not "GBp". */
export function minorUnitRule(code: string | null | undefined): MinorUnitRule | null {
  if (!code) return null;
  const c = code.trim();
  if (RULES[c]) return RULES[c];
  const up = c.toUpperCase();
  if (up === "GBX" || up === "ZAC" || up === "ILA" || up === "KWF") return RULES[up];
  return null;
}

/** Major ISO code for any code ("GBp" -> "GBP", "MXN" -> "MXN"). */
export function majorCurrency(code: string): string {
  return minorUnitRule(code)?.major ?? code.trim().toUpperCase();
}

/** Multiplier from `code` to its major unit (GBp -> 0.01, anything else -> 1). */
export function toMajorFactor(code: string): number {
  return minorUnitRule(code)?.factor ?? 1;
}

export interface DatedAmount {
  amount: number;
  date: number;
}

export type DividendUnit = "major" | "minor" | "n/a";

const DAY = 86_400;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Bring raw per-share dividend amounts of a listing quoted in `quoteCcy` to the MAJOR unit.
 *
 * Non-minor quote currencies are returned unchanged. For minor-unit listings the unit of the
 * provider amounts is decided from the trailing-12-month yield against `priceMajor`:
 * read as major units, a yield of 25 % or more is implausible, so the amounts are minor
 * units (pence); below that they already are major units. Without a price, minor is assumed
 * (Yahoo's usual convention for LSE). Single events that are off by the unit factor against
 * the median of the series (a known Yahoo glitch) are then fixed one by one.
 */
export function normalizeDividendUnits<T extends DatedAmount>(
  events: T[],
  quoteCcy: string | null | undefined,
  priceMajor: number | null | undefined,
): { events: T[]; unit: DividendUnit } {
  const rule = minorUnitRule(quoteCcy);
  if (!rule || events.length === 0) return { events, unit: "n/a" };
  const f = rule.factor;

  const latest = Math.max(...events.map((e) => e.date));
  const ttm = events.filter((e) => e.date > latest - 365 * DAY).reduce((s, e) => s + e.amount, 0);
  const yieldIfMajor = priceMajor && priceMajor > 0 ? ttm / priceMajor : null;
  const unit: DividendUnit = yieldIfMajor == null || yieldIfMajor >= 0.25 ? "minor" : "major";
  const scale = unit === "minor" ? f : 1;
  let out = events.map((e) => ({ ...e, amount: e.amount * scale }));

  // Per-event unit glitches: an event 1/f times off the others. 20x is far beyond normal
  // special-dividend variation for f = 0.01 and well short of the 100x unit error.
  if (out.length >= 3) {
    const threshold = Math.sqrt(1 / f) * 2;
    const med = median(out.map((e) => e.amount));
    if (med > 0) {
      out = out.map((e) => {
        if (e.amount / med > threshold) return { ...e, amount: e.amount * f };
        if (med / e.amount > threshold) return { ...e, amount: e.amount / f };
        return e;
      });
    }
  }
  return { events: out, unit };
}

/**
 * Factor turning a primary-listing (e.g. US ADR, USD per ADR) amount into the holding's
 * per-share amount in its major currency. It is the ratio between payments of the same
 * dividend on both listings, so it folds in both the FX rate and the ADR share ratio.
 * Median over the last few matched payments; null when nothing can be matched, in which
 * case the caller must NOT reuse the primary amount (only its date).
 */
export function primaryToLocalRatio(local: DatedAmount[], primary: DatedAmount[], maxPairs = 4): number | null {
  if (!local.length || !primary.length) return null;
  const ratios: number[] = [];
  const used = new Set<DatedAmount>();
  for (const l of [...local].sort((a, b) => b.date - a.date)) {
    if (ratios.length >= maxPairs) break;
    let best: DatedAmount | null = null;
    for (const p of primary) {
      if (used.has(p) || p.amount <= 0) continue;
      if (!best || Math.abs(p.date - l.date) < Math.abs(best.date - l.date)) best = p;
    }
    if (best && Math.abs(best.date - l.date) <= 45 * DAY && l.amount > 0) {
      used.add(best);
      ratios.push(l.amount / best.amount);
    }
  }
  return ratios.length ? median(ratios) : null;
}
