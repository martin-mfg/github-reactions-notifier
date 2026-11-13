import { NOTIFY_BUTTON, SUMMARY_BUTTON } from "../users/mode.ts";
import type { UserMode } from "../users/mode.ts";

/** A rendered inbox opening: the payload of its `deliver` job (§13). */
export interface OpeningPayload {
  title: string;
  body: string;
}

/**
 * Renders the issue that opens a user's inbox (§11), in the mode of the sign-in that
 * requested it (M1.2 §8.1). Its body is the only place GRN mentions anyone: the @mention of
 * the user subscribes them to the comments posted later.
 *
 * @param login The user's login. GitHub logins contain only letters, digits and hyphens.
 * @param jobId The opening `deliver` job's id, embedded as the idempotency marker (§12).
 * @param siteUrl GRN's site, where the user can switch modes or delete their account.
 * @param mode The user's mode when the inbox is requested.
 * @returns The issue's title and body.
 */
export const renderOpening = (
  login: string,
  jobId: string,
  siteUrl: string,
  mode: UserMode,
): OpeningPayload => {
  if (!/^[A-Za-z0-9-]+$/.test(login)) {
    throw new Error(`Unexpected GitHub login: ${JSON.stringify(login)}`);
  }
  const text =
    mode === "summary"
      ? [
          "Your sign-in to GitHub-Reactions-Notifier requested this issue. You asked for a " +
            "one-time summary of the reactions to your issues, pull requests and comments. " +
            "It will be posted here once GitHub-Reactions-Notifier has scanned your history.",
          "",
          `To also get notified about new reactions, choose "${NOTIFY_BUTTON}" at ${siteUrl}. ` +
            "To delete your data, delete your account there.",
        ]
      : [
          "Your sign-in to GitHub-Reactions-Notifier requested this issue. New reactions to your " +
            "issues, pull requests and comments will be posted here as comments, so GitHub " +
            "notifies you about them. Reactions from before your sign-in are not reported.",
          "",
          `To stop notifications, choose "${SUMMARY_BUTTON}" at ${siteUrl}. To resume, ` +
            `choose "${NOTIFY_BUTTON}" there. To delete your data, delete your account there.`,
        ];
  return {
    title: `Reactions inbox of ${login}`,
    body: [
      `Hi @${login}, this is your GitHub-Reactions-Notifier inbox.`,
      "",
      ...text,
      "",
      `<!-- grn:${jobId} -->`,
    ].join("\n"),
  };
};
