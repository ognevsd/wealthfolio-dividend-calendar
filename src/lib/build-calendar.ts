/**
 * Glue between the host APIs and the pure projection module.
 *
 * For every equity-type holding across all accounts:
 *   1. history  = api.market.fetchDividends(symbol + MIC, last 24 months)  (host provider;
 *                 event dates are EX-DATES)
 *   2. primary  = Yahoo primary (US) listing found by ISIN/name; its crumb-free
 *                 `chart?events=div` exposes the latest DECLARED dividend (ex-date in the
 *                 future) weeks earlier than the European listing.
 *   3. project(history, { declared, payLagDays })
 *   4. scale per-share amounts by quantity, convert to base currency with the holding fx
 *      rate, and apply taxes (withholding at source + home tax with credit).
 */
import type { AddonContext, Holding } from "@wealthfolio/addon-sdk";
import { project, type PastDividend, type Projection, type UpcomingPayment } from "./projection";
import { payLagFor, type CalendarSettings } from "./settings";
import { defaultWithholdingPct, netFactor } from "./tax";
import { isoDay, receivedFromActivities, type ReceivedDividend } from "./received";
import { majorCurrency, normalizeDividendUnits, primaryToLocalRatio, type DividendUnit } from "./currency";
import { fetchPrimaryDividends, findPrimarySymbol, lastSearchError } from "./yahoo-calendar";

export interface AssetCalendar {
  assetId: string;
  symbol: string;
  name: string;
  /** major currency of all per-share amounts and prices (GBP for a GBp-quoted listing) */
  currency: string;
  /** unit the provider reported this listing's dividends in, before normalization (diagnostic) */
  dividendUnit?: DividendUnit;
  isin: string | null;
  quantity: number;
  price: number | null;
  /** average cost per unit in local currency, when known */
  avgCost: number | null;
  fxRate: number; // local -> base
  /** withholding at source applied, % */
  withholdingPct: number;
  /** what would apply without a user override, % */
  defaultWithholdingPct: number;
  /** net / gross factor after all taxes */
  netFactor: number;
  payLagDays: number;
  projection: Projection;
  /** upcoming payments already multiplied by quantity; gross and net in base currency */
  upcoming: Array<UpcomingPayment & { amountLocal: number; amountBase: number; netBase: number }>;
  /** forward annual yield on current price and on cost, as fractions (gross) */
  yieldOnPrice: number | null;
  yieldOnCost: number | null;
  /** annual per-share income used for yields (TTM of the holding's own history) */
  annualPerShare: number | null;
  primarySymbol: string | null;
  /** true when the next dividend came from the primary listing's calendar */
  declaredFromPrimary: boolean;
  /** why there is no declared calendar data (diagnostic) */
  calendarNote?: string;
  error?: string;
}

export interface CalendarResult {
  assets: AssetCalendar[];
  baseCurrency: string;
  generatedAt: number;
  settings: CalendarSettings;
  /** dividends actually received (all DIVIDEND activities), base currency */
  received: ReceivedDividend[];
  /** market value of the dividend-paying holdings, base currency */
  marketValue: number;
  /** currencies of DIVIDEND activities that could not be converted to base (left out of totals) */
  unconvertedCurrencies: string[];
}

const DAY = 86_400;
const HISTORY_MONTHS = 24;

function isoDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** Merge the same instrument held in several accounts. */
function mergeHoldings(all: Holding[]): Holding[] {
  const byInstrument = new Map<string, Holding>();
  for (const h of all) {
    if (h.holdingType !== "security" || !h.instrument || h.quantity <= 0) continue;
    const key = h.instrument.id;
    const prev = byInstrument.get(key);
    if (!prev) {
      byInstrument.set(key, { ...h });
      continue;
    }
    byInstrument.set(key, {
      ...prev,
      quantity: prev.quantity + h.quantity,
      marketValue: {
        local: prev.marketValue.local + h.marketValue.local,
        base: prev.marketValue.base + h.marketValue.base,
      },
      costBasis:
        prev.costBasis && h.costBasis
          ? { local: prev.costBasis.local + h.costBasis.local, base: prev.costBasis.base + h.costBasis.base }
          : (prev.costBasis ?? h.costBasis ?? null),
    });
  }
  return [...byInstrument.values()];
}

/** Minimal MIC -> Yahoo suffix map (the host has the full one). */
const MIC_SUFFIX: Record<string, string> = {
  XFRA: ".F", XETR: ".DE", XSTU: ".SG", XDUS: ".DU", XMUN: ".MU", XHAM: ".HM", XBER: ".BE",
  XLON: ".L", XAMS: ".AS", XPAR: ".PA", XMIL: ".MI", XMAD: ".MC", XBRU: ".BR", XLIS: ".LS",
  XSWX: ".SW", XVTX: ".SW", XTSE: ".TO", XASX: ".AX", XTKS: ".T", XHKG: ".HK",
  XMEX: ".MX", XJSE: ".JO", XTAE: ".TA", XHEL: ".HE", XSTO: ".ST", XCSE: ".CO", XOSL: ".OL",
  XWBO: ".VI", XDUB: ".IR", XSES: ".SI", XKRX: ".KS", XBOM: ".BO", XNSE: ".NS", BVMF: ".SA",
  XNAS: "", XNYS: "", ARCX: "", XASE: "", BATS: "",
};
function yahooSymbolFor(symbol: string, mic: string | null): string {
  if (!mic || symbol.includes(".")) return symbol;
  const suffix = MIC_SUFFIX[mic];
  return suffix === undefined ? symbol : symbol + suffix;
}

function emptyProjection(): Projection {
  return { cadence: null, exRule: null, lastAmount: null, lastExDate: null, lastChangePct: null, ttmPerShare: 0, upcoming: [] };
}

export async function buildCalendar(
  ctx: AddonContext,
  settings: CalendarSettings,
  opts: { now?: number; horizonMonths?: number } = {},
): Promise<CalendarResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const horizon = opts.horizonMonths ?? 12;
  const api = ctx.api;

  const accounts = await api.accounts.getAll();
  const perAccount = await Promise.all(
    accounts.filter((a) => a.isActive !== false).map((a) => api.portfolio.getHoldings(a.id).catch(() => [] as Holding[])),
  );
  const holdings = mergeHoldings(perAccount.flat());
  const baseCurrency = holdings[0]?.baseCurrency ?? "EUR";

  // Dividends actually received, for the "past 12 months", cumulative and per-year views.
  //    Converted at the rate of the day received (host FX history), like the host's income
  //    report; the latest holding rate per currency is the fallback.
  const activities = (await api.activities.getAll().catch(() => [])).filter((a) => a.activityType === "DIVIDEND");
  const baseMajor = majorCurrency(baseCurrency);
  const latestRate = new Map<string, number>();
  for (const h of perAccount.flat()) {
    const ccy = majorCurrency(h.localCurrency);
    const r = h.fxRate ?? (h.marketValue.local ? h.marketValue.base / h.marketValue.local : null);
    if (r && Number.isFinite(r) && r > 0 && !latestRate.has(ccy)) latestRate.set(ccy, r);
  }
  const pairKey = (c: string, d: string) => `${c}|${d}`;
  const pairs = new Map<string, { fromCurrency: string; toCurrency: string; date: string }>();
  for (const a of activities) {
    const ccy = majorCurrency(a.currency);
    const t = a.date instanceof Date ? a.date.getTime() : Date.parse(String(a.date));
    if (ccy === baseMajor || !Number.isFinite(t)) continue;
    const d = isoDay(Math.floor(t / 1000));
    pairs.set(pairKey(ccy, d), { fromCurrency: ccy, toCurrency: baseMajor, date: d });
  }
  const historical = new Map<string, number>();
  if (pairs.size) {
    try {
      const res = await api.exchangeRates.getRatesForDates([...pairs.values()]);
      for (const r of res) if (r.rate != null && r.rate > 0) historical.set(pairKey(r.fromCurrency, r.date), r.rate);
    } catch (e) {
      ctx.api.logger.warn(`historical FX lookup failed, using latest rates: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const { received, unconverted } = receivedFromActivities(
    activities,
    baseCurrency,
    (ccy, day) => historical.get(pairKey(ccy, day)) ?? latestRate.get(ccy) ?? null,
  );
  if (unconverted.length) ctx.api.logger.warn(`dividends in ${unconverted.join(", ")} left out: no exchange rate to ${baseCurrency}`);

  const assets = await Promise.all(
    holdings.map(async (h): Promise<AssetCalendar> => {
      const inst = h.instrument!;
      const symbol = inst.symbol;
      const fxRate = h.fxRate ?? (h.marketValue.local ? h.marketValue.base / h.marketValue.local : 1);
      const avgCost = h.costBasis && h.quantity ? h.costBasis.local / h.quantity : null;
      const payLagDays = payLagFor(settings, symbol);
      const base = {
        assetId: inst.id,
        symbol,
        name: inst.name ?? symbol,
        currency: majorCurrency(h.localCurrency || inst.currency),
        dividendUnit: undefined as DividendUnit | undefined,
        isin: null as string | null,
        quantity: h.quantity,
        // host-normalized: major unit (pounds for a GBp listing)
        price: h.price ?? (h.quantity ? h.marketValue.local / h.quantity : null),
        avgCost,
        fxRate,
        withholdingPct: settings.assets[symbol]?.withholdingPct ?? 0,
        defaultWithholdingPct: 0,
        netFactor: 1,
        payLagDays,
      };
      const empty = (error?: string): AssetCalendar => ({
        ...base,
        projection: emptyProjection(),
        upcoming: [],
        yieldOnPrice: null,
        yieldOnCost: null,
        annualPerShare: null,
        primarySymbol: null,
        declaredFromPrimary: false,
        error,
      });

      try {
        const profile = await api.assets.getProfile(inst.id).catch(() => null);
        const instrumentType = profile?.instrumentType ?? null;
        if (instrumentType && instrumentType !== "EQUITY") return empty("not-equity");

        const isin = typeof profile?.metadata?.["isin"] === "string" ? (profile.metadata["isin"] as string) : null;
        base.isin = isin;

        // 1. History through the host (provider-aware). Pass symbol + MIC so the host
        //    resolver turns `RY6` + `XFRA` into Yahoo's `RY6.F`.
        const providerSymbol = profile?.instrumentSymbol ?? symbol;
        const mic = profile?.instrumentExchangeMic ?? null;
        const raw = await api.market
          .fetchDividends(providerSymbol, {
            startDate: isoDate(now - HISTORY_MONTHS * 30 * DAY),
            endDate: isoDate(now),
            quoteCcy: profile?.quoteCcy ?? inst.currency,
            exchangeMic: mic ?? undefined,
            instrumentType: instrumentType ?? "EQUITY",
            providerId: inst.preferredProvider ?? undefined,
          })
          .catch(() => []);
        // Provider amounts are in the listing's quote unit (pence for most LSE listings);
        // holdings are already in the major unit, so bring the history there too.
        const quoteCcy = profile?.quoteCcy ?? inst.currency;
        const normalized = normalizeDividendUnits(
          raw.map((d) => ({ amount: d.amount, date: d.date })),
          quoteCcy,
          base.price,
        );
        const history: PastDividend[] = normalized.events;
        base.dividendUnit = normalized.unit;

        // 2. Declared next dividend from the US primary listing (crumb-free chart API).
        const yahooLocal = yahooSymbolFor(providerSymbol, mic);
        let primary: string | null = null;
        if (isin) primary = await findPrimarySymbol(api.network, isin);
        if (!primary && inst.name) primary = await findPrimarySymbol(api.network, inst.name);
        if (primary === yahooLocal) primary = null; // we already hold the primary

        // Withholding at source: user override > ISIN country > "has a US primary listing" (the
        // host does not persist the ISIN, so a US stock held through a European listing is
        // recognised by its primary) > 0.
        base.defaultWithholdingPct = isin ? defaultWithholdingPct(isin) : primary ? 15 : 0;
        base.withholdingPct = settings.assets[symbol]?.withholdingPct ?? base.defaultWithholdingPct;
        base.netFactor = netFactor({
          withholdingPct: base.withholdingPct,
          homeTaxPct: settings.homeTaxPct,
          creditCapPct: settings.creditCapPct,
          mode: settings.netMode,
        });

        let declared: { amount?: number; exDate: number } | null = null;
        let calendarNote: string | undefined;
        if (primary) {
          const pd = await fetchPrimaryDividends(api.network, primary, HISTORY_MONTHS);
          const future = pd.events.filter((e) => e.date > now).sort((a, b) => a.date - b.date)[0];
          if (future) {
            // Same currency and no ADR involved -> amounts are directly comparable.
            // Otherwise convert through matched past payments (FX and ADR ratio in one);
            // without a match, keep only the declared ex-date and project the amount.
            const pastPrimary = pd.events.filter((e) => e.date <= now);
            const ratio = primaryToLocalRatio(history, pastPrimary);
            declared = ratio != null ? { amount: future.amount * ratio, exDate: future.date } : { exDate: future.date };
          } else {
            calendarNote = pd.note ?? "no-declared-yet";
          }
        } else {
          calendarNote = lastSearchError ?? "no-primary";
        }

        const projection = project(history, { now, horizonMonths: horizon, declared, payLagDays });
        const annualPerShare = projection.ttmPerShare || null;
        const upcoming = projection.upcoming.map((u) => {
          const amountLocal = u.amountPerShare * h.quantity;
          const amountBase = amountLocal * fxRate;
          return { ...u, amountLocal, amountBase, netBase: amountBase * base.netFactor };
        });
        return {
          ...base,
          projection,
          upcoming,
          annualPerShare,
          yieldOnPrice: annualPerShare && h.price ? annualPerShare / h.price : null,
          yieldOnCost: annualPerShare && avgCost ? annualPerShare / avgCost : null,
          primarySymbol: primary,
          declaredFromPrimary: declared != null,
          calendarNote: declared ? undefined : calendarNote,
        };
      } catch (e) {
        return empty(e instanceof Error ? e.message : String(e));
      }
    }),
  );

  const kept = assets.filter((a) => a.error !== "not-equity");
  const keptIds = new Set(kept.map((a) => a.assetId));
  const marketValue = holdings.filter((h) => h.instrument && keptIds.has(h.instrument.id)).reduce((s, h) => s + h.marketValue.base, 0);
  return { assets: kept, baseCurrency, generatedAt: now, settings, received, marketValue, unconvertedCurrencies: unconverted };
}
