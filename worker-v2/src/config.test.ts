/**
 * loadOcrBackfillConfig — the OCR backfill knobs are validated at startup:
 * unset means the documented default, anything set must be well-formed (a
 * fractional or non-positive concurrency or retry age, or a boolean typo,
 * throws instead of being floored or ignored).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_OCR_BACKFILL_CONCURRENCY,
  DEFAULT_OCR_BACKFILL_ENABLED,
  DEFAULT_OCR_BACKFILL_RETRY_FAILED_AFTER_MS,
  loadBrokerUrl,
  loadConfigFrom,
  loadIiifBases,
  loadOcrBackfillConfig,
  MIN_OCR_BACKFILL_RETRY_FAILED_AFTER_MS,
  pgPoolConfig,
  PG_CONNECTION_TIMEOUT_MS,
  PG_STATEMENT_TIMEOUT_MS,
} from "./config.js";

test("unset → the documented defaults (D6: enabled, concurrency 2, 24 h base backoff)", () => {
  assert.deepEqual(loadOcrBackfillConfig({}), {
    enabled: DEFAULT_OCR_BACKFILL_ENABLED,
    concurrency: DEFAULT_OCR_BACKFILL_CONCURRENCY,
    retryFailedAfterMs: DEFAULT_OCR_BACKFILL_RETRY_FAILED_AFTER_MS,
  });
  assert.equal(DEFAULT_OCR_BACKFILL_CONCURRENCY, 2);
});

test("well-formed values are used as given", () => {
  assert.deepEqual(
    loadOcrBackfillConfig({
      OCR_BACKFILL_ENABLED: "false",
      OCR_BACKFILL_CONCURRENCY: "4",
      OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "3600000",
    }),
    { enabled: false, concurrency: 4, retryFailedAfterMs: 3_600_000 },
  );
});

test("malformed values throw", () => {
  for (const env of [
    { OCR_BACKFILL_CONCURRENCY: "0" },
    { OCR_BACKFILL_CONCURRENCY: "1.5" },
    { OCR_BACKFILL_CONCURRENCY: "two" },
    { OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "-1" },
    { OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "0" },
    // milliseconds below the floor — "60" meant as minutes would burn the attempts in one cycle
    { OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "60" },
    { OCR_BACKFILL_RETRY_FAILED_AFTER_MS: String(MIN_OCR_BACKFILL_RETRY_FAILED_AFTER_MS - 1) },
    { OCR_BACKFILL_ENABLED: "yes" },
  ]) {
    assert.throws(() => loadOcrBackfillConfig(env), /OCR_BACKFILL_/, JSON.stringify(env));
  }
});

/** The minimal env loadConfigFrom accepts: the required vars only. */
const REQUIRED_ENV = {
  DATABASE_URL: "postgresql://localhost/x",
  SCW_S3_BUCKET: "b",
  SCW_S3_ENDPOINT_URL: "https://s3",
  SCW_S3_REGION: "fr-par",
  SCW_S3_ACCESS_KEY: "k",
  SCW_S3_SECRET_KEY: "s",
};

test("loadConfigFrom: every knob defaults when unset, and a required var missing throws", () => {
  const cfg = loadConfigFrom(REQUIRED_ENV);
  assert.equal(cfg.httpPort, 7777);
  assert.equal(cfg.fetchConcurrency, 32);
  assert.equal(cfg.reconcilerIntervalMs, 60_000);
  assert.equal(cfg.failRatio, 0.25);
  assert.equal(cfg.s3Prefix, "v2/");
  const { DATABASE_URL: _db, ...noDb } = REQUIRED_ENV;
  assert.throws(() => loadConfigFrom(noDb), /DATABASE_URL/);
});

test("loadConfigFrom: ONE rule for every numeric knob — zero, negative, fraction and typo throw", () => {
  for (const name of [
    "BNF_FETCH_CONCURRENCY",
    "BNF_GLOBAL_RPM",
    "BNF_MANIFEST_RPM",
    "MAX_OCR_PAGES",
    "DESCRIBE_CONCURRENCY",
    "REGISTER_CONCURRENCY",
    "RECONCILER_INTERVAL_MS",
    "RECONCILER_MAX_REQUEUES",
    "WORKER_HTTP_PORT",
  ]) {
    for (const bad of ["0", "-1", "1.5", "twelve"]) {
      assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, [name]: bad }), new RegExp(name), `${name}=${bad}`);
    }
  }
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, WORKER_HTTP_PORT: "70000" }), /WORKER_HTTP_PORT/);
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, DOC_FAIL_RATIO: "1.5" }), /DOC_FAIL_RATIO/);
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, MISTRAL_OCR_ENABLED: "yes" }), /MISTRAL_OCR_ENABLED/);
});

test("loadConfigFrom: booleans and integers parse the same way everywhere (trimmed, case-insensitive booleans)", () => {
  const cfg = loadConfigFrom({ ...REQUIRED_ENV, MISTRAL_OCR_ENABLED: " TRUE ", BNF_FETCH_CONCURRENCY: " 24 " });
  assert.equal(cfg.mistralEnabled, true);
  assert.equal(cfg.fetchConcurrency, 24);
});

test("pgPoolConfig: both timeouts on every pool", () => {
  assert.deepEqual(pgPoolConfig("postgresql://x"), {
    connectionString: "postgresql://x",
    statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMillis: PG_CONNECTION_TIMEOUT_MS,
  });
});

test("integers are plain digits: hex, binary, exponent and sign forms throw", () => {
  for (const bad of ["0x10", "0b11", "1e1", "+5", "6e4", "1_000"]) {
    assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, BNF_FETCH_CONCURRENCY: bad }), /BNF_FETCH_CONCURRENCY/, bad);
  }
  assert.throws(
    () => loadOcrBackfillConfig({ OCR_BACKFILL_RETRY_FAILED_AFTER_MS: "6e4" }),
    /OCR_BACKFILL_RETRY_FAILED_AFTER_MS/,
  );
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, DOC_FAIL_RATIO: "2.5e-1" }), /DOC_FAIL_RATIO/);
});

test("loadConfigFrom does not need BNF_BROKER_URL (status/seed/requeue make no BnF call)", () => {
  assert.doesNotThrow(() => loadConfigFrom(REQUIRED_ENV));
});

test("loadBrokerUrl: required by the worker runtime, an http(s) URL, trailing slash dropped", () => {
  assert.throws(() => loadBrokerUrl({}), /BNF_BROKER_URL/);
  for (const bad of ["not a url", "ftp://broker:8792", "localhost:8792"]) {
    assert.throws(() => loadBrokerUrl({ BNF_BROKER_URL: bad }), /BNF_BROKER_URL/, bad);
  }
  assert.equal(loadBrokerUrl({ BNF_BROKER_URL: "http://broker:8792/" }), "http://broker:8792");
});

test("loadIiifBases: both BnF IIIF API bases are required http(s) URLs, trailing slash dropped", () => {
  const bases = {
    BNF_IIIF_PRESENTATION_BASE_URL: "https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0/",
    BNF_IIIF_IMAGE_BASE_URL: "https://openapiproext.bnf.fr/image/iiif/gallica/1.0.0",
  };
  assert.deepEqual(loadIiifBases(bases), {
    presentationBaseUrl: "https://openapiproext.bnf.fr/presentation/iiif/gallica/1.0.0",
    imageBaseUrl: "https://openapiproext.bnf.fr/image/iiif/gallica/1.0.0",
  });
  for (const name of Object.keys(bases)) {
    const rest = Object.fromEntries(Object.entries(bases).filter(([k]) => k !== name));
    assert.throws(() => loadIiifBases(rest), new RegExp(`Missing required env var ${name}`), name);
    assert.throws(() => loadIiifBases({ ...bases, [name]: "openapiproext.bnf.fr/x" }), new RegExp(name), `${name} not a URL`);
  }
});

test("a retired env var stops the worker, naming its replacement (BNF_API_BASE_URL → the two IIIF bases)", () => {
  assert.throws(
    () => loadConfigFrom({ ...REQUIRED_ENV, BNF_API_BASE_URL: "https://openapiproext.bnf.fr" }),
    /BNF_API_BASE_URL is retired — use BNF_IIIF_PRESENTATION_BASE_URL and BNF_IIIF_IMAGE_BASE_URL/,
  );
});
