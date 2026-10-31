/** A rendered inbox opening: the payload of its `deliver` job (§13). */
export interface OpeningPayload {
  title: string;
  body: string;
}

/**
 * Renders the issue that opens a user's inbox (§11). Its body is the only place GRN mentions
 * anyone: the @mention of the user subscribes them to the digests posted as comments later.
 *
 * @param login The user's login. GitHub logins contain only letters, digits and hyphens.
 * @param jobId The opening `deliver` job's id, embedded as the idempotency marker (§12).
 * @param siteUrl GRN's site, where the user can delete their account.
 * @returns The issue's title and body.
 */
export const renderOpening = (
  login: string,
  jobId: string,
  siteUrl: string,
): OpeningPayload => {
  if (!/^[A-Za-z0-9-]+$/.test(login)) {
    throw new Error(`Unexpected GitHub login: ${JSON.stringify(login)}`);
  }
  return {
    title: `Reactions inbox of ${login}`,
    body: [
      `@${login}, this is your GitHub Reactions Notifier inbox.`,
      "",
      "Your sign-in to GitHub Reactions Notifier requested this issue. New reactions to your " +
        "issues, pull requests and comments will be posted here as comments, so GitHub " +
        "notifies you about them. Reactions from before your sign-in are not reported.",
      "",
      `To stop, delete your account at ${siteUrl}.`,
      "",
      `<!-- grn:${jobId} -->`,
    ].join("\n"),
  };
};
