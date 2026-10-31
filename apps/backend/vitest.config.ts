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
  },
});
