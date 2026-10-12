import { Router, type IRouter } from "express";
import {
  GetMatchDetailsParams,
  GetMatchDetailsQueryParams,
  GetMatchDetailsResponse,
  ListFixturesResponse,
} from "@workspace/api-zod";
import {
  getMatchById,
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

  try {
    const fixtures = await listFixturesForDate(date);
    res.json(ListFixturesResponse.parse(fixtures));
  } catch (error) {
    req.log.error({ err: error, date }, "Unable to load fixtures");
    res.status(502).json({ error: "Fixture data is temporarily unavailable." });
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
