import { Router, type IRouter } from "express";
import {
  GetTeamDetailsParams,
  GetTeamDetailsQueryParams,
  GetTeamDetailsResponse,
} from "@workspace/api-zod";
import { getTeamDetails } from "../lib/besoccer";

const router: IRouter = Router();

router.get("/teams/:teamSlug", async (req, res): Promise<void> => {
  const params = GetTeamDetailsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "A valid team slug is required." });
    return;
  }

  const query = GetTeamDetailsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "A valid team page is required." });
    return;
  }

  try {
    const details = await getTeamDetails(params.data.teamSlug, query.data.tab);
    res.json(GetTeamDetailsResponse.parse(details));
  } catch (error) {
    req.log.error(
      { err: error, teamSlug: params.data.teamSlug },
      "Unable to load team profile",
    );
    res.status(502).json({ error: "Team data is temporarily unavailable." });
  }
});

export default router;
