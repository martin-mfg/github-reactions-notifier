/**
 * @file Public health endpoint (FR-18), mirroring github-stats-extended's `/api/status/up`.
 * It reports whether the service responds and reaches its database.
 */

import { logger, pool } from "@grn/core";

import type { Database } from "../../src/db.ts";
import type { ApiHandler } from "../_types.ts";

/** A database check that hasn't answered within this long counts as down. */
const DB_CHECK_TIMEOUT_MS = 5000;

interface ShieldsResponse {
  schemaVersion: number;
  label: string;
  message: "up" | "down";
  color: "brightgreen" | "red";
  isError: boolean;
}

/**
 * Creates a JSON response that shields.io can render as a dynamic badge.
 *
 * @param up Whether the service is up.
 * @returns Dynamic shields.io JSON response object.
 *
 * @see https://shields.io/endpoint
 */
const shieldsUptimeBadge = (up: boolean): ShieldsResponse => ({
  schemaVersion: 1,
  label: "GitHub Reactions Notifier",
  message: up ? "up" : "down",
  color: up ? "brightgreen" : "red",
  isError: true,
});

/**
 * @param db The pool, or `null` if none is configured.
 * @returns Whether the database answers a trivial query in time.
 */
const isDatabaseUp = async (db: Database | null): Promise<boolean> => {
  if (!db) {
    return false;
  }
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(resolve, DB_CHECK_TIMEOUT_MS, false);
  });
  try {
    return await Promise.race([
      db.query("SELECT 1").then(() => true),
      timedOut,
    ]);
  } catch (error) {
    logger.warn("health check: database unreachable", { error });
    return false;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * @param db The pool; replaced in tests.
 * @returns The health endpoint. While GRN is down it answers `503`, so monitors see it from
 *   the status alone, except for `type=shields`: shields.io renders only a `200`'s badge.
 */
export const createUpHandler =
  (db: () => Database | null): ApiHandler =>
  async (req, res) => {
    const { type } = req.query;
    const format = typeof type === "string" ? type.toLowerCase() : "boolean";
    const up = await isDatabaseUp(db());

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = up || format === "shields" ? 200 : 503;

    switch (format) {
      case "shields":
        res.send(shieldsUptimeBadge(up));
        break;
      case "json":
        res.send({ up });
        break;
      default:
        res.send(up);
        break;
    }
  };

export default createUpHandler(() => pool);
