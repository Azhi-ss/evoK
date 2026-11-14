/**
 * ET-A2 pack surface seam: `src/search/` is importable and keeps
 * default fixed_uct / #40 off.
 */
import { describe, expect, test } from "bun:test";
import * as searchPacked from "./index";
import * as selectionPacked from "./search-selection-port";

describe("search pack surface", () => {

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

    expect(selectionPacked.DEFAULT_SEARCH_SELECTION_ID).toBe(searchPacked.DEFAULT_SEARCH_SELECTION_ID);
    expect(selectionPacked.createDefaultSearchSelectionPort().id).toBe("fixed_uct");
  });
});
