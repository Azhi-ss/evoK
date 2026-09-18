/**
 * ET-M1-SEA / #146 — method-version stats isolation.
 *
 * Seam: MethodVersionStats switchTo / record / authority / history / adoptAsAuthority.
 * After a method version switch, old-version visit/value stats stay historical
 * and must not become the new version's search authority.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SEARCH_SELECTION_ID,
  SELECTION_POLICY_40,
  createDefaultSearchSelectionPort,
} from "./search-selection-port";
import {
  createMethodVersionStats,
  type MethodVersionNodeStat,
} from "./method-version-stats";

const PROMOTION_KEY_FIELDS = [
  "mmd", "sideSlot", "side_slot", "sideSlotScore", "mmdScore", "score",
  "nearDup", "near_dup", "nearDupScore", "nearDuplicate", "diversity", "diversityScore",
  "eliteScore",
] as const;

describe("method-version switch isolates search stats", () => {
  test("old-version visits are history, not the new version's authority", () => {
    const stats = createMethodVersionStats();
    stats.switchTo("method@1");
    stats.record({ nodeId: "champ", visits: 10, value: 0.9 });

    const v1 = stats.authority();
    expect(v1).toHaveLength(1);
    expect(v1[0]).toMatchObject({
      nodeId: "champ",
      visits: 10,
      value: 0.9,
      methodVersion: "method@1",
    });

    const switched = stats.switchTo("method@2");
    expect(switched.from).toBe("method@1");
    expect(switched.to).toBe("method@2");
    expect(stats.activeVersion()).toBe("method@2");
    expect(stats.authority()).toEqual([]);
    expect(stats.history("method@1")).toEqual(v1 as MethodVersionNodeStat[]);

    stats.record({ nodeId: "challenger", visits: 1, value: 0.2 });
    const v2 = stats.authority();
    expect(v2).toHaveLength(1);
    expect(v2[0]).toMatchObject({
      nodeId: "challenger",
      visits: 1,
      value: 0.2,
      methodVersion: "method@2",
    });
    expect(v2.map((row) => row.nodeId)).not.toContain("champ");
    expect(stats.history("method@1")[0]?.visits).toBe(10);
  });

  test("adoptAsAuthority refuses to promote old-version stats onto the new version", () => {
    const stats = createMethodVersionStats();
    stats.switchTo("method@1");
    stats.record({ nodeId: "champ", visits: 10, value: 0.9 });
    stats.switchTo("method@2");
    stats.record({ nodeId: "challenger", visits: 1, value: 0.2 });

    const refused = stats.adoptAsAuthority("method@1");
    expect(refused.ok).toBe(false);
    expect(refused.outcome).toBe("refuse");
    expect(refused.reason).toBe("version_mismatch");
    expect(refused.objections.join(" ")).toMatch(/not.*authority|version/i);
    expect(stats.authority().map((row) => row.nodeId)).toEqual(["challenger"]);
    expect(stats.authority()[0]?.visits).toBe(1);

    const same = stats.adoptAsAuthority("method@2");
    expect(same.ok).toBe(true);
    expect(same.outcome).toBe("pass");
    expect(stats.authority().map((row) => row.nodeId)).toEqual(["challenger"]);
  });

  test("default fixed_uct parent selection after a switch uses only the new version's authority", () => {
    const stats = createMethodVersionStats();
    stats.switchTo("method@1");
    stats.record({ nodeId: "a", visits: 10, value: 0.8, parentVisits: 20 });
    stats.record({ nodeId: "b", visits: 2, value: 0.5, parentVisits: 20 });
    stats.record({ nodeId: "c", visits: 8, value: 0.6, parentVisits: 20 });

    const v1Pick = createDefaultSearchSelectionPort().selectParent({
      nodes: stats.toParentCandidates(),
    });
    expect(v1Pick.parentId).toBe("b");
    expect(v1Pick.adapterId).toBe("fixed_uct");

    stats.switchTo("method@2");
    expect(stats.toParentCandidates()).toEqual([]);
    stats.record({ nodeId: "challenger", visits: 1, value: 0.2 });

    const v2Pick = createDefaultSearchSelectionPort().selectParent({
      nodes: stats.toParentCandidates(),
    });
    expect(v2Pick.parentId).toBe("challenger");
    expect(v2Pick.adapterId).toBe("fixed_uct");
    expect(DEFAULT_SEARCH_SELECTION_ID).toBe("fixed_uct");
    expect(SELECTION_POLICY_40).toBe("off");
  });

  test("recording another version's row into the active authority is refused", () => {
    const stats = createMethodVersionStats();
    stats.switchTo("method@2");
    expect(() => stats.record({
      nodeId: "champ",
      visits: 10,
      value: 0.9,
      methodVersion: "method@1",
    })).toThrow(/method@version|active version|authority/i);
    expect(stats.authority()).toEqual([]);
    expect(() => stats.record({ nodeId: "champ", visits: 10, value: 0.9 })).not.toThrow();
  });
});

describe("method-version stats are not promotion keys", () => {
  test("Elite / MMD / near-dup / side-slot fields are rejected on record and adopt", () => {
    const stats = createMethodVersionStats();
    stats.switchTo("method@1");
    expect(() => stats.record({
      nodeId: "champ",
      visits: 1,
      value: 0.2,
      eliteScore: 0.99,
      mmd: 0.1,
    } as { readonly nodeId: string; readonly visits: number; readonly value: number; readonly eliteScore: number; readonly mmd: number })).toThrow(
      /Elite|MMD|near-dup|side-slot|promotion/i,
    );
    stats.record({ nodeId: "champ", visits: 1, value: 0.2 });
    const authority = stats.authority()[0];
    const adopted = stats.adoptAsAuthority("method@1");
    for (const field of PROMOTION_KEY_FIELDS) {
      expect(authority).not.toHaveProperty(field);
      expect(adopted).not.toHaveProperty(field);
    }
    expect(stats.toParentCandidates()[0]).not.toHaveProperty("eliteScore");
    expect(stats.toParentCandidates()[0]?.nodeId).toBe("champ");
  });
});
