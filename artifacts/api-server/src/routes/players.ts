import { Router, type IRouter } from "express";
import {
  GetPlayerDetailsParams,
  GetPlayerDetailsQueryParams,
  GetPlayerDetailsResponse,
} from "@workspace/api-zod";
import { getPlayerDetails } from "../lib/besoccer";

const router: IRouter = Router();

router.get("/players/:playerSlug", async (req, res): Promise<void> => {
  const params = GetPlayerDetailsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "A valid player slug is required." });
    return;
  }

  const query = GetPlayerDetailsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: "A valid player page is required." });
    return;
  }

  try {
    const details = await getPlayerDetails(params.data.playerSlug, query.data.tab);
    res.json(GetPlayerDetailsResponse.parse(details));
  } catch (error) {
    req.log.error(
      { err: error, playerSlug: params.data.playerSlug },
      "Unable to load player profile",
    );
    res.status(502).json({ error: "Player data is temporarily unavailable." });
  }
});

export default router;
