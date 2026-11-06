import { schema as githubSchema } from "@octokit/graphql-schema";
import { buildSchema, parse, print, validate } from "graphql";
import { describe, expect, it } from "vitest";

import { buildReactionSnapshotDocument } from "../src/graphql/reactionSnapshotDocument.js";

// GitHub's SDL declares a few fields twice, which trips SDL validation
const schemaAst = buildSchema(githubSchema.idl, { assumeValidSDL: true });

describe("buildReactionSnapshotDocument", () => {
  it("is valid against GitHub's schema, one alias per item", () => {
    const document = parse(buildReactionSnapshotDocument(3).text);

    expect(validate(schemaAst, document)).toEqual([]);
    const text = print(document);
    for (const index of [0, 1, 2]) {
      expect(text).toContain(`item_${index}: node(id: $id_${index})`);
    }
    expect(text).not.toContain("item_3");
    expect(text).toContain("reactionGroups {");
    expect(text).toContain("rateLimit {");
  });
});
