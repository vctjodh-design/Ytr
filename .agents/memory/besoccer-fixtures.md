---
name: BeSoccer fixture lists
description: Source-page behavior relevant to collecting every match for a selected date.
---

For BeSoccer livescore dates, the converted Markdown can omit fixture cards that are present in the full page HTML. The full page includes cards marked `data-cy="match"`, including cards the source site initially collapses behind “See more.”

**Why:** The fixture listing appeared complete in the initial source response, but the app parsed only a subset of the date’s matches.

**How to apply:** When collecting all fixtures for a date, parse match cards from the full HTML when available; keep the Markdown parser as a fallback and as an enrichment source for scores/status details.
