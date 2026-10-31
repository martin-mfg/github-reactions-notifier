/**
 * @file `GET /api/cron`: the scheduler (§7.1), called by Vercel Cron every minute.
 */

import { defaultCronHandler } from "../src/cron.ts";

export default defaultCronHandler;
