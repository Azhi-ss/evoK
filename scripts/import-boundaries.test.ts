/**
 * The import-boundary gate is only useful if it is TRUE (green on the real
 * tree) and SHARP (red on a reversed edge). Both are asserted here, so the
 * check wired into `bun run check` cannot become decorative.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  BOUNDARY_RULES,
  RESEARCH_OBJECTS,
  collectSources,
  findViolations,
  resolveSpecifier,
  specifiersOf,
} from "./import-boundaries";

const ROOT = join(import.meta.dir, "..");

describe("import boundaries (PRD §5, S1)", () => {
  test("the real tree satisfies every rule", async () => {
    const violations = findViolations(await collectSources(ROOT));
    expect(violations).toEqual([]);
  });

  test("memory importing Mission history is a violation", () => {
    expect(findViolations([{ path: "src/memory/store.ts", text: 'import { withEvent } from "../mission/mission-start";' }]))
      .toEqual([{ path: "src/memory/store.ts", specifier: "../mission/mission-start", resolved: "src/mission/mission-start", rule: "memory-no-mission-write-path" }]);
    // A directory import is the same forbidden edge, not a way around it.
    expect(findViolations([{ path: "src/memory/store.ts", text: 'import { x } from "../mission";' }])[0]?.resolved)
      .toBe("src/mission");
  });

  test("harness importing mission or an evaluator is a violation", () => {
    const mission = findViolations([{ path: "src/harness/execution.ts", text: 'import { runMissionController } from "../mission/mission-start";' }]);
    expect(mission.map((violation) => violation.rule)).toEqual(["harness-never-imports-mission"]);
    const evaluator = findViolations([{ path: "src/harness/execution.ts", text: 'const m = await import("../mission/memory-evaluation");' }]);
    expect(evaluator.map((violation) => violation.rule)).toEqual(["harness-never-imports-mission"]);
  });

  test("the flat re-export shims and the mission barrel are not a way round the rules", () => {
    // `src/mission-start.ts` re-exports `src/mission/mission-start.ts`, so the
    // flat shim is the same edge the rule forbids.
    const shim = { path: "src/mission-start.ts", text: 'export * from "./mission/mission-start";' };
    expect(findViolations([
      shim,
      { path: "src/memory/store.ts", text: 'import { withEvent } from "../mission-start";' },
    ])[0]).toMatchObject({ rule: "memory-no-mission-write-path", resolved: "src/mission/mission-start.ts" });
    expect(findViolations([
      shim,
      { path: "src/harness/snapshot.ts", text: 'import { x } from "../mission-start";' },
    ])[0]?.rule).toBe("harness-never-imports-mission");
    // A file that is NOT a pure re-export is not a shim, so it proves nothing.
    expect(findViolations([
      { path: "src/not-a-shim.ts", text: 'export const x = 1;' },
      { path: "src/memory/store.ts", text: 'import { x } from "../not-a-shim";' },
    ])).toEqual([]);
    // The barrel re-exports the charter: naming `src/mission` is the same edge.
    expect(findViolations([{ path: "src/evidence/adapter.ts", text: 'import { charterDigest } from "../mission";' }])[0]?.rule)
      .toBe("capability-never-imports-research-object");
  });

  test("a capability importing a research object is a violation, including via re-export", () => {
    for (const object of RESEARCH_OBJECTS) {
      const specifier = `../mission/${object.split("/").pop()!.replace(/\.ts$/, "")}`;
      const violations = findViolations([{ path: "src/evidence/adapter.ts", text: `export { x } from "${specifier}";` }]);
      expect(violations.map((violation) => violation.rule)).toEqual(["capability-never-imports-research-object"]);
      expect(violations[0]?.resolved).toBe(object.replace(/\.ts$/, ""));
    }
    // A capability's own module is not a research object; mission itself is exempt.
    expect(findViolations([{ path: "src/mission/index.ts", text: 'import { validateResearchCharter } from "./research-charter";' }])).toEqual([]);
  });

  test("specifier scanning covers imports, side-effect imports and dynamic imports", () => {
    expect(specifiersOf('import "a";\nimport { x } from "b";\nexport * from "c";\nconst d = await import("d");\n'))
      .toEqual(["b", "c", "a", "d"]);
    expect(resolveSpecifier("src/memory/store.ts", "./schema")).toBe("src/memory/schema");
    expect(resolveSpecifier("src/memory/store.ts", "../mission/mission-start.ts")).toBe("src/mission/mission-start.ts");
    expect(resolveSpecifier("src/memory/store.ts", "../mission/mission-start")).toBe("src/mission/mission-start");
    expect(resolveSpecifier("src/memory/store.ts", "@earendil-works/pi-coding-agent")).toBeUndefined();
  });

  test("the real tree's harness directory is covered, not merely named", async () => {
    const harness = (await collectSources(ROOT))
      .map((file) => file.path)
      .filter((path) => path.startsWith("src/harness/"));
    // Stage 3 (#256): the directory exists, so rule 1 now constrains real files.
    expect(harness.length).toBeGreaterThan(0);
    for (const path of harness)
      expect(findViolations([{ path, text: 'import { runMissionController } from "../mission/mission-start";' }])[0]?.rule).toBe(
        "harness-never-imports-mission",
      );
  });

  test("the rules name the PRD's three hard rules", () => {
    expect(BOUNDARY_RULES.map((rule) => rule.id).sort()).toEqual([
      "capability-never-imports-research-object",
      "harness-never-imports-mission",
      "memory-no-mission-write-path",
    ]);
  });
});
