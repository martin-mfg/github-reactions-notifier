import nock from "nock";
import { afterEach, vi } from "vitest";

process.env["PAT_1"] = "dummyPAT1";
process.env["PAT_2"] = "dummyPAT2";

nock.disableNetConnect();

afterEach(() => {
  nock.cleanAll();
  vi.unstubAllEnvs();
});
