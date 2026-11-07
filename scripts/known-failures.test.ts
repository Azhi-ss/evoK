import { describe, expect, test } from "bun:test";
import { classifyFailures, failuresFrom } from "./known-failures";

describe("known-failure gate", () => {
  test("reads one name per failure line and normalizes the timing suffix", () => {
    const names = failuresFrom([
      "(pass) a test",
      "(fail) suite > case A [0.12ms]",
      "(fail) suite > case B",
      "  (fail) not a result line",
    ].join("\n"));
    expect([...names].sort()).toEqual(["suite > case A", "suite > case B"]);
  });

  test("a failure outside the accepted union is a gate failure", () => {
    const verdict = classifyFailures(new Set(["ok-1", "new-1"]), new Set(["ok-1"]));
    expect(verdict.added).toEqual(["new-1"]);
    expect(verdict.absent).toEqual([]);
  });

  test("a host that reproduces fewer accepted failures still passes", () => {
    const verdict = classifyFailures(new Set(["ok-1"]), new Set(["ok-1", "macOS-only"]));
    expect(verdict.added).toEqual([]);
    expect(verdict.absent).toEqual(["macOS-only"]);
  });
});
