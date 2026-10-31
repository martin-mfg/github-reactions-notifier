import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

// A fresh import of the whole package can take longer than the default 5 s under a full
// parallel run.
describe("pool", { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("is null without POSTGRES_URL", async () => {
    vi.stubEnv("POSTGRES_URL", "");

    const { pool } = await import("../src/index.js");

    expect(pool).toBeNull();
  });

  it("is created lazily from POSTGRES_URL", async () => {
    vi.stubEnv("POSTGRES_URL", "postgres://localhost:5432/grn");

    const { pool } = await import("../src/index.js");

    // `new Pool` doesn't connect until the first query.
    expect(pool).toBeInstanceOf(Pool);
    await pool?.end();
  });
});
