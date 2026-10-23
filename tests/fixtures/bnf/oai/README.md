# Gallica OAI-PMH fixtures (SDS-945)

Captured 2026-10-22 from the public, ungated endpoint
`http://oai.bnf.fr/oai2/OAIHandler?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:bnf.fr:gallica/ark:/12148/<id>`
unless marked hand-made. Consumed by `lib/bnf/oai-record.test.ts`.

| File | Id | Exercises |
|---|---|---|
| `fascicule-bpt6k268418n.xml` | bpt6k268418n | `periodiques:fascicules`; OAI says 3197 views but the issue has 4 folios; no "mode texte" |
| `fascicule-ocr-bpt6k559134j.xml` | bpt6k559134j | OCR'd Le Matin issue, 123753 views, NO "mode texte" (OAI recall gap) |
| `monographie-texte-bpt6k9618082w.xml` | bpt6k9618082w | `monographies` WITH "Avec mode texte"; 406 views |
| `estampe-btv1b69497161.xml` | btv1b69497161 | `images:estampes`; three `dc:subject`, no creator |
| `not-found.xml` | bpt6kdoesnotexist000 | bogus id: `<error code="idDoesNotExist">` |
| `no-typedoc-trimmed-fascicule.xml` | bpt6k268418n | HAND-TRIMMED copy of the fascicule with its typedoc `<setSpec>` removed. The parity sample (research/oai-manifest-parity-2026-10-22.tsv) has no record that is both on OAI and typedoc-less (its one typedoc-less ARK, bpt6k58256693, has no OAI record at all), so this is derived. |
| `subjects-duplicated-trimmed-estampe.xml` | btv1b69497161 | HAND-EDITED copy of the estampe with a duplicate subject (padded with whitespace) and a blank subject appended |
| `html-proxy-page.html` | none | HAND-WRITTEN well-formed HTML page standing in for a proxy / captcha wall: no `<OAI-PMH>` root, but it has a `<title>` |
