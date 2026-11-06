import { describe, expect, it } from "vitest";

import { renderReactionSummary } from "../src/inbox/notices.ts";
import type { ReactionSummary } from "../src/inbox/notices.ts";

const NNBSP = "\u202F";

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
    expect(renderReactionSummary("job-1", summary()).body).toBe(
      [
        "## 📊 Your reactions so far",
        "",
        "GRN finished scanning your history. Here's where things stand:",
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
    );

    expect(body).toContain("\n❤️ 3 · 👀 3 · 👎 1\n");
    expect(body).not.toContain("👍");
  });

  it("drops the emoji line without any reactions", () => {
    const { body } = renderReactionSummary(
      "job-1",
      summary({ withReactions: 0, reactions: reactions() }),
    );

    expect(body).toContain(
      "- Reactions: 0\n\nFrom now on, new reactions show up here as they arrive.",
    );
  });

  it("groups digits of large numbers in threes", () => {
    const { body } = renderReactionSummary(
      "job-1",
      summary({ reactions: reactions({ THUMBS_UP: 1_234_567 }) }),
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
      ).body,
    ).toBe(
      [
        "## 📊 Your reactions so far",
        "",
        "GRN finished scanning your history and found no issues, pull requests or comments of yours.",
        "",
        "From now on, new reactions show up here as they arrive.",
        "",
        "<!-- grn:job-1 -->",
      ].join("\n"),
    );
  });

  it("mentions nobody and references no issue", () => {
    for (const body of [
      renderReactionSummary("job-1", summary()).body,
      renderReactionSummary("job-1", summary({ items: [] })).body,
    ]) {
      expect(body).not.toContain("@");
      expect(body).not.toMatch(/#\d/);
    }
  });
});
