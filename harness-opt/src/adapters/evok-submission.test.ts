import { describe, expect, test } from "bun:test";
import { consultEvokContestGates } from "./evok-submission";

describe("evoK contest gate consult", () => {
  test("missing promotion, hang, admission, and budget inputs fail closed", () => {
    const result = consultEvokContestGates();
    expect(result.ok).toBe(false);
    expect(result.refusedGateIds).toEqual(expect.arrayContaining(["promotion", "hang", "admission", "budget"]));
  });
});
