/**
 * loadConfig (config.ts) — every bucket's rpm and burst is REQUIRED config
 * (CLAUDE_ERROR_PATTERNS §9/§10): a missing, zero, fractional or junk value
 * stops the broker at boot. No rate has a default.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig, RATE_ENV_VARS } from "./config.js";

/** A complete env: the credentials plus one value per rate var. */
function fullEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { BNF_CLIENT_KEY: "k", BNF_CLIENT_SECRET: "s" };
  for (const name of RATE_ENV_VARS) env[name] = name.endsWith("_RPM") ? "60" : "2";
  return env;
}

test("every bucket has a required rpm and burst: 11 buckets, 22 vars", () => {
  assert.equal(RATE_ENV_VARS.length, 22);
  assert.ok(RATE_ENV_VARS.includes("BNF_IIIF_LEGACY_RPM"));
  assert.ok(RATE_ENV_VARS.includes("BNF_GLOBAL_BURST"));
});

test("a complete env loads typed rates for every bucket", () => {
  const env = { ...fullEnv(), BNF_PRESENTATION_RPM: "1425", BNF_PRESENTATION_BURST: "30", BNF_IMAGE_RPM: " 285 " };
  const cfg = loadConfig(env);
  assert.deepEqual(cfg.rates.presentation, { rpm: 1425, burst: 30 });
  assert.equal(cfg.rates.image.rpm, 285, "trimmed");
  assert.deepEqual(cfg.rates.global, { rpm: 60, burst: 2 });
  assert.equal(Object.keys(cfg.rates).length, 11);
});

test("no rate has a default: removing any one of the 22 vars throws, naming it", () => {
  for (const name of RATE_ENV_VARS) {
    const env = fullEnv();
    delete env[name];
    assert.throws(() => loadConfig(env), new RegExp(`${name} is required`), name);
    assert.throws(() => loadConfig({ ...fullEnv(), [name]: "  " }), new RegExp(`${name} is required`), `${name} blank`);
  }
});

test("a rate must be a positive integer in plain digits", () => {
  for (const bad of ["0", "-1", "1.5", "1e3", "0x10", "fast"]) {
    assert.throws(() => loadConfig({ ...fullEnv(), BNF_IMAGE_BURST: bad }), /BNF_IMAGE_BURST.*positive integer/, bad);
  }
});

test("the credentials stay required", () => {
  const env = fullEnv();
  delete env.BNF_CLIENT_SECRET;
  assert.throws(() => loadConfig(env), /BNF_CLIENT_SECRET is required/);
});
