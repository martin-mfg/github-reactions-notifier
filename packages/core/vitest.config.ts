import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    conditions: ["@grn/source"],
  },
  test: {
    name: "core",
    environment: "node",
    include: ["./tests/**/*.test.ts"],
    setupFiles: ["./tests/_setup.ts"],
  },
});
