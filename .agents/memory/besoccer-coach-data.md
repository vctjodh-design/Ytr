---
name: BeSoccer coach data
description: Scope of team-page coach stats and Reader failures on separate coach profiles.
---

The team profile's `mod_coachStats` module contains a career-level matches/wins/draws/losses record. Seasonal performance and personal coach details live on a separate `/coach/<slug>` page.

**Why:** The team page can provide a useful career record even when the dedicated coach page cannot be read; treating its flattened values as the full profile hides both the scope and the labels.

**How to apply:** Present the team-page record with explicit total-match and W/D/L labels. For richer seasonal details, parse the separate coach page when available. A Jina Reader `AbuseAlleviationError` caused by a BeSoccer advertising redirect is a domain-safety rejection, not a wallet-balance error; do not try to evade it.
