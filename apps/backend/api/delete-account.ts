/**
 * @file `POST /api/delete-account`: starts account deletion (FR-3). The user confirms their
 * identity through GitHub's OAuth flow; the callback deletes the data and the grant.
 */

import { defaultHandlers } from "../src/oauth.ts";

export default defaultHandlers.deleteAccount;
