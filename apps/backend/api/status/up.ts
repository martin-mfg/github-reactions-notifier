/**
 * @file Public health endpoint (FR-18), mirroring github-stats-extended's `/api/status/up`.
 * It reports whether the service responds.
 */

import type { ApiHandler } from "../_types.ts";

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

const up: ApiHandler = (req, res) => {
  const { type } = req.query;
  const format = typeof type === "string" ? type.toLowerCase() : "boolean";

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  switch (format) {
    case "shields":
      res.send(shieldsUptimeBadge(true));
      break;
    case "json":
      res.send({ up: true });
      break;
    default:
      res.send(true);
      break;
  }
};

export default up;
