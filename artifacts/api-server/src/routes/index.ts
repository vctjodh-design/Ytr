import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fixturesRouter from "./fixtures";
import teamsRouter from "./teams";
import playersRouter from "./players";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fixturesRouter);
router.use(teamsRouter);
router.use(playersRouter);

export default router;
