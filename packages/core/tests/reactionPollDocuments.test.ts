import { schema as githubSchema } from "@octokit/graphql-schema";
import { buildSchema, parse, print, validate } from "graphql";
import { describe, expect, it } from "vitest";

import {
  buildReactionDrillDownDocument,
  buildReactionProbeDocument,
} from "../src/graphql/reactionPollDocuments.js";

// GitHub's SDL declares a few fields twice, which trips SDL validation
const schemaAst = buildSchema(githubSchema.idl, { assumeValidSDL: true });

describe.each([
  ["buildReactionProbeDocument", buildReactionProbeDocument, "first: 1"],
  [
    "buildReactionDrillDownDocument",
    buildReactionDrillDownDocument,
    "first: 100",
  ],
])("%s", (_name, build, page) => {
  it("is valid against GitHub's schema, one alias per item", () => {
    const document = parse(build(3).text);

    expect(validate(schemaAst, document)).toEqual([]);
    const text = print(document);
    for (const index of [0, 1, 2]) {
      expect(text).toContain(`item_${index}: node(id: $id_${index})`);
    }
    expect(text).not.toContain("item_3");
    expect(text).toContain(
      `reactions(${page}, orderBy: {field: CREATED_AT, direction: DESC})`,
    );
  });
});
