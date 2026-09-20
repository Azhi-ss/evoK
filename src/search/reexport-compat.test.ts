/**
 * ET-A2 compatibility seam: `src/search/` implementations and the flat
 * `src/*.ts` re-exports must stay isomorphic. Default selection literals
 * here are independent of the moved module bodies.
 */
import { describe, expect, test } from "bun:test";
import * as fixturesPacked from "./fixtures/second-toy-adapter";
import * as outerFlat from "../outer-search-space-fixtures";
import * as outerPacked from "./outer-search-space-fixtures";
import * as searchPacked from "./index";
import * as selectionFlat from "../search-selection-port";
import * as selectionPacked from "./search-selection-port";
import * as spaceFlat from "../search-space-profile";
import * as spacePacked from "./search-space-profile";
import * as toyFlat from "../toy-harness";
import * as toyPacked from "./fixtures/toy-harness";

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(flat: object, packed: object): void {
  expect(runtimeKeys(flat)).toEqual(runtimeKeys(packed));
  for (const key of runtimeKeys(flat)) {
    expect((packed as Record<string, unknown>)[key]).toBe((flat as Record<string, unknown>)[key]);
  }
}

describe("search pack re-export isomorphism", () => {
  test("flat src/*.ts re-exports the same runtime bindings as src/search/", () => {
    expectSameRuntimeSurface(selectionFlat, selectionPacked);
    expectSameRuntimeSurface(spaceFlat, spacePacked);
    expectSameRuntimeSurface(outerFlat, outerPacked);
    expectSameRuntimeSurface(toyFlat, toyPacked);
    expect(typeof fixturesPacked.BinaryAccuracyToyCompetitionAdapter).toBe("function");
  });

  test("src/search/ is importable and keeps default fixed_uct / #40 off", () => {
    expect(searchPacked.DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(searchPacked.SELECTION_POLICY_40).toBe("off");
    expect(searchPacked.PROGRESSIVE_MCGS_OPT_IN_ID).toBe("progressive_mcgs_optin");
    expect(searchPacked.STRONG_SEARCH_OPT_IN_ID).toBe("strong_search");
    expect(searchPacked.SEARCH_SPACE_BINDING).toBe("diagnostic_only");
    expect(searchPacked.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
    expect(searchPacked.createSearchSelectionPort().id).toBe("fixed_uct");
    expect(typeof searchPacked.createSeaHost).toBe("function");
    expect(typeof searchPacked.createMethodVersionStats).toBe("function");
    expect(searchPacked.createSeaHost().defaultSelection().id).toBe("fixed_uct");
    expect(searchPacked.createSeaHost().mounted()).toBeUndefined();
    expect(searchPacked.createDefaultSearchSelectionPort()).toBeInstanceOf(searchPacked.FixedUctSelectionAdapter);
    expect(searchPacked.createDefaultSearchSelectionPort()).not.toBeInstanceOf(searchPacked.ProgressiveMcgsOptInAdapter);

    const previous = process.env.EVOK_SEARCH_SELECTION;
    process.env.EVOK_SEARCH_SELECTION = "progressive_mcgs_optin";
    try {
      expect(searchPacked.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
      expect(searchPacked.createSearchSelectionPort().id).toBe("fixed_uct");
    } finally {
      if (previous === undefined) delete process.env.EVOK_SEARCH_SELECTION;
      else process.env.EVOK_SEARCH_SELECTION = previous;
    }

    expect(selectionFlat.DEFAULT_SEARCH_SELECTION_ID).toBe(searchPacked.DEFAULT_SEARCH_SELECTION_ID);
    expect(selectionFlat.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
  });
});
