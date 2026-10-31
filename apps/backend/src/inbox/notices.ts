/** A one-off message to the user's inbox: the payload of an already-rendered `deliver` job. */
export interface NoticePayload {
  body: string;
}

/**
 * Renders FR-17's notice, posted to the user's inbox after their token was revoked or expired.
 * Like every comment, it mentions nobody (§11).
 *
 * @param jobId The notice's `deliver` job id, embedded as the idempotency marker (§12).
 * @param siteUrl GRN's site, where the user signs in again.
 * @returns The comment's body.
 */
export const renderRevokedNotice = (
  jobId: string,
  siteUrl: string,
): NoticePayload => ({
  body: [
    "GitHub Reactions Notifier can no longer read your reactions: its access to your GitHub " +
      "account was revoked or has expired. Polling has stopped, so no further reactions " +
      "will be posted here.",
    "",
    `To resume, sign in again at ${siteUrl}.`,
    "",
    `<!-- grn:${jobId} -->`,
  ].join("\n"),
});
