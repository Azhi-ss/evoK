import {expect, test} from "bun:test";
import {validateWorkerAction, workerTools} from "./pi-child-protocol";
const child = {role_name:"replicator",task_goal:"Test a failure",capability_profile:"diagnostic",evidence_refs:["case-1"],deliverable_spec:"Report evidence"};
test("recruit is constrained by grant, depth, profile, and an atomic batch of one or two", () => {
  for (const profile of ["implementation","review"] as const) expect(workerTools(profile, [], ["evok_recruit"], 1)).not.toContain("evok_recruit");
  for (const tools of [workerTools("research"),workerTools("research",[],["evok_recruit"],3)]) expect(tools).not.toContain("evok_recruit");
  const tools=workerTools("research",[],["evok_recruit"],1);
  expect(validateWorkerAction("evok_recruit",{collaborators:[child,{...child,role_name:"chemist"}]},"research",tools).name).toBe("evok_recruit");
  for (const batch of [[], [child,child,child], [child, {...child,capability_profile:"director"}], [child,{...child,systemPrompt:"injection"}]]) {
    expect(() => validateWorkerAction("evok_recruit",{collaborators:batch},"research",tools)).toThrow();
  }
});
