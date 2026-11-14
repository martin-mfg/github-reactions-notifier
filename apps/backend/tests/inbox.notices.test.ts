import { describe, expect, it } from "vitest";

import {
  renderReactionSummary,
  renderRevokedNotice,
} from "../src/inbox/notices.ts";
import type { ReactionSummary } from "../src/inbox/notices.ts";
import { renderOpening } from "../src/inbox/opening.ts";

const NNBSP = "\u202F";

const notify = { mode: "notify", siteUrl: "https://grn.example" } as const;

const reactions = (
  counts: Partial<Record<string, number>> = {},
): Record<string, number> =>
  Object.fromEntries(
    [
      "THUMBS_UP",
      "THUMBS_DOWN",
      "LAUGH",
      "HOORAY",
      "CONFUSED",
      "HEART",
      "ROCKET",
      "EYES",
    ].map((content) => [content, counts[content] ?? 0]),
  );

const summary = (
  overrides: Partial<ReactionSummary> = {},
): ReactionSummary => ({
  items: [
    { type: "Issue", count: 120 },
    { type: "PullRequest", count: 45 },
    { type: "IssueComment", count: 2310 },
  ],
  withReactions: 460,
  reactions: reactions({
    THUMBS_UP: 800,
    THUMBS_DOWN: 9,
    LAUGH: 70,
    HOORAY: 120,
    CONFUSED: 20,
    HEART: 210,
    ROCKET: 90,
    EYES: 40,
  }),
  ...overrides,
});

describe("renderReactionSummary", () => {
  it("renders the table, the totals and every emoji by count", () => {
    expect(renderReactionSummary("job-1", summary(), notify).body).toBe(
      [
        "## 📊 Your reactions so far",
        "",
        "GitHub-Reactions-Notifier finished scanning your history. Here's a summary of all reactions:",
        "",
        "|   | Issues | Pull requests | Comments | Total |",
        "| --- | ---: | ---: | ---: | ---: |",
        `| Items found | 120 | 45 | 2${NNBSP}310 | 2${NNBSP}475 |`,
        "",
        "- Items with reactions: 460",
        `- Reactions: 1${NNBSP}359`,
        "",
        "👍 800 · ❤️ 210 · 🎉 120 · 🚀 90 · 😄 70 · 👀 40 · 😕 20 · 👎 9",
        "",
        "From now on, new reactions show up here as they arrive.",
        "",
        "<!-- grn:job-1 -->",
      ].join("\n"),
    );
  });

  it("leaves out emoji without reactions, and keeps ties in ReactionContent order", () => {
    const { body } = renderReactionSummary(
      "job-1",
      summary({ reactions: reactions({ EYES: 3, HEART: 3, THUMBS_DOWN: 1 }) }),
      notify,
    );

    expect(body).toContain("\n❤️ 3 · 👀 3 · 👎 1\n");
    expect(body).not.toContain("👍");
  });

  it("drops the emoji line without any reactions", () => {
    const { body } = renderReactionSummary(
      "job-1",
      summary({ withReactions: 0, reactions: reactions() }),
      notify,
    );

    expect(body).toContain(
      "- Reactions: 0\n\nFrom now on, new reactions show up here as they arrive.",
    );
  });

  it("groups digits of large numbers in threes", () => {
    const { body } = renderReactionSummary(
      "job-1",
      summary({ reactions: reactions({ THUMBS_UP: 1_234_567 }) }),
      notify,
    );

    expect(body).toContain(`👍 1${NNBSP}234${NNBSP}567`);
  });

  it("shows a type without items as 0, and an unknown type by its name", () => {
    const { body } = renderReactionSummary(
      "job-1",
      summary({
        items: [
          { type: "Issue", count: 0 },
          { type: "PullRequest", count: 2 },
          { type: "IssueComment", count: 1 },
          { type: "Discussion", count: 4 },
        ],
      }),
      notify,
    );

    expect(body).toContain(
      "|   | Issues | Pull requests | Comments | Discussion | Total |\n" +
        "| --- | ---: | ---: | ---: | ---: | ---: |\n" +
        "| Items found | 0 | 2 | 1 | 4 | 7 |",
    );
  });

  it("renders the shortened form without any items", () => {
    expect(
      renderReactionSummary(
        "job-1",
        summary({
          items: [
            { type: "Issue", count: 0 },
            { type: "PullRequest", count: 0 },
            { type: "IssueComment", count: 0 },
          ],
          withReactions: 0,
          reactions: reactions(),
        }),
        notify,
      ).body,
    ).toBe(
      [
        "## 📊 Your reactions so far",
        "",
        "GitHub-Reactions-Notifier finished scanning your history and found no issues, pull " +
          "requests or comments of yours.",
        "",
        "From now on, new reactions show up here as they arrive.",
        "",
        "<!-- grn:job-1 -->",
      ].join("\n"),
    );
  });

  it("mentions nobody and references no issue", () => {
    for (const body of [
      renderReactionSummary("job-1", summary(), notify).body,
      renderReactionSummary("job-1", summary({ items: [] }), notify).body,
    ]) {
      expect(body).not.toContain("@");
      expect(body).not.toMatch(/#\d/);
    }
  });
});

describe("M1.2 texts", () => {
  const site = "https://grn.example";
  const summaryMode = { mode: "summary", siteUrl: site } as const;

  it("closes a summary-mode summary without promising more posts", () => {
    for (const body of [
      renderReactionSummary("job-1", summary(), summaryMode).body,
      renderReactionSummary("job-1", summary({ items: [] }), summaryMode).body,
    ]) {
      expect(body).toContain(
        "That's it: you asked for a one-time summary, so GitHub-Reactions-Notifier won't post " +
          'here again unless you ask. For a fresh summary, choose "Just send me a one-time summary" again at ' +
          `${site}. To get notified about new reactions, choose "Get notified about ` +
          'reactions" there.\n\n<!-- grn:job-1 -->',
      );
      expect(body).not.toContain("From now on");
    }
  });

  it("renders FR-17's notice for each mode", () => {
    expect(renderRevokedNotice("job-2", site, "summary").body).toBe(
      [
        "GitHub-Reactions-Notifier can no longer read your content: its access to your " +
          "GitHub account was revoked or has expired. Scanning has stopped, so your summary " +
          "can't be completed.",
        "",
        `To resume, choose "Just send me a one-time summary" again at ${site}.`,
        "",
        "<!-- grn:job-2 -->",
      ].join("\n"),
    );
    expect(renderRevokedNotice("job-2", site, "notify").body).toContain(
      `Polling has stopped, so no further reactions will be posted here.\n\nTo resume, sign in again at ${site}.`,
    );
  });

  it("renders the notify-mode opening with the stop hint", () => {
    const { title, body } = renderOpening("alice", "job-3", site, "notify");

    expect(title).toBe("Test inbox of alice");
    expect(body).toContain(
      `To stop notifications, choose "Just send me a one-time summary" at ${site}. To ` +
        'resume, choose "Get notified about reactions" there. To delete your data, delete ' +
        "your account there.",
    );
    expect(body).not.toContain("To stop, delete your account");
  });

  it("renders the summary-mode opening", () => {
    expect(renderOpening("alice", "job-3", site, "summary").body).toBe(
      [
        "Hi @martin-mfg, this is the test GitHub-Reactions-Notifier inbox of `alice`.",
        "",
        "Your sign-in to GitHub-Reactions-Notifier requested this issue. You asked for a " +
          "one-time summary of the reactions to your issues, pull requests and comments. It " +
          "will be posted here once GitHub-Reactions-Notifier has scanned your history.",
        "",
        `To also get notified about new reactions, choose "Get notified about reactions" at ${site}. ` +
          "To delete your data, delete your account there.",
        "",
        "<!-- grn:job-3 -->",
      ].join("\n"),
    );
  });

  it("mentions nobody but the shadow operator, in the opening only", () => {
    for (const body of [
      renderReactionSummary("job-1", summary(), summaryMode).body,
      renderRevokedNotice("job-2", site, "summary").body,
      renderRevokedNotice("job-2", site, "notify").body,
    ]) {
      expect(body).not.toContain("@");
      expect(body).not.toMatch(/#\d/);
    }
    for (const mode of ["notify", "summary"] as const) {
      const { body } = renderOpening("alice", "job-3", site, mode);
      expect(body.match(/@/g)).toEqual(["@"]);
      expect(body).toMatch(/^Hi @martin-mfg,/);
      expect(body).not.toMatch(/@alice/);
      expect(body).not.toMatch(/#\d/);
    }
  });
});
