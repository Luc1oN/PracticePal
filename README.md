# PracticePal 🎾

Turns an aimless hit into intentional practice. Pick a practice style, set players / courts / minutes / level, add an optional focus, and get a structured session: a timeline of drills with Aim / Drill / Cycle / Target, animated court diagrams, rotation notes and a competitive finisher. Then run it courtside with Live Mode.

Made by a player, for players. Coaches are welcome, but it is not a coaching tool.

- **Live app:** https://app.practicepal.ie/
- **Site and beta signup:** https://practicepal.ie

## How it's built

- `index.html` — the whole app: vanilla JS, no build step, installable as a PWA (`manifest.webmanifest`, `sw.js` for offline shell).
- **Backend:** Supabase project "PracticePal" (eu-west-1). Edge function `practicepal` holds the Anthropic API key and returns a structured JSON plan; tables hold per-user session history, share-link snapshots, feedback, Live Mode events, generation analytics and rate limits. Accounts are optional (email + password); guests can generate freely.
- **Deploy:** push to `main` → `.github/workflows/pages.yml` publishes to GitHub Pages.
- **Keep-alive:** `.github/workflows/keepalive.yml` reads from the database daily so the free-plan project is never auto-paused, and fails loudly (email) if the backend stops answering.

## Drill library (in progress)

`drills/` holds a hand-checked-in-progress library of drills with court diagrams, a generation prompt, a validator and a review tool:

- `drills/library.json` — anchors plus every validated batch (`is_vetted` is only ever set by hand).
- `drills/GENERATION-PROMPT.md`, `drills/validate_drills.py`, `drills/validate_batch.sh` — generate → validate → duplicate-check workflow.
- `court-diagram.js` — renders a drill's `court_diagram` JSON as an animated SVG; `diagram-review.html` is the review tool for approving diagrams.
- `drills/schema.sql` — the `drills` table the library loads into.

Only vetted drills will ever reach the app.

## Local preview

Any static server on this folder works. The Cashflow repo's `.claude/launch.json` has a `practicepal` config serving it on port 8123.
