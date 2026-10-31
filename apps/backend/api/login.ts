/**
 * @file `GET /api/login`: starts sign-in through GitHub's OAuth flow, requesting no scopes
 * (FR-1).
 */

import { defaultHandlers } from "../src/oauth.ts";

export default defaultHandlers.login;
