/**
 * loadConfig (config.ts) — every bucket's rpm and burst is REQUIRED config
 * (CLAUDE_ERROR_PATTERNS §9/§10), carried by ONE variable, BNF_RATES, a JSON
 * object with exactly the known buckets: a missing, unknown, zero, fractional,
 * string or junk value stops the broker at boot. No rate has a default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, RATES_ENV } from "./config.js";
import { BUCKET_NAMES } from "./plan.js";

type Rates = Record<string, unknown>;

function allRates(): Rates {
  return Object.fromEntries(BUCKET_NAMES.map((b) => [b, { rpm: 60, burst: 2 }]));
}

function envWith(rates: Rates | string): Record<string, string | undefined> {
  return {
    BNF_CLIENT_KEY: "k",
    BNF_CLIENT_SECRET: "s",
    [RATES_ENV]: typeof rates === "string" ? rates : JSON.stringify(rates),
  };
}

test("one BNF_RATES object loads typed rates for every bucket", () => {
  const cfg = loadConfig(envWith({ ...allRates(), presentation: { rpm: 1425, burst: 30 } }));
  assert.deepEqual(cfg.rates.presentation, { rpm: 1425, burst: 30 });
  assert.deepEqual(cfg.rates.global, { rpm: 60, burst: 2 });
  assert.equal(Object.keys(cfg.rates).length, 11);
});

test("no rate has a default: BNF_RATES absent, blank or not JSON throws", () => {
  const env = envWith(allRates());
  delete env[RATES_ENV];
  assert.throws(() => loadConfig(env), /BNF_RATES is not set/);
  assert.throws(() => loadConfig(envWith("  ")), /BNF_RATES is not set/);
  assert.throws(() => loadConfig(envWith("global=950")), /BNF_RATES is not valid JSON/);
  assert.throws(() => loadConfig(envWith("[1, 2]")), /BNF_RATES is not a JSON object/);
});

test("removing any one bucket throws, naming it", () => {
  for (const bucket of BUCKET_NAMES) {
    const rates = allRates();
    delete rates[bucket];
    assert.throws(() => loadConfig(envWith(rates)), new RegExp(`${bucket}: missing`), bucket);
  }
});

test("an unknown bucket or field is refused, never ignored", () => {
  assert.throws(() => loadConfig(envWith({ ...allRates(), imag: { rpm: 1, burst: 1 } })), /imag: not a bucket/);
  assert.throws(
    () => loadConfig(envWith({ ...allRates(), image: { rpm: 285, burst: 6, quota: 300 } })),
    /image\.quota: not a field/,
  );
});

test("a rate must be a whole number >= 1, as a JSON number", () => {
  for (const bad of [0, -1, 1.5, "285", null, true]) {
    assert.throws(
      () => loadConfig(envWith({ ...allRates(), image: { rpm: 285, burst: bad } })),
      /image\.burst: must be a whole number >= 1/,
      String(bad),
    );
  }
});

test("every problem is named at once", () => {
  const rates = allRates();
  delete rates.global;
  rates.catalogue = { rpm: 0, burst: 2 };
  assert.throws(() => loadConfig(envWith(rates)), /global: missing; catalogue\.rpm: must be/);
});

test("the credentials stay required", () => {
  const env = envWith(allRates());
  delete env.BNF_CLIENT_SECRET;
  assert.throws(() => loadConfig(env), /BNF_CLIENT_SECRET is required/);
});
