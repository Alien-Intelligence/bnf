# Alien Intelligence — Design System

> The monetization layer between your content and AI.
> *Connect high-quality content with AI systems that value accuracy, context, and fairness.*

This is the design system for **Alien Intelligence** (a.k.a. "Alien", "The Alien Club"). It contains the brand's foundations (color, type, spacing, motion), reusable React UI components, full‑screen UI‑kit recreations of the real product, copied brand assets, and written guidelines. It exists so design agents can produce on‑brand interfaces, decks, and prototypes without re‑deriving the brand each time.

---

## 1. What Alien Intelligence is

Alien is **the monetization layer between publishers' content and AI**. Publishers' data is already being scraped and used to train and run AI models — Alien lets them get **paid for it, on their own terms**.

The core idea is a **streaming / pay‑per‑use** model for data (think "streaming copyright logic for AI"):

- A **secure data connector** is deployed on the publisher's own infrastructure. Content **never leaves their servers**.
- AI platforms (Claude, ChatGPT, Mistral, Copilot…) access that content **in real time via MCP (Model Context Protocol)** — for **inference only**, never for training, never stored, never copied.
- **Every query is metered, traced, and billed.** The publisher sets the price and the conditions, per dataset.

It is explicitly **European / sovereign**: on‑premise or EU‑hosted Kubernetes, no US‑cloud dependency, GDPR‑native, ISO 27001 (in progress). Compliance is enforced "by architecture, not by policy."

**Two audiences, one product:**
- **For Publishers** — "AI agents want your content. Get paid for it." Revenue on every query, full traceability, data sovereignty.
- **For AI Builders** — "Premium data: legally, instantly, pay‑per‑use." Curated, domain‑specific datasets (science, law, media, cultural heritage) streamed in via MCP in minutes.

Real partners/users referenced in the marketing site include **OpenAIRE** (190M+ scientific papers + citation graph), **Techniques de l'Ingénieur** (70 years of scientific archives), and a **Legal Data Space**.

### The two surfaces this system covers
1. **The Web App** (`ui_kits/web-app/`) — the dark, technical product where publishers manage **Clusters** (data connectors / resources), **Datasets**, **Workflows**, **MCP** endpoints, browse the **Marketplace**, and track **Consumption**. Built on a customized shadcn/ui foundation. This is the primary, code‑backed surface and the source of truth for the foundations below.
2. **The Marketing Site** (`ui_kits/marketing/`) — the near‑monochrome public landing that explains the streaming‑monetization pitch, partner logos, use cases, and the sovereignty story.

---

## 2. Sources (for whoever maintains this)

This system was reverse‑engineered from materials the brand team provided. You may or may not have access; they are recorded here so you can go deeper.

- **GitHub — product codebase (source of truth):** `the-alien-club/web-app` (private). Monorepo, Next.js frontend + AdonisJS backend. Key files used:
  - `packages/frontend/styles/tailwind-theme.css` + `globals.css` — the entire color/radius/shadow theme (lifted verbatim into `tokens/`).
  - `packages/frontend/STYLE.md` — the frontend engineering style guide (architecture, naming, forms, Tailwind conventions). Worth reading in full if writing production code.
  - `packages/frontend/components/ui/*` — the shadcn‑based primitives (button, badge, card, input, switch, tabs, select…) that `components/` here recreate.
  - `packages/frontend/components/layout/sidebar/*` and `app/(app)/dashboard/*` — the dashboard chrome and screens that `ui_kits/web-app/` recreate.
  - Browse the org: <https://github.com/the-alien-club> — also see `datastreaming-demos`, `claude-workflows`, `lds`.
- **Figma — `ADS.fig`:** a large shadcn/ui component‑kit + blocks library (Documentation, Icons, Typography, Blocks, Pro‑Blocks pages, and every shadcn component). Useful as the underlying component vocabulary; the brand‑specific look comes from the codebase theme, not the raw kit.
- **Figma — `AlienDS - Platform.fig`:** the *real product* design source (v0.17) — the dark Studio app, Marketplace, Workflows/node editor, Access Control, Billing, Onboarding, plus a `Brand‑guidelines` page (Colors, Typography, Logo, Theme Preview). This file **validated and extended** the system: it confirmed the dataset accents and the teal action color (`#36777A`), surfaced the brand reference teal (`#76B7B2`), and supplied the patterns behind the StatCard, Table, SegmentedControl, EmptyState, Tooltip and Getting‑Started checklist components and the Studio dashboard screen. (Working fonts in this file are Inter / JetBrains Mono / ES Klarheit — see the font note.)
- **`uploads/public.zip`:** the marketing site's `/public` folder — logos, the Alien glyph, hero/illustration art (pipeline, royalties), partner logos, and the on‑prem/MCP icon set. All copied into `assets/`.

> When building designs based on this product, exploring `the-alien-club/web-app` directly will always beat working from memory — the theme tokens and component CVAs there are authoritative.

---

## 3. Content Fundamentals — how Alien writes

**Voice:** confident, direct, slightly provocative, technical but plain. It speaks to a smart professional (publisher exec, AI engineer) and never dumbs down.

- **Person:** addresses the reader as **"you" / "your"** ("Get paid for it.", "Your content. Your rules. Your infrastructure."). Alien refers to itself as **"we"** ("We deploy a secure connector…", "We handle everything else.").
- **The signature move — possessive triads & short declaratives:** "Your content. Your rules. Your infrastructure." / "Licensed, metered, and paid for." / "No bulk licensing. No legal grey zones." Punchy fragments stacked with periods are the house rhythm.
- **Casing:** **Sentence case** for headlines and buttons ("Book a demo", "Monetize your data", "Start Building" is the one Title‑Case CTA). Section eyebrows and numeric step labels are short ("01", "For Publishers", "How it works"). UPPERCASE is reserved for small **mono eyebrow labels** and API method tags (GET/POST).
- **Numbered structure:** the site loves numbered sequences — `01 Connect / 02 Stream / 03 Get paid`, `01 For Publishers / 02 For AI Builders`. Use two‑digit, zero‑padded numbers.
- **Negation as proof:** trust is established by what is *not* done — "never stored, never copied, never used for training." Lean on this when describing the sovereignty/architecture story.
- **Concrete over fluffy:** real numbers and names ("190M+ scientific papers", "70 years of archives", "pay‑per‑query"). Avoid vague adjectives; cite the mechanism.
- **CTAs:** "Book a demo", "Try the app", "Monetize your data", "Start Building", "Discover More", "Learn More". Verb‑first, short.
- **Emoji:** **none.** The brand is sober and institutional. Do not introduce emoji.
- **Tone words it would use:** sovereign, liquid (as in "liquid AI assets"), metered, traced, on‑terms, real‑time, pay‑per‑use, inference. Tone words it would *avoid:* playful, cute, hype‑y growth‑hacking language.

---

## 4. Visual Foundations

**Overall vibe:** dark, flat, technical, European‑sober. Closer to an infrastructure/observability console than a consumer SaaS. High information density handled with restraint. The brand mark is a single monochrome **arch glyph** (a stylized "A" / archway / signal peak), never colored.

### Color
- **Dark‑first.** Canvas is near‑black `--background` `hsl(0 0% 7%)` (#121212); cards sit one step up at `hsl(0 0% 9%)`. The app literally renders `<html class="dark">`. A `.light` scope exists but is the exception.
- **Neutral is the spine.** A pure‑gray ramp (`--neutral-50…950`) carries almost everything: text, borders (`hsl(0 0% 18%)`), muted text (`hsl(0 0% 54%)`). The system is ~80% grayscale.
- **Teal is the single brand/action color.** `--primary` = `--teal-500` `hsl(183 39% 35%)` (#36777A) — a deep, desaturated teal for primary buttons, active states, switches, focus accents. The brand/logo guidelines also use a **lighter reference teal** `--brand-teal` `#76B7B2` (chart lines, brand marks, the sparklines on stat cards). Not bright, not neon — institutional.
- **Dataset accents** are the one place color blooms: a 7‑hue set (pink, indigo, cyan, green, red, orange, yellow) used to color‑code datasets, tags, category icons and chart series. Each has a `‑muted` (mixed 70% toward black) variant for fills behind text.
- **Status:** info/success = green `hsl(130 41% 67%)`, warning = orange `hsl(28 88% 59%)`, destructive = red `hsl(6 92% 67%)` (note: in *light* mode destructive flips to an indigo‑blue). Status badges use a `tint/10` background + colored text + `tint/30` border pattern (see MethodBadge / Badge).
- **Imagery** skews cool, dark, technical — diagrams, connector/pipeline illustrations, monochrome partner logos. The marketing hero art is desaturated.

### Type
- **Two families only.** **Geist** (sans) for everything — UI, body, and display at large sizes. **Geist Mono** for metrics, code, API methods, prices, and small UPPERCASE eyebrow labels. (The marketing display headline originally used the commercial *ES Klarheit Kurrent*; Geist is the open substitute — see caveats.)
- **Body workhorse is 14px** (`text-sm`). Headings: h1 36 / h2 30 / h3 24 / h4 20, semibold→bold. Marketing heroes scale to 48–72px with tight tracking (`--tracking-tight`/`tighter`).
- **Mono eyebrow** pattern: 12px, uppercase, wide tracking (`0.12em`), muted color — used as section kickers and step labels. See `.mono-eyebrow` in `base.css`.
- Headlines use **balanced/pretty wrapping** and tight letter‑spacing; body stays at normal tracking.

### Space, radius, shape
- **4px spacing grid** (Tailwind 1u = 4px). Cards pad at 16–24px; page gaps at 16px (`gap-4`) are the default rhythm.
- **Radius base is 8px** (`--radius`). Buttons/inputs/cards = `md`/`lg` (6–8px); badges and tags are **fully rounded pills** (`--radius-full`); avatars are circles. Nothing is sharp‑cornered, nothing is heavily rounded.
- **Borders do the heavy lifting**, not shadows. A **0.5px hairline** (`--border-width`, color `--border` = `hsl(0 0% 18%)`) separates surfaces — change `--border-width` in `tokens/spacing.css` to restyle every border at once. Cards are `bg-card` + hairline border + a *very* faint shadow (`--shadow-sm`).

### Elevation, motion, states
- **Shadows are faint and single‑direction** (`0 1px 3px / 0.05–0.1`). This is a flat UI; elevation is communicated by border + a one‑step‑lighter surface, not big blur.
- **Hover:** primary buttons darken to `primary/90`; ghost/secondary surfaces fill with `accent`/`accent/50`; cards lighten to `accent/50` and bump from `shadow-sm`→`shadow-md`. Hover is a *subtle tonal shift*, never a color swap.
- **Active/press:** cards drop to a darker `muted-foreground` fill momentarily; no scale/bounce.
- **Focus:** a 3px `ring` at `ring/50` plus a border color change — visible, never removed. Invalid fields get a `destructive/20–40` ring.
- **Transitions** are short and functional: `transition-all` / `transition-[color,box-shadow]`, ~150ms, ease. The one keyframe in the codebase is a gentle `fade-out` (opacity + scale 0.95). No decorative looping animation, no bounce, no parallax‑heavy motion.
- **Blur/transparency:** used sparingly — a `backdrop-blur-sm` on the sidebar footer, translucent `/10`–`/30` tint fills on status chips. Not a glassmorphism brand.

---

## 5. Iconography

- **Lucide** is the icon system, used pervasively in the app (`ServerIcon`, `DatabaseIcon`, `ActivityIcon`, `NetworkIcon`, `PlugIcon`, `BarChart2Icon`, `ChevronRightIcon`, `TagIcon`, `CalendarIcon`…). Stroke icons, ~1.5–2px weight, sized 16px (`size-4`) inline and up to 56px for empty‑states. **Use Lucide** for any app‑surface icon — linked from CDN in the kits.
- **Custom architecture/SVG icons:** none. The data‑plane / connector / MCP story is illustrated with **Lucide** icons (e.g. `plug-zap`, `radio`, `banknote`, `network`, `database`) on a teal‑tinted tile — not a bespoke icon set.
- **The Alien glyph** (`assets/images/glyph.svg` / `glyph-w.svg`, and `logo*.svg/png`) is the brand mark — a monochrome arch. Never recolor it into brand hues; it appears black‑on‑light or white‑on‑dark only.
- **No emoji**, no unicode‑char icons. Category coding is done with Lucide icon + a `--dataset-*` color, not with emoji.
- Partner/brand logos live in `assets/images/logos/` and `assets/brands/` — keep them monochrome/as‑provided on the dark canvas.

---

## 6. Index / Manifest

**Root**
- `styles.css` — global entry point (import this). `@import` manifest only.
- `tokens/` — `fonts.css`, `colors.css`, `typography.css`, `spacing.css`, `base.css`.
- `readme.md` — this file. `SKILL.md` — Agent‑Skills wrapper.
- `assets/` — brand SVG/PNG: `images/` (logo, glyph, pipeline, royalties), `images/logos/` + `brands/` (partners).

**Foundation cards** (`foundations/`) — specimen `.html` cards rendered in the Design System tab (Colors, Type, Spacing, Brand groups).

**Components** (`components/`) — reusable React primitives recreated from the product. Core/shadcn: `Button`, `Badge`, `MethodBadge`, `Card`, `Input`, `Switch`, `Tabs`, `Avatar`. Product‑specific (from the Platform Figma): `StatCard` (dashboard KPI tile + sparkline), `Table` (data table), `SegmentedControl` (24h/7d/30d toggle), `EmptyState`, `Tooltip`, plus the Getting‑Started **checklist** pattern (`.ds-checklist` / `.ds-step` in `components-extended.css`). Each ships `<Name>.jsx` + `.d.ts` + `.prompt.md`, grouped under `buttons/ badges/ forms/ display/ feedback/ navigation/`, with one `@dsCard` HTML per group. The framework‑agnostic `.ds-*` classes live in `components/components.css` + `components-extended.css` and can be used directly in plain HTML.

**UI kits**
- `ui_kits/web-app/` — interactive dark dashboard recreation: **Studio Dashboard** (stat cards, sparklines, top‑consumers table, empty states, Getting‑Started checklist, "Talk to us" banner), datasets Marketplace, dataset detail, consumption, MCP endpoint view.
- `ui_kits/marketing/` — the public landing page recreation.

**Slides** (`slides/`) — branded 16:9 sample slides (title, statement, comparison, diagram).
