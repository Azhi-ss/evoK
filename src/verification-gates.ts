export type VerificationRole =
  | "SelfVerifier"
  | "Falsifier"
  | "Critic"
  | "Challenger"
  | "Auditor"
  | "SuccessAuditor"
  | "KillTester";

export type VerificationTrigger =
  | "before-expensive-execution"
  | "after-snapshot"
  | "after-evaluation"
  | "before-promotion";

export type VerificationInputKind = "task-contract" | "candidate-snapshot" | "evidence" | "success-claim";

export interface VerificationRoleContract {
  readonly role: VerificationRole;
  readonly trigger: VerificationTrigger;
  readonly input: VerificationInputKind;
  readonly purpose: string;
  readonly capabilities: readonly ("read-snapshot" | "run-tests" | "read-evidence")[];
  /** Team verification may block or quarantine, but it never scores or promotes. */
  readonly authoritative: false;
}

const contract = (
  role: VerificationRole,
  trigger: VerificationTrigger,
  input: VerificationInputKind,
  purpose: string,
  capabilities: VerificationRoleContract["capabilities"],
): VerificationRoleContract => Object.freeze({ role, trigger, input, purpose, capabilities: Object.freeze([...capabilities]), authoritative: false });

export const VERIFICATION_ROLE_CONTRACTS: Readonly<Record<VerificationRole, VerificationRoleContract>> = Object.freeze({
  SelfVerifier: contract("SelfVerifier", "before-expensive-execution", "task-contract", "check contract coverage and execution readiness", ["read-snapshot"]),
  Falsifier: contract("Falsifier", "after-snapshot", "candidate-snapshot", "find a concrete counterexample or rule violation", ["read-snapshot", "run-tests"]),
  Critic: contract("Critic", "after-snapshot", "candidate-snapshot", "find structural, logical, or implementation defects", ["read-snapshot", "run-tests"]),
  Challenger: contract("Challenger", "after-snapshot", "candidate-snapshot", "probe boundaries, worst cases, and adversarial inputs", ["read-snapshot", "run-tests"]),
  Auditor: contract("Auditor", "after-evaluation", "evidence", "check evidence, rules, provenance, and claimed commands", ["read-snapshot", "read-evidence"]),
  SuccessAuditor: contract("SuccessAuditor", "before-promotion", "success-claim", "check every part of the success claim against evidence", ["read-snapshot", "read-evidence"]),
  KillTester: contract("KillTester", "before-promotion", "success-claim", "overlay the kill-test hang on the success claim; fail and inconclusive must not pass", ["read-snapshot", "read-evidence"]),
});

export const ROLE_CONTRACTS = VERIFICATION_ROLE_CONTRACTS;

export function verificationRoleContract(role: VerificationRole): VerificationRoleContract {
  const value = VERIFICATION_ROLE_CONTRACTS[role];
  if (!value) throw new RangeError(`unknown verification role: ${String(role)}`);
  return value;
}

export interface VerificationResult {
  readonly ok: boolean;
  readonly objections: readonly string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeVerificationResult(value: unknown, role: VerificationRole): VerificationResult {
  if (!record(value) || typeof value.ok !== "boolean") {
    return Object.freeze({ ok: false, objections: Object.freeze([`${role} output must contain a boolean ok`]) });
  }
  if (value.objections !== undefined && (!Array.isArray(value.objections) || value.objections.some((entry) => typeof entry !== "string"))) {
    return Object.freeze({ ok: false, objections: Object.freeze([`${role} objections must be an array of strings`]) });
  }
  const objections = Object.freeze([...(value.objections as string[] | undefined ?? [])]);
  return Object.freeze({ ok: value.ok, objections: value.ok || objections.length > 0 ? objections : Object.freeze([`${role} rejected the candidate`]) });
}

export interface VerificationContext {
  readonly role: VerificationRole;
  readonly contract: VerificationRoleContract;
  readonly missionId: string;
  readonly branchId: string;
  readonly taskContract: Readonly<Record<string, unknown>>;
  readonly snapshot?: Readonly<Record<string, unknown>>;
  readonly evaluation?: Readonly<Record<string, unknown>>;
  /** Optional agent-readable feedback view; never trusted scoring evidence. */
  readonly feedbackView?: Readonly<Record<string, unknown>>;
}

export type VerificationHook = (input: VerificationContext) => VerificationResult | Promise<VerificationResult>;

export interface VerificationHooks {
  readonly selfVerifier?: VerificationHook;
  readonly falsifier?: VerificationHook;
  readonly critic?: VerificationHook;
  readonly challenger?: VerificationHook;
  readonly auditor?: VerificationHook;
  readonly successAuditor?: VerificationHook;
  /** Stacked after SuccessAuditor on the same before-promotion trigger. Does not replace it. */
  readonly killTestHang?: VerificationHook;
}
