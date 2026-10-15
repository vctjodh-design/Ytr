---
name: BeSoccer match rounds
description: Public match-table round selection and the limits of the web match-round source.
---

The BeSoccer web `/table` page exposes available matchdays in `select[data-cy="roundSelect"]`. Its `#classificationTables` element provides the IDs needed for the page's `GET /ajax/reloadTable` request (`type`, `itemId`, `competitionId`, `year`, `group`, and `round`). This returns a standings snapshot for a selected round.

The match `/rounds` page observed here only contains the current round's match. It does not expose the mobile app's round-fixture selector. A suggested root query using `req=matchs_day`, `date`, and `format=json` returned HTTP 406 for both `besoccer.com` and `www.besoccer.com` in this environment, so treat it as unverified rather than a usable JSON contract. BeSoccer's official API documentation lists day matches and matchday fixtures, and says an API plan is required; its budgets page says there are no free accounts.

**Why:** Historical standings and round fixture lists come from different source capabilities; presenting the standings reload endpoint as a fixture-feed endpoint would produce incorrect data.

**How to apply:** Use the public table reload for round-specific standings. For round-by-round fixture cards, verify a public web/app feed or use the official API only when the project has authorized access; do not assume the `req=matchs_day` query is supported.
