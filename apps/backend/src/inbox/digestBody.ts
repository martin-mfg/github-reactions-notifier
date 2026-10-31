import type { ContentType } from "../discovery/store.ts";
import type { DigestReaction, DigestRenderer } from "../pipeline/digest.ts";

/** GitHub's limit for an issue or comment body (§11). */
const MAX_BODY_LENGTH = 65_536;
/** Logins named per emoji of an item; the rest are counted. Bounds an item's size. */
const MAX_LOGINS_PER_EMOJI = 10;
const ZWSP = "\u200B";

/** GraphQL's `ReactionContent` values. */
const EMOJI: Partial<Record<string, string>> = {
  THUMBS_UP: "👍",
  THUMBS_DOWN: "👎",
  LAUGH: "😄",
  HOORAY: "🎉",
  CONFUSED: "😕",
  HEART: "❤️",
  ROCKET: "🚀",
  EYES: "👀",
};

const ITEM_LABEL: Record<ContentType, string> = {
  Issue: "your issue",
  PullRequest: "your pull request",
  IssueComment: "your comment on",
};

const GITHUB_URL = /https?:\/\/(?:www\.)?github\.com\//gi;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const LOGIN = /^[A-Za-z0-9-]+$/;

/**
 * Renders quoted text, such as a title, as plain text (§11): every ASCII punctuation character
 * is backslash-escaped, so no Markdown or HTML survives; every `@` and every issue reference
 * (`#123`, `GH-123`, `owner/repo#123`) gets a zero-width space, so it mentions or links no one,
 * even quoted in an e-mail reply; and every github.com URL goes through `redirect.github.com`.
 *
 * @param text The text to quote.
 * @returns Markdown that shows `text`, on one line.
 */
export const plainText = (text: string): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .replace(GITHUB_URL, "https://redirect.github.com/")
    .replace(/@/g, `@${ZWSP}`)
    .replace(/#(?=\d)/g, `#${ZWSP}`)
    .replace(/(GH-)(?=\d)/gi, `$1${ZWSP}`)
    .replace(ASCII_PUNCTUATION, "\\$&");

/**
 * @param url A github.com URL of an issue, PR or comment.
 * @returns The URL through `redirect.github.com`, so linking it creates no "mentioned this"
 *   event (§11), and safe as a Markdown link destination; or `null` if it isn't `https`.
 */
const redirectUrl = (url: string): string | null =>
  url.startsWith("https://")
    ? url
        .replace(GITHUB_URL, "https://redirect.github.com/")
        .replace(
          /[\s()<>\\]/g,
          (char) =>
            `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
        )
    : null;

/**
 * @param login A reactor's login.
 * @returns The login with a zero-width space after the `@`, linked to its profile (§11).
 */
const userLink = (login: string): string =>
  LOGIN.test(login)
    ? `[@${ZWSP}${login}](https://github.com/${login})`
    : plainText(`@${login}`);

const emojiOf = (name: string): string => EMOJI[name] ?? plainText(name);

/**
 * @param parts The parts to list.
 * @returns `a`, `a and b`, or `a, b and c`.
 */
const list = (parts: Array<string>): string =>
  parts.length < 2
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1) ?? ""}`;

interface ItemGroup {
  reaction: DigestReaction;
  /** Logins by emoji, in order of first appearance. */
  emojis: Map<string, Array<string>>;
}

/**
 * @param reactions The digest's reactions, oldest first.
 * @returns The reactions grouped by item, then by emoji (FR-15), in order of first appearance.
 */
const groupReactions = (reactions: Array<DigestReaction>): Array<ItemGroup> => {
  const items = new Map<string, ItemGroup>();
  for (const reaction of reactions) {
    let item = items.get(reaction.nodeId);
    if (!item) {
      item = { reaction, emojis: new Map() };
      items.set(reaction.nodeId, item);
    }
    const logins = item.emojis.get(reaction.emoji) ?? [];
    logins.push(reaction.reactorLogin);
    item.emojis.set(reaction.emoji, logins);
  }
  return [...items.values()];
};

/**
 * @param group One item's reactions.
 * @returns The item's block: "5 new 👍 and 2 new 🎉 on *item*", then who reacted with each emoji.
 */
const renderItem = (group: ItemGroup): string => {
  const { reaction, emojis } = group;
  const counts = [...emojis].map(
    ([emoji, logins]) => `${logins.length} new ${emojiOf(emoji)}`,
  );
  const title = plainText(reaction.title) || "\\(untitled\\)";
  const url = redirectUrl(reaction.url);
  const item = url === null ? title : `[${title}](${url})`;
  const lines = [
    `- ${list(counts)} on ${ITEM_LABEL[reaction.type]} ${item} in ${plainText(reaction.repoFullName)}`,
  ];
  for (const [emoji, logins] of emojis) {
    const named = logins.slice(0, MAX_LOGINS_PER_EMOJI).map(userLink);
    const others = logins.length - named.length;
    if (others > 0) {
      named.push(`${others} ${others === 1 ? "other" : "others"}`);
    }
    lines.push(`  - ${emojiOf(emoji)} ${list(named)}`);
  }
  return lines.join("\n");
};

const moreItems = (count: number): string =>
  count === 0 ? "" : `\n\n…and ${count} more ${count === 1 ? "item" : "items"}`;

/**
 * Renders a digest's comment (§11, FR-15): one block per item, grouped by item and then by
 * emoji, with no live mention and no cross-reference. Items that would take the body past
 * 65,536 characters are left out and counted ("…and N more items"). Ends with the
 * idempotency marker (§12).
 *
 * @param reactions The digest's reactions, oldest first.
 * @param jobId The digest's job id.
 * @returns The comment's body.
 */
export const renderDigestBody: DigestRenderer = (reactions, jobId) => {
  const marker = `\n\n<!-- grn:${jobId} -->`;
  const blocks = groupReactions(reactions).map(renderItem);
  let length = 0;
  let shown = 0;
  for (const block of blocks) {
    const next = length + (shown === 0 ? 0 : 1) + block.length;
    const rest = blocks.length - shown - 1;
    if (next + moreItems(rest).length + marker.length > MAX_BODY_LENGTH) {
      break;
    }
    length = next;
    shown += 1;
  }
  return (
    blocks.slice(0, shown).join("\n") +
    moreItems(blocks.length - shown) +
    marker
  );
};
