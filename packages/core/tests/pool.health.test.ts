import { afterEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  query: vi.fn<() => Promise<unknown>>(),
  end: vi.fn<() => Promise<void>>(),
  on: vi.fn(),
}));
const constructor = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  Client: vi.fn(function (options: unknown) {
    constructor(options);
    return client;
  }),
}));

import { checkDatabaseConnection } from "../src/common/pool.js";

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("database health probe", () => {
  it("bounds acquisition and server execution, then closes the dedicated connection", async () => {
    client.connect.mockResolvedValue();
    client.query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    client.end.mockResolvedValue();

    await checkDatabaseConnection("postgres://localhost/grn", 5000);

    expect(constructor).toHaveBeenCalledWith({
      connectionString: "postgres://localhost/grn",
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 5000,
    });
    expect(client.query).toHaveBeenCalledWith("SELECT 1");
    expect(client.end).toHaveBeenCalledOnce();
  });

  it.each(["connect", "query"] as const)(
    "closes a stuck %s at the total deadline",
    async (phase) => {
      vi.useFakeTimers();
      client.connect.mockResolvedValue();
      client.query.mockResolvedValue({});
      client.end.mockResolvedValue();
      client[phase].mockImplementation(() => new Promise(() => undefined));
      const probe = checkDatabaseConnection("postgres://localhost/grn", 5000);
      const rejected = expect(probe).rejects.toThrow("database timeout");

      await vi.advanceTimersByTimeAsync(5000);
      await rejected;

      expect(client.end).toHaveBeenCalledOnce();
      if (phase === "connect") {
        expect(client.query).not.toHaveBeenCalled();
      }
    },
  );

  it("closes the connection on a query error", async () => {
    client.connect.mockResolvedValue();
    client.query.mockRejectedValue(new Error("connection lost"));
    client.end.mockResolvedValue();

    await expect(
      checkDatabaseConnection("postgres://localhost/grn", 5000),
    ).rejects.toThrow("connection lost");
    expect(client.end).toHaveBeenCalledOnce();
  });
});
