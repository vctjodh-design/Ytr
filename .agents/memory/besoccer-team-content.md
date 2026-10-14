---
name: BeSoccer team content
description: Source-page behavior for preserving team-tab structure and imagery.
---

BeSoccer team tabs expose content modules in HTML as `div` elements with IDs beginning `mod_`. Their document order and module headings are meaningful. The markdown rendition flattens complex module content and reduces image references to labels, so it is not a reliable source for team-page presentation.

**Why:** Team pages include ordered cards, native tables, logos, player photos, and other images that become a long, loosely ordered text list in markdown.

**How to apply:** Request HTML through the source proxy, parse the `mod_*` content modules in document order, and keep text, images, and tables as ordered typed blocks. Exclude page chrome and hidden popup modules.

Team-page HTML requests share a rate-limited source proxy. Large parallel bursts can return HTTP 429 even when the individual team routes are valid.

**Why:** Fetching several team pages at once for both clubs exceeded the proxy’s request tolerance; bounded concurrency allowed each team dossier to load.

**How to apply:** Keep raw HTML source requests bounded and use a brief, limited retry for 429 responses. Avoid launching multiple full team-page requests simultaneously.
