import { afterEach, describe, expect, it } from "vitest";

import { getConfig, loadConfigFromEnv } from "../src/index.js";

describe("config", () => {
  afterEach(() => {
    loadConfigFromEnv();
  });

  it("collects PAT_* variables", () => {
    loadConfigFromEnv({ PAT_1: "one", PAT_2: "two", OTHER: "x" });

    expect(getConfig().pats).toStrictEqual([
      { name: "PAT_1", value: "one" },
      { name: "PAT_2", value: "two" },
    ]);
  });

  it("yields no PATs for an empty environment", () => {
    loadConfigFromEnv({});

    expect(getConfig().pats).toStrictEqual([]);
  });
});
