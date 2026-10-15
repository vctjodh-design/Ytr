---
name: BeSoccer team content
description: Source-page behavior for preserving team-tab structure and imagery.
---

BeSoccer team tabs expose content modules in HTML as `div` elements with IDs beginning `mod_`. Their document order and module headings are meaningful. The markdown rendition flattens complex module content and reduces image references to labels, so it is not a reliable source for team-page presentation.

**Why:** Team pages include ordered cards, native tables, logos, player photos, and other images that become a long, loosely ordered text list in markdown.

**How to apply:** Request HTML through the source proxy, parse the `mod_*` content modules in document order, and keep text, images, and tables as ordered typed blocks. Exclude page chrome and hidden popup modules.

Roster tables expose alternate stat columns through `data-content-tab`, keyed by the active link in `ul.panel-tab`. Group headings repeat as `row-head` rows, while player portraits and club badges often occupy a separate cell just before the name.

**Why:** Treating every cell as a column flattens position headings into the header, leaks inactive tab values, and separates crests or portraits from the row they identify.

**How to apply:** Select the active content-tab key when present, preserve repeated group rows as section rows, and move `player-img` or `td-shield` imagery into the following name cell while keeping row/cell indexes aligned. For non-table blocks, associate a standalone image with nearby text only when its alt text matches; remove duplicate responsive copies.

Team-page HTML requests share a rate-limited source proxy. Large parallel bursts can return HTTP 429 even when the individual team routes are valid.

**Why:** Fetching several team pages at once for both clubs exceeded the proxy’s request tolerance; bounded concurrency allowed each team dossier to load.

**How to apply:** Keep raw HTML source requests bounded and use a brief, limited retry for 429 responses. Avoid launching multiple full team-page requests simultaneously.
