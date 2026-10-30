import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("pool", () => {
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
