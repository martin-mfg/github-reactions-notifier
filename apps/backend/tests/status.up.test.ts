import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import up from "../api/status/up.ts";
import { app } from "../app.ts";

const fakeResponse = () => ({
  statusCode: 200,
  setHeader: vi.fn(),
  send: vi.fn(),
});

describe("/api/status/up", () => {
  it("responds with `true` by default", () => {
    const res = fakeResponse();

    void up({ query: {} }, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "application/json",
    );
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.send).toHaveBeenCalledWith(true);
  });

  it("responds with JSON for type=json", () => {
    const res = fakeResponse();

    void up({ query: { type: "JSON" } }, res);

    expect(res.send).toHaveBeenCalledWith({ up: true });
  });

  it("responds with a shields.io badge for type=shields", () => {
    const res = fakeResponse();

    void up({ query: { type: "shields" } }, res);

    expect(res.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      label: "GitHub Reactions Notifier",
      message: "up",
      color: "brightgreen",
      isError: true,
    });
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

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ up: true });
  });

  it("responds 404 for unknown API paths", async () => {
    const res = await fetch(`${baseUrl}/api/unknown`);

    expect(res.status).toBe(404);
  });
});
