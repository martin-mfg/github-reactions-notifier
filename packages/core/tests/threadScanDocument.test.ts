import { schema as githubSchema } from "@octokit/graphql-schema";
import { Kind, buildSchema, parse, print, validate } from "graphql";
import type { DocumentNode } from "graphql";
import { describe, expect, it } from "vitest";

import { AuthoredBackfillDocument } from "../src/graphql/generated/authoredBackfill.js";
import { buildThreadScanDocument } from "../src/graphql/threadScanDocument.js";

// GitHub's SDL declares a few fields twice, which trips SDL validation
const schemaAst = buildSchema(githubSchema.idl, { assumeValidSDL: true });

const fragment = (document: DocumentNode, name: string) =>
  document.definitions.find(
    (definition) =>
      definition.kind === Kind.FRAGMENT_DEFINITION &&
      definition.name.value === name,
  );

describe("buildThreadScanDocument", () => {
  it("is valid against GitHub's schema, one alias and `since` per thread", () => {
    const document = parse(buildThreadScanDocument(3).text);

    expect(validate(schemaAst, document)).toEqual([]);
    const text = print(document);
    for (const index of [0, 1, 2]) {
      expect(text).toContain(`thread_${index}: node(id: $id_${index})`);
      expect(text).toContain(`since: $since_${index}`);
    }
    expect(text).not.toContain("thread_3");
  });

  it("repeats the fragment its type is generated from", () => {
    const built = fragment(
      parse(buildThreadScanDocument(1).text),
      "BackfillComment",
    );
    const generated = fragment(
      parse(AuthoredBackfillDocument.text),
      "BackfillComment",
    );

    expect(generated).toBeDefined();
    expect(built && print(built)).toBe(generated && print(generated));
  });
});
