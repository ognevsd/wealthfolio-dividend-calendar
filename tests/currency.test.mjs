import test from "node:test";
import assert from "node:assert/strict";
import { majorCurrency, minorUnitRule, normalizeDividendUnits, primaryToLocalRatio, toMajorFactor } from "../dist-test/currency.js";
import { receivedFromActivities } from "../dist-test/received.js";

const day = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 1000);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("minor-unit codes map to major, case-sensitively for GBp", () => {
  assert.equal(majorCurrency("GBp"), "GBP");
  assert.equal(majorCurrency("GBX"), "GBP");
  assert.equal(majorCurrency("ZAc"), "ZAR");
  assert.equal(majorCurrency("ILA"), "ILS");
  assert.equal(majorCurrency("MXN"), "MXN");
  assert.equal(minorUnitRule("GBP"), null);
  assert.equal(toMajorFactor("GBp"), 0.01);
  assert.equal(toMajorFactor("KWF"), 0.001);
  assert.equal(toMajorFactor("EUR"), 1);
});

// LSE stock at 38.00 GBP (3800p), quarterly 38.6p dividends -> ~4 % yield
const pence = [
  { amount: 38.6, date: day(2025, 11, 1) },
  { amount: 38.6, date: day(2026, 2, 1) },
  { amount: 38.6, date: day(2026, 5, 1) },
  { amount: 38.6, date: day(2026, 8, 1) },
];

test("GBp listing with dividends in pence is scaled to pounds", () => {
  const r = normalizeDividendUnits(pence, "GBp", 38);
  assert.equal(r.unit, "minor");
  close(r.events[0].amount, 0.386);
});

test("GBp listing whose provider already reports pounds is left alone", () => {
  const pounds = pence.map((e) => ({ ...e, amount: e.amount / 100 }));
  const r = normalizeDividendUnits(pounds, "GBp", 38);
  assert.equal(r.unit, "major");
  close(r.events[0].amount, 0.386);
});

test("a single event 100x off is repaired", () => {
  const mixed = pence.map((e, i) => (i === 2 ? { ...e, amount: 0.386 } : e));
  const r = normalizeDividendUnits(mixed, "GBp", 38);
  for (const e of r.events) close(e.amount, 0.386);
});

test("without a price, pence is assumed for GBp", () => {
  assert.equal(normalizeDividendUnits(pence, "GBp", null).unit, "minor");
});

test("non-minor currencies (MXN, EUR) are untouched", () => {
  const r = normalizeDividendUnits(pence, "MXN", 38);
  assert.equal(r.unit, "n/a");
  assert.equal(r.events[0].amount, 38.6);
});

test("primary ratio folds in FX and ADR ratio; null without a match", () => {
  // AMX: 1 ADR = 20 shares; local MXN 0.25/share; ADR pays USD 0.27 at 18.5 MXN/USD
  const local = [{ amount: 0.25, date: day(2026, 7, 10) }, { amount: 0.25, date: day(2025, 11, 10) }];
  const primary = [{ amount: 0.27, date: day(2026, 7, 12) }, { amount: 0.27, date: day(2025, 11, 12) }];
  close(primaryToLocalRatio(local, primary), 0.25 / 0.27);
  assert.equal(primaryToLocalRatio(local, [{ amount: 0.27, date: day(2024, 1, 1) }]), null);
  assert.equal(primaryToLocalRatio([], primary), null);
});

test("received: MXN converted with the day's rate, not 1:1", () => {
  const acts = [
    { activityType: "DIVIDEND", date: "2026-07-20T00:00:00Z", amount: "1000", tax: "100", currency: "MXN", accountCurrency: "EUR", assetSymbol: "AMXB" },
  ];
  const { received, unconverted } = receivedFromActivities(acts, "EUR", (c, d) => (c === "MXN" && d === "2026-07-20" ? 0.048 : null));
  assert.deepEqual(unconverted, []);
  close(received[0].net, 48);
  close(received[0].gross, 52.8);
});

test("received: GBp amounts become pounds before conversion", () => {
  const acts = [{ activityType: "DIVIDEND", date: "2026-07-20", amount: "3860", currency: "GBp", accountCurrency: "GBP" }];
  const { received } = receivedFromActivities(acts, "EUR", (c) => (c === "GBP" ? 1.18 : null));
  close(received[0].net, 38.6 * 1.18);
  const same = receivedFromActivities(acts, "GBP", () => null);
  close(same.received[0].net, 38.6);
});

test("received: activity fxRate only used when it targets the base currency", () => {
  const a = { activityType: "DIVIDEND", date: "2026-07-20", amount: "100", currency: "USD", fxRate: "0.9" };
  const ok = receivedFromActivities([{ ...a, accountCurrency: "EUR" }], "EUR", () => null);
  close(ok.received[0].net, 90);
  const no = receivedFromActivities([{ ...a, accountCurrency: "MXN" }], "EUR", () => null);
  assert.equal(no.received.length, 0);
  assert.deepEqual(no.unconverted, ["USD"]);
});
