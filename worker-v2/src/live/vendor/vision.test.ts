/**
 * Pure-logic tests for the vision client's timeout bound (F26,
 * ai-memories/tech/repos/bnf/ingest-hardening) — no provider call, no network.
 * `withTimeout` and `geminiTimeoutMs` are the two seams that make
 * describeViaGemini's SDK call bounded even though `@google/genai` itself
 * takes no AbortSignal.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { geminiTimeoutMs, withTimeout } from "./vision.js";

test("withTimeout resolves with the promise's value when it settles first", async () => {
  const fast = new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 5));
  const result = await withTimeout(fast, 200, "should not fire");
  assert.equal(result, "ok");
});

test("withTimeout rejects with the timeout message when the promise never settles in time", async () => {
  const never = new Promise<string>(() => {}); // deliberately never resolves
  await assert.rejects(
    () => withTimeout(never, 5, "gemini timed out"),
    (err: unknown) => err instanceof Error && err.message === "gemini timed out",
  );
});

test("withTimeout propagates the promise's own rejection when it rejects before the timer", async () => {
  const failsFast = Promise.reject(new Error("provider 500"));
  await assert.rejects(
    () => withTimeout(failsFast, 200, "should not fire"),
    (err: unknown) => err instanceof Error && err.message === "provider 500",
  );
});

test("geminiTimeoutMs defaults to 60000 when GEMINI_TIMEOUT_MS is unset", () => {
  const prev = process.env.GEMINI_TIMEOUT_MS;
  delete process.env.GEMINI_TIMEOUT_MS;
  try {
    assert.equal(geminiTimeoutMs(), 60_000);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_TIMEOUT_MS;
    else process.env.GEMINI_TIMEOUT_MS = prev;
  }
});

test("geminiTimeoutMs honours a valid override", () => {
  const prev = process.env.GEMINI_TIMEOUT_MS;
  process.env.GEMINI_TIMEOUT_MS = "15000";
  try {
    assert.equal(geminiTimeoutMs(), 15_000);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_TIMEOUT_MS;
    else process.env.GEMINI_TIMEOUT_MS = prev;
  }
});

test("geminiTimeoutMs throws on a junk value instead of silently disabling the bound", () => {
  const prev = process.env.GEMINI_TIMEOUT_MS;
  process.env.GEMINI_TIMEOUT_MS = "not-a-number";
  try {
    assert.throws(() => geminiTimeoutMs(), /GEMINI_TIMEOUT_MS must be a positive number/);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_TIMEOUT_MS;
    else process.env.GEMINI_TIMEOUT_MS = prev;
  }
});

test("geminiTimeoutMs throws on a non-positive value", () => {
  const prev = process.env.GEMINI_TIMEOUT_MS;
  process.env.GEMINI_TIMEOUT_MS = "0";
  try {
    assert.throws(() => geminiTimeoutMs(), /must be a positive number/);
  } finally {
    if (prev === undefined) delete process.env.GEMINI_TIMEOUT_MS;
    else process.env.GEMINI_TIMEOUT_MS = prev;
  }
});
