import { emojiOf, plainText } from "./digestBody.ts";

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

/** The backfill summary's numbers (M1.1 §5.1). */
export interface ReactionSummary {
  /** Items found per content type (`content.type`), one table column each, in order. */
  items: Array<{ type: string; count: number }>;
  /** Items with at least one reaction. */
  withReactions: number;
  /** Reactions per `ReactionContent` value; ties keep this order. */
  reactions: Record<string, number>;
}

const TYPE_LABEL: Partial<Record<string, string>> = {
  Issue: "Issues",
  PullRequest: "Pull requests",
  IssueComment: "Comments",
};

/** A narrow no-break space: the thousands separator, independent of any locale. */
const THOUSANDS = "\u202F";

/**
 * @param count A non-negative integer.
 * @returns The count with a narrow no-break space between groups of three digits.
 */
const formatCount = (count: number): string =>
  String(count).replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS);

const sum = (values: Array<number>): number =>
  values.reduce((total, value) => total + value, 0);

/**
 * Renders the backfill summary (M1.1 §5.2), posted once after GRN has scanned the user's
 * history: items found per type, items with reactions, reactions in total and per emoji (by
 * count, descending, zeros left out). Without any items, a shortened form. Like every
 * comment, it mentions nobody (§11).
 *
 * @param jobId The summary's `deliver` job id, embedded as the idempotency marker (§12).
 * @param summary The numbers.
 * @returns The comment's body.
 */
export const renderReactionSummary = (
  jobId: string,
  summary: ReactionSummary,
): NoticePayload => {
  const heading = "## 📊 Your reactions so far";
  const footer = [
    "From now on, new reactions show up here as they arrive.",
    "",
    `<!-- grn:${jobId} -->`,
  ];
  const totalItems = sum(summary.items.map((item) => item.count));
  if (totalItems === 0) {
    return {
      body: [
        heading,
        "",
        "GRN finished scanning your history and found no issues, pull requests or comments " +
          "of yours.",
        "",
        ...footer,
      ].join("\n"),
    };
  }

  const row = (cells: Array<string>) => `| ${cells.join(" | ")} |`;
  const table = [
    row([
      " ",
      ...summary.items.map(
        (item) => TYPE_LABEL[item.type] ?? plainText(item.type),
      ),
      "Total",
    ]),
    row(["---", ...summary.items.map(() => "---:"), "---:"]),
    row([
      "Items found",
      ...summary.items.map((item) => formatCount(item.count)),
      formatCount(totalItems),
    ]),
  ];
  const reactions = Object.entries(summary.reactions);
  const emojiLine = reactions
    .filter(([, count]) => count > 0)
    // stable: ties keep the summary's order
    .sort(([, a], [, b]) => b - a)
    .map(([content, count]) => `${emojiOf(content)} ${formatCount(count)}`)
    .join(" · ");
  return {
    body: [
      heading,
      "",
      "GRN finished scanning your history. Here's where things stand:",
      "",
      ...table,
      "",
      `- Items with reactions: ${formatCount(summary.withReactions)}`,
      `- Reactions: ${formatCount(sum(reactions.map(([, count]) => count)))}`,
      "",
      ...(emojiLine === "" ? [] : [emojiLine, ""]),
      ...footer,
    ].join("\n"),
  };
};
