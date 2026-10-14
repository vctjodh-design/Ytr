---
name: BeSoccer fixture lists
description: Source-page behavior relevant to collecting every match for a selected date.
---

BeSoccer livescore pages are incrementally loaded. The date page contains its first batch and a `generateMatches(...)` call with the request key and parameters. Later batches come from `/ajax/matchesScroll` using page numbers starting at 2; keep requesting until the response explicitly says `moreItems: false`. The website's own JavaScript requests this endpoint with `Accept: application/json`; its response contains `html` and `moreItems`.

AJAX responses include valid fixture cards that lack `data-cy="match"` but retain an `id="match-<id>"`, so include those when parsing scroll batches. The source’s `allMatches` count is a useful completeness check. When retrieved through Jina Reader, AJAX markup contains escaped quotes, slashes, and newlines and must be normalized before parsing.

Each match card’s `starttime` carries its source-local calendar date. A selected date can include fixtures from later dates: preserve that date, show `DD MON` for a fixture whose actual date differs from the selected date, and show the kickoff time for same-day fixtures. Some future matches use `00:00` as a placeholder with no actual kickoff time.

Direct requests to BeSoccer from this environment returned 406 or challenge HTML, while requests through Jina returned the page content. BeSoccer documents a separate API that requires an account and selected plan; use it for a supported integration when access is available.

**Why:** The first HTML response can contain only 79 of 249 fixtures; relying on it or Markdown alone silently omits matches. The internal AJAX route is not a dependable direct server API here.

**How to apply:** Follow the source pagination through its final-page marker, merge and deduplicate all batches, and fail explicitly if pagination cannot be confirmed complete. Use `starttime`’s date without timezone-shifting it. Prefer parsed HTML when it yields fixtures; fetch Markdown only when HTML fails or yields none.
