import type { AddressInfo } from "node:net";

import { logger } from "@grn/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { createUpHandler } from "../api/status/up.ts";
import { app } from "../app.ts";
import type { Database } from "../src/db.ts";

const fakeResponse = () => ({
  statusCode: 200,
  setHeader: vi.fn(),
  send: vi.fn(),
});

const fakeDb = (query: () => Promise<unknown>): Database =>
  ({ query, connect: vi.fn() }) as unknown as Database;

const upDb = fakeDb(() => Promise.resolve({ rows: [], rowCount: 1 }));
const downDb = fakeDb(() => Promise.reject(new Error("connection refused")));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

describe("/api/status/up", () => {
  it("responds with `true` by default while the database answers", async () => {
    const res = fakeResponse();

    await createUpHandler(() => upDb)({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.send).toHaveBeenCalledWith(true);
  });

  it("responds with JSON for type=json", async () => {
    const res = fakeResponse();

    await createUpHandler(() => upDb)({ query: { type: "JSON" } }, res);

    expect(res.send).toHaveBeenCalledWith({ up: true });
  });

  it("responds with a shields.io badge for type=shields", async () => {
    const res = fakeResponse();

    await createUpHandler(() => upDb)({ query: { type: "shields" } }, res);

    expect(res.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      label: "GitHub Reactions Notifier",
      message: "up",
      color: "brightgreen",
      isError: true,
    });
  });

  it("reports down with 503 when the database fails", async () => {
    const res = fakeResponse();

    await createUpHandler(() => downDb)({ query: {} }, res);

    expect(res.statusCode).toBe(503);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.send).toHaveBeenCalledWith(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "health check: database unreachable",
      expect.anything(),
    );
  });

  it("reports down in a badge with 200, which shields.io needs to render it", async () => {
    const res = fakeResponse();

    await createUpHandler(() => downDb)({ query: { type: "shields" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      label: "GitHub Reactions Notifier",
      message: "down",
      color: "red",
      isError: true,
    });
  });

  it("reports down with 503 when no database is configured", async () => {
    const res = fakeResponse();

    await createUpHandler(() => null)({ query: { type: "json" } }, res);

    expect(res.statusCode).toBe(503);
    expect(res.send).toHaveBeenCalledWith({ up: false });
  });

  it("reports down when the database doesn't answer within 5 s", async () => {
    vi.useFakeTimers();
    try {
      const res = fakeResponse();
      const hanging = fakeDb(() => new Promise(() => undefined));

      const handled = createUpHandler(() => hanging)({ query: {} }, res);
      await vi.advanceTimersByTimeAsync(5000);
      await handled;

      expect(res.statusCode).toBe(503);
      expect(res.send).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server", () => {
  let baseUrl: string;
  let close: () => void;

  beforeAll(async () => {
    const server = app.listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });

  afterAll(() => {
    close();
  });

  it("routes /api/status/up to its handler", async () => {
    const res = await fetch(`${baseUrl}/api/status/up?type=json`);

    // no POSTGRES_URL in tests
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toStrictEqual({ up: false });
  });

  it("routes /api/cron to its handler, which refuses without CRON_SECRET", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    vi.stubEnv("CRON_SECRET", "");

    const res = await fetch(`${baseUrl}/api/cron`);
    vi.unstubAllEnvs();

    expect(res.status).toBe(500);
  });

  it("responds 404 for unknown API paths", async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);

    expect(res.status).toBe(404);
  });
});
