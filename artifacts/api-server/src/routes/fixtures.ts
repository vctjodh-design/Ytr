import { Router, type IRouter } from "express";
import {
  GetMatchDetailsParams,
  GetMatchDetailsQueryParams,
  GetMatchDetailsResponse,
  GetMatchOddsParams,
  GetMatchOddsQueryParams,
  GetMatchOddsResponse,
  ListFixturesResponse,
} from "@workspace/api-zod";
import {
  getMatchById,
  getMatchOdds,
  isValidDate,
  listFixturesForDate,
} from "../lib/besoccer";

const router: IRouter = Router();

router.get("/fixtures", async (req, res): Promise<void> => {
  const date = req.query.date;
  if (typeof date !== "string" || !isValidDate(date)) {
    res.status(400).json({ error: "A valid date is required (YYYY-MM-DD)." });
    return;
  }

  res.setHeader("Cache-Control", "no-store");
  try {
    const fixtures = await listFixturesForDate(date);
    res.json(ListFixturesResponse.parse(fixtures));
  } catch (error) {
    req.log.error({ err: error, date }, "Unable to load fixtures");
    res.status(502).json({ error: "Fixture data is temporarily unavailable." });
  }
});

router.get("/matches/:matchId/odds", async (req, res): Promise<void> => {
  const params = GetMatchOddsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "A valid match id is required." });
    return;
  }

  const query = GetMatchOddsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "A valid odds market is required." });
    return;
  }

  try {
    const odds = await getMatchOdds(
      params.data.matchId,
      query.data.marketId,
      query.data.sourcePath,
    );
    res.json(GetMatchOddsResponse.parse(odds));
  } catch (error) {
    req.log.error(
      { err: error, matchId: params.data.matchId, marketId: query.data.marketId },
      "Unable to load match odds",
    );
    res.status(502).json({ error: "Odds data is temporarily unavailable." });
  }
});

router.get("/matches/:matchId", async (req, res): Promise<void> => {
  const params = GetMatchDetailsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "A valid match id is required." });
    return;
  }

  const query = GetMatchDetailsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "The BeSoccer match path is invalid." });
    return;
  }

  try {
    const details = await getMatchById(
      params.data.matchId,
      query.data.sourcePath,
    );
    res.json(GetMatchDetailsResponse.parse(details));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Match details are not available for this id"
    ) {
      res.status(404).json({ error: "Match details are unavailable." });
      return;
    }

    req.log.error(
      { err: error, matchId: params.data.matchId },
      "Unable to load match details",
    );
    res.status(502).json({ error: "Match data is temporarily unavailable." });
  }
});

export default router;
