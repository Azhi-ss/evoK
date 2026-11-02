import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";

export type WorkerProfile = "research" | "diagnostic" | "implementation" | "review";
const shortText = Type.String({ minLength: 1, maxLength: 4000 });
const refs = Type.Array(Type.String({minLength: 1, maxLength: 512}), {maxItems: 32, uniqueItems: true});
const tags = ["阶段发现就绪", "申请采纳改动", "建议切换研究方向", "复核通过", "复核驳回"] as const;
const deliver = Type.Object({
  decision_tag: Type.Union(tags.map(tag => Type.Literal(tag))), summary: shortText,
  evidence_refs: refs, modified_files: refs,
  changes: Type.Optional(Type.Array(Type.Object({path: Type.String({minLength:1,maxLength:512}), content: Type.String({maxLength:524288})}, {additionalProperties:false}), {minItems:1, maxItems:6})),
}, {additionalProperties: false});
export type WorkerAction = {name: "evok_deliver"; args: Static<typeof deliver>};
export const controlSchemas: Record<string, TSchema> = {evok_deliver: deliver};
export const hostToolSchemas: Record<string, TSchema> = {
  evok_read_evidence: Type.Object({ref: Type.String({minLength: 1})}, {additionalProperties: false}),
  evok_read_file: Type.Object({path: Type.String({minLength: 1})}, {additionalProperties: false}),
  evok_write_file: Type.Object({path: Type.String({minLength: 1}), content: Type.String()}, {additionalProperties: false}),
  evok_check: Type.Object({check: Type.String({minLength: 1})}, {additionalProperties: false}),
  evok_experiment: Type.Object({experiment: shortText}, {additionalProperties: false}),
};
const capabilities: Record<WorkerProfile, readonly string[]> = {
  research: ["evok_read_evidence", "evok_read_file", "evok_experiment"],
  diagnostic: ["evok_read_evidence", "evok_read_file"],
  implementation: ["evok_read_evidence", "evok_read_file", "evok_write_file", "evok_check"],
  review: ["evok_read_evidence", "evok_read_file", "evok_check"],
};
export function workerTools(profile: WorkerProfile, exposed: readonly string[] = []): string[] {
  return ["evok_deliver", ...capabilities[profile].filter(name => exposed.includes(name))];
}
export function validateWorkerAction(name: string, args: unknown, profile: WorkerProfile): WorkerAction {
  if (!workerTools(profile).includes(name) || !Object.hasOwn(controlSchemas, name) || !Check(controlSchemas[name], args)) {
    throw Error("invalid EvoK control action");
  }
  const action = {name, args} as WorkerAction;
  if ((action.args.decision_tag === "复核通过" || action.args.decision_tag === "复核驳回") !== (profile === "review")) {
    throw Error("decision tag does not match role authority");
  }
  if (action.args.changes && profile !== "research") throw Error("only the Researcher may attach a candidate patch");
  if (action.args.changes) {
    const paths = action.args.changes.map(change => change.path);
    if (new Set(paths).size !== paths.length || paths.length !== action.args.modified_files.length ||
        !paths.every(path => action.args.modified_files.includes(path))) throw Error("patch must match modified_files");
  }
  return action;
}
