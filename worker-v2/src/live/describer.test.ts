/**
 * Pure-logic tests for the live Describer's bridging helpers.
 *
 * No provider call — just the Buffer→dataURL packing (the seam that lets V1's
 * URL-fetching describeImage run on bytes with no network), the DocMeta→context
 * mapping (null → undefined so the prompt omits absent fields), and the
 * structured→markdown render the embed stage consumes.
 */
import test from "node:test";
import assert from "node:assert/strict";

import type { ImageDescription } from "../../../worker/src/prepare/vision.js";
import type { DocMeta } from "../domain/types.js";
import {
  imageBufferToDataUrl,
  metaToContext,
  renderDescription,
} from "./describer.js";

test("imageBufferToDataUrl packs bytes into a base64 data URL", () => {
  const url = imageBufferToDataUrl(Buffer.from("hello"));
  assert.equal(url, `data:image/jpeg;base64,${Buffer.from("hello").toString("base64")}`);
});

test("metaToContext maps nulls to undefined so the prompt omits absent fields", () => {
  const meta: DocMeta = {
    title: "Affiche",
    creator: null,
    date: "1900",
    docType: "affiche",
    subtype: null,
    lang: null,
    pageCount: 1,
    ocrAvailable: false,
  };
  const ctx = metaToContext("ark:/12148/x", meta);
  assert.deepEqual(ctx, {
    ark: "ark:/12148/x",
    title: "Affiche",
    creator: undefined,
    date: "1900",
    docType: "affiche",
  });
});

test("renderDescription produces keyword-rich French markdown from the structured fields", () => {
  const desc: ImageDescription = {
    titreApparent: "Plan de la ville",
    typeVisuel: "plan urbain",
    sujet: "Fortifications de Lille",
    scenesEtElements: ["remparts", "citadelle"],
    legendes: ["Echelle 1:5000"],
    echelle: "1:5000",
    motsCles: ["Lille", "fortification", "Vauban"],
    descriptionLongue: "Un plan détaillé montrant les ouvrages défensifs.",
  };
  const md = renderDescription(desc);
  assert.match(md, /^# Plan de la ville/);
  assert.match(md, /\*\*Type visuel :\*\* plan urbain/);
  assert.match(md, /- remparts/);
  assert.match(md, /\*\*Mots-clés :\*\* Lille, fortification, Vauban/);
  assert.match(md, /Un plan détaillé montrant les ouvrages défensifs\.$/);
});
