/**
 * @file `GET /api/oauth/callback`: GitHub's OAuth redirect target for sign-in and deletion.
 */

import { defaultHandlers } from "../../src/oauth.ts";

export default defaultHandlers.callback;
