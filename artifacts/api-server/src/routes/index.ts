import { Router, type IRouter } from "express";
import healthRouter from "./health";
import fixturesRouter from "./fixtures";
import teamsRouter from "./teams";

const router: IRouter = Router();

router.use(healthRouter);
router.use(fixturesRouter);
router.use(teamsRouter);

export default router;
