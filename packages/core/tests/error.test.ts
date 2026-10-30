import { describe, expect, it } from "vitest";

import { CustomError, MissingParamError, describeError } from "../src/index.js";

describe("describeError", () => {
  it("returns the message only for errors without a type", () => {
    expect(describeError(new Error("boom"))).toStrictEqual({
      message: "boom",
    });

    expect(describeError(new MissingParamError(["code"]))).toStrictEqual({
      message: 'Missing params "code" make sure you pass the parameters in URL',
    });
  });

  it("returns the type and messages for custom errors", () => {
    expect(
      describeError(
        new CustomError(
          "Downtime due to GitHub API rate limiting",
          CustomError.MAX_RETRY,
        ),
      ),
    ).toStrictEqual({
      type: CustomError.MAX_RETRY,
      message: "Downtime due to GitHub API rate limiting",
      secondaryMessage:
        "You can deploy own instance or wait until public will be no longer limited",
    });
  });

  it("falls back to the type as secondary message for unknown types", () => {
    expect(describeError(new CustomError("boom", "SOMETHING"))).toStrictEqual({
      type: "SOMETHING",
      message: "boom",
      secondaryMessage: "SOMETHING",
    });
  });

  it("returns a secondary message when available", () => {
    expect(
      describeError(new MissingParamError(["code"], "Sign in again")),
    ).toStrictEqual({
      message: 'Missing params "code" make sure you pass the parameters in URL',
      secondaryMessage: "Sign in again",
    });
  });
});
