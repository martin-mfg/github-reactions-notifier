/**
 * @file Public health endpoint (FR-18), mirroring github-stats-extended's `/api/status/up`.
 * It reports whether the service responds and reaches its database.
 */

import { checkDatabaseConnection, logger } from "@grn/core";

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
 * @param check A bounded probe, or `null` if no database is configured.
 * @returns Whether the database answers a trivial query in time.
 */
const isDatabaseUp = async (
  check: () => Promise<void> | null,
): Promise<boolean> => {
  try {
    const probe = check();
    if (probe === null) {
      return false;
    }
    await probe;
    return true;
  } catch (error) {
    logger.warn("health check: database unreachable", { error });
    return false;
  }
};

/**
 * @param check A bounded database probe; replaced in tests.
 * @returns The health endpoint. While GRN is down it answers `503`, so monitors see it from
 *   the status alone, except for `type=shields`: shields.io renders only a `200`'s badge.
 */
export const createUpHandler =
  (check: () => Promise<void> | null): ApiHandler =>
  async (req, res) => {
    const { type } = req.query;
    const format = typeof type === "string" ? type.toLowerCase() : "boolean";
    const up = await isDatabaseUp(check);

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

export default createUpHandler(() => {
  const connectionString = process.env["POSTGRES_URL"];
  return connectionString
    ? checkDatabaseConnection(connectionString, DB_CHECK_TIMEOUT_MS)
    : null;
});
