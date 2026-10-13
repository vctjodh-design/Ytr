---
name: BeSoccer player names
description: A source-specific caveat when parsing BeSoccer player profile identity.
---

BeSoccer's player-page JSON-LD can return the generic site/language label instead of the player's name.

**Why:** The Robin Risser profile response returned “Besoccer EN” as the JSON-LD name while the player identity was available in the page content and portrait alt text.

**How to apply:** When parsing player names, validate structured-data names against generic site labels and fall back to the player heading or portrait alt before using the URL slug.
