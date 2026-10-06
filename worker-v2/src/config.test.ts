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
  etaFetchRatePerMin,
  gateRates,
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

/** The BnF rates and fetch concurrencies — required, no defaults (Track D). */
const RATES = {
  global: { rpm: 950, burst: 20 },
  presentation: { rpm: 1425, burst: 30 },
  image: { rpm: 285, burst: 6 },
  manifest: { rpm: 38, burst: 2 },
  catalogue: { rpm: 95, burst: 2 },
  grapheData: { rpm: 47, burst: 1 },
};
const RATE_ENV = {
  BNF_RATES: JSON.stringify(RATES),
  BNF_ALTO_FETCH_CONCURRENCY: "96",
  BNF_IMAGE_FETCH_CONCURRENCY: "32",
};

/** The minimal env loadConfigFrom accepts: the required vars only. */
const REQUIRED_ENV = {
  DATABASE_URL: "postgresql://localhost/x",
  SCW_S3_BUCKET: "b",
  SCW_S3_ENDPOINT_URL: "https://s3",
  SCW_S3_REGION: "fr-par",
  SCW_S3_ACCESS_KEY: "k",
  SCW_S3_SECRET_KEY: "s",
  ...RATE_ENV,
};

test("loadConfigFrom: every knob defaults when unset, and a required var missing throws", () => {
  const cfg = loadConfigFrom(REQUIRED_ENV);
  assert.equal(cfg.httpPort, 7777);
  assert.equal(cfg.reconcilerIntervalMs, 60_000);
  assert.equal(cfg.failRatio, 0.25);
  assert.equal(cfg.s3Prefix, "v2/");
  const { DATABASE_URL: _db, ...noDb } = REQUIRED_ENV;
  assert.throws(() => loadConfigFrom(noDb), /DATABASE_URL/);
});

test("loadConfigFrom: ONE rule for every numeric knob — zero, negative, fraction and typo throw", () => {
  for (const name of [
    "BNF_ALTO_FETCH_CONCURRENCY",
    "BNF_IMAGE_FETCH_CONCURRENCY",
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

test("BNF_RATES: the worker reads its four gates from the broker's one rate object", () => {
  const cfg = loadConfigFrom(REQUIRED_ENV);
  assert.deepEqual(cfg.rates, {
    globalRpm: 950,
    presentationRpm: 1425,
    imageRpm: 285,
    manifestRpm: 38,
    catalogueRpm: 95,
    grapheDataRpm: 47,
    bulkRpm: 770,
    workerManifestRpm: 28,
  });
  const { BNF_RATES: _rates, ...noRates } = REQUIRED_ENV;
  assert.throws(() => loadConfigFrom(noRates), /Missing required env var BNF_RATES/);
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, BNF_RATES: "global=950" }), /BNF_RATES is not valid JSON/);
  const { image: _image, ...noImage } = RATES;
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, BNF_RATES: JSON.stringify(noImage) }), /image\.rpm/);
  for (const bad of [0, -1, 1.5, "285"]) {
    assert.throws(
      () => loadConfigFrom({ ...REQUIRED_ENV, BNF_RATES: JSON.stringify({ ...RATES, manifest: { rpm: bad, burst: 2 } }) }),
      /manifest\.rpm must be a whole number >= 1/,
      String(bad),
    );
  }
});

test("the per-gate rate variables are retired: a stale ConfigMap refuses to boot", () => {
  for (const name of ["BNF_GLOBAL_RPM", "BNF_PRESENTATION_RPM", "BNF_IMAGE_RPM", "BNF_MANIFEST_RPM"]) {
    assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, [name]: "950" }), new RegExp(`${name} is retired`), name);
  }
});

test("loadConfigFrom: booleans and integers parse the same way everywhere (trimmed, case-insensitive booleans)", () => {
  const cfg = loadConfigFrom({ ...REQUIRED_ENV, MISTRAL_OCR_ENABLED: " TRUE ", BNF_ALTO_FETCH_CONCURRENCY: " 24 " });
  assert.equal(cfg.mistralEnabled, true);
  assert.equal(cfg.altoFetchConcurrency, 24);
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
    assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, BNF_IMAGE_FETCH_CONCURRENCY: bad }), /BNF_IMAGE_FETCH_CONCURRENCY/, bad);
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

test("the BnF rates and both fetch concurrencies are required — none has a default", () => {
  const cfg = loadConfigFrom(REQUIRED_ENV);
  assert.deepEqual(cfg.rates, {
    globalRpm: 950,
    presentationRpm: 1425,
    imageRpm: 285,
    manifestRpm: 38,
    catalogueRpm: 95,
    grapheDataRpm: 47,
    bulkRpm: 770,
    workerManifestRpm: 28,
  });
  assert.equal(cfg.altoFetchConcurrency, 96);
  assert.equal(cfg.imageFetchConcurrency, 32);
  for (const name of Object.keys(RATE_ENV)) {
    const env = Object.fromEntries(Object.entries(REQUIRED_ENV).filter(([k]) => k !== name));
    assert.throws(() => loadConfigFrom(env), new RegExp(`Missing required env var ${name}`), name);
    assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, [name]: " " }), new RegExp(name), `${name} blank`);
  }
});

test("the per-lane image knobs and the single fetch concurrency are retired, each naming its replacement", () => {
  for (const [name, replacement] of [
    ["BNF_FETCH_CONCURRENCY", /BNF_ALTO_FETCH_CONCURRENCY and BNF_IMAGE_FETCH_CONCURRENCY/],
    ["MISTRAL_IMAGE_SIZE", /MISTRAL_MAX_EDGE_PX/],
    ["VISION_IMAGE_SIZE", /VISION_MAX_EDGE_PX/],
  ] as const) {
    assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, [name]: "128" }), new RegExp(`${name} is retired`), name);
    assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, [name]: "128" }), replacement, name);
  }
});

test("gateRates: bulk fetches leave global room for manifests, catalogue and graphe; the worker takes 75 % of manifests", () => {
  const buckets = {
    globalRpm: 950,
    presentationRpm: 1425,
    imageRpm: 285,
    manifestRpm: 38,
    catalogueRpm: 95,
    grapheDataRpm: 47,
  };
  assert.deepEqual(gateRates(buckets), { bulkRpm: 770, workerManifestRpm: 28 });
  assert.deepEqual(gateRates({ ...buckets, globalRpm: 180 }), {
    problems: ["global.rpm (180) leaves no room for ALTO and image fetches once manifest + catalogue + grapheData (180) are reserved"],
  });
  const tiny = gateRates({ ...buckets, manifestRpm: 1 });
  assert.ok("problems" in tiny && tiny.problems.some((p) => p.includes("too small to share")), "never rounded up to 1");
});

test("BNF_RATES: the gate shares are derived and checked at config load, before anything starts", () => {
  const cfg = loadConfigFrom(REQUIRED_ENV);
  assert.equal(cfg.rates.bulkRpm, 770);
  assert.equal(cfg.rates.workerManifestRpm, 28);
  assert.equal(etaFetchRatePerMin(cfg.rates), 770, "the ETA follows the bulk cap, not global");
  const starved = JSON.stringify({ ...RATES, global: { rpm: 180, burst: 4 } });
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, BNF_RATES: starved }), /BNF_RATES is invalid — global\.rpm \(180\) leaves no room/);
  const tiny = JSON.stringify({ ...RATES, manifest: { rpm: 1, burst: 1 } });
  assert.throws(() => loadConfigFrom({ ...REQUIRED_ENV, BNF_RATES: tiny }), /manifest\.rpm \(1\) is too small to share/);
});
