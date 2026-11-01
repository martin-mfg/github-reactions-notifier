import { afterEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@grn/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@grn/core")>()),
  createGraphQLFetcher: () => request,
}));

import { fetchViewer } from "../src/oauth.ts";

afterEach(() => {
  vi.restoreAllMocks();
  request.mockReset();
});

it("aborts a stalled OAuth viewer request at the two-minute bound", async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const abort = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => timeout(20));
  request.mockImplementation(
    (_variables, _token, _retries, { signal }: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("viewer request aborted"));
          },
          { once: true },
        );
      }),
  );

  await expect(fetchViewer("gho_token")).rejects.toThrow();
  expect(abort).toHaveBeenCalledWith(120_000);
  expect(request).toHaveBeenCalledOnce();
});
