import { describe, expect, it } from "vitest";

import { plainText, renderDigestBody } from "../src/inbox/digestBody.ts";
import type { DigestReaction } from "../src/pipeline/digest.ts";

const ZWSP = "\u200B";
const JOB = "00000000-0000-0000-0000-000000000001";

const reaction = (overrides: Partial<DigestReaction> = {}): DigestReaction => ({
  nodeId: "I_1",
  type: "Issue",
  repoFullName: "octo/repo",
  url: "https://github.com/octo/repo/issues/1",
  title: "Bug",
  reactorId: "U_alice",
  reactorLogin: "alice",
  emoji: "THUMBS_UP",
  reactedAt: new Date(),
  ...overrides,
});

describe("plainText", () => {
  it("neutralises mentions and issue references", () => {
    const text = plainText("ping @bob about #123, GH-7 and octo/repo#9");
    expect(text).not.toMatch(/@[a-z]/i);
    expect(text).not.toMatch(/#\d/);
    expect(text).not.toMatch(/GH-\d/i);
    expect(text).toContain(`@${ZWSP}bob`);
    expect(text).toContain(`#${ZWSP}123`);
    expect(text).toContain(`GH\\-${ZWSP}7`);
  });

  it("escapes Markdown and HTML", () => {
    expect(plainText("*bold* [x](y) <b>`c`</b> _u_")).toBe(
      "\\*bold\\* \\[x\\]\\(y\\) \\<b\\>\\`c\\`\\<\\/b\\> \\_u\\_",
    );
  });

  it("routes github.com links through redirect.github.com", () => {
    const text = plainText("see https://github.com/octo/repo/issues/1");
    expect(text).not.toContain("https\\:\\/\\/github");
    expect(text).toContain("redirect\\.github\\.com");
  });

  it("puts the text on one line", () => {
    expect(plainText("  a\n\n b\t c ")).toBe("a b c");
  });
});

describe("renderDigestBody", () => {
  it("groups by item, then by emoji, and ends with the marker", () => {
    const body = renderDigestBody(
      [
        reaction({ reactorLogin: "alice" }),
        reaction({ reactorLogin: "bob", emoji: "HOORAY" }),
        reaction({ reactorLogin: "carol" }),
        reaction({
          nodeId: "IC_2",
          type: "IssueComment",
          title: "Feature",
          url: "https://github.com/octo/repo/issues/2#issuecomment-5",
          reactorLogin: "dave",
          emoji: "HEART",
        }),
      ],
      JOB,
    );
    expect(body).toBe(
      [
        "- 2 new 👍 and 1 new 🎉 on your issue [Bug](https://redirect.github.com/octo/repo/issues/1) in octo\\/repo",
        `  - 👍 [@${ZWSP}alice](https://github.com/alice) and [@${ZWSP}carol](https://github.com/carol)`,
        `  - 🎉 [@${ZWSP}bob](https://github.com/bob)`,
        "- 1 new ❤️ on your comment on [Feature](https://redirect.github.com/octo/repo/issues/2#issuecomment-5) in octo\\/repo",
        `  - ❤️ [@${ZWSP}dave](https://github.com/dave)`,
        "",
        `<!-- grn:${JOB} -->`,
      ].join("\n"),
    );
  });

  it("sanitises titles, so no mention, reference or link survives", () => {
    const body = renderDigestBody(
      [
        reaction({
          title: "@everyone see #123 [here](https://evil.example) <img src=x>",
        }),
      ],
      JOB,
    );
    expect(body).not.toMatch(/@[a-z]/i);
    expect(body).not.toMatch(/#\d/);
    expect(body).not.toContain("](https://evil");
    expect(body).not.toMatch(/(?<!\\)<img/);
    expect(body).not.toContain("https://github.com/octo");
  });

  it("links nothing that isn't https", () => {
    const body = renderDigestBody(
      [reaction({ url: "javascript:alert(1)", title: "" })],
      JOB,
    );
    expect(body).toContain("your issue \\(untitled\\) in");
    expect(body).not.toContain("javascript");
  });

  it("names 10 reactors per emoji and counts the rest", () => {
    const reactions = Array.from({ length: 12 }, (_, i) =>
      reaction({ reactorLogin: `user${i}` }),
    );
    const body = renderDigestBody(reactions, JOB);
    expect(body).toContain("12 new 👍");
    expect(body).toContain("user9");
    expect(body).not.toContain("user10");
    expect(body).toContain("and 2 others");
  });

  it("truncates at 65,536 characters with …and N more items", () => {
    const reactions = Array.from({ length: 2000 }, (_, i) =>
      reaction({
        nodeId: `I_${i}`,
        title: `Item ${i} ${"x".repeat(100)}`,
        url: `https://github.com/octo/repo/issues/${i}`,
      }),
    );
    const body = renderDigestBody(reactions, JOB);
    expect(body.length).toBeLessThanOrEqual(65_536);
    const shown = body.split("\n").filter((line) => line.startsWith("- "));
    const more = /…and (\d+) more items/.exec(body);
    expect(more).not.toBeNull();
    expect(shown.length + Number(more?.[1])).toBe(2000);
    expect(body.endsWith(`<!-- grn:${JOB} -->`)).toBe(true);
  });
});
