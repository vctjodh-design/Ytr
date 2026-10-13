---
name: BeSoccer fixture lists
description: Source-page behavior relevant to collecting every match for a selected date.
---

BeSoccer livescore pages are incrementally loaded. The date page contains its first batch and a `generateMatches(...)` call with the request key and parameters. Later batches come from `/ajax/matchesScroll` using page numbers starting at 2; keep requesting until the response explicitly says `moreItems: false`.

AJAX responses include valid fixture cards that lack `data-cy="match"` but retain an `id="match-<id>"`, so include those when parsing scroll batches. The source’s `allMatches` count is a useful completeness check. When retrieved through Jina Reader, AJAX markup contains escaped quotes, slashes, and newlines and must be normalized before parsing.

**Why:** The first HTML response can contain only 79 of 249 fixtures; relying on it or Markdown alone silently omits matches.

**How to apply:** Follow the source pagination through its final-page marker, merge and deduplicate all batches, and fail explicitly if pagination cannot be confirmed complete. Keep Markdown as a fallback/enrichment source for scores and statuses.
