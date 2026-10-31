import { pool } from "@grn/core";
import { describe, expectTypeOf, it } from "vitest";

import type { Database } from "../src/db.ts";

describe("Database", () => {
  it("is satisfied by the pg pool from @grn/core", () => {
    expectTypeOf(pool).toExtend<Database | null>();
  });
});
