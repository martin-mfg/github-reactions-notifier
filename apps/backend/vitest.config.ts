import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    conditions: ["@grn/source"],
  },
  ssr: {
    resolve: {
      conditions: ["@grn/source"],
    },
  },
  test: {
    environment: "node",
    include: ["./tests/*.test.ts"],
    // Each file boots its own PGlite in beforeAll; under a full parallel run that can take
    // longer than the default 10 s.
    hookTimeout: 30_000,
  },
});
