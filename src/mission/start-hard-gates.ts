/**
 * Start-path hard-gate inventory (ET-OPS-START / #168).
 *
 * Lists remaining start prerequisites and the gates that stay in force.
 * Does not dispatch a Mission, does not authorize External Submission, and
 * does not relax Admission / Budget / hang / T48 / Broker predicates.
 */
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  EvaluationContractError,
  evaluationContractPath,
  loadEvaluationContract,
} from "../local-file-evaluator";
import {
  draftReadyForReview,
} from "./mission-intake";
import {
  isMissionId,
  loadMissionDraft,
  missionsDir,
  type MissionDraft,
} from "./mission-draft";
import {
  ENFORCEABLE_BUDGET_UNITS,
  isExplicitStartRequest,
  loadMissionRecord,
  MissionRecordCorruptionError,
  MissionStartRejectedError,
  type StartAuthorization,
} from "./mission-start";

export const EVALUATION_TEMPLATE_RELATIVE_PATH = "templates/evaluation.json";
export const DEMO_START_RELATIVE_PATH = "examples/demo-start";

/** Permissions the baseline start path actually grants (same set as mission-start). */
const SUPPORTED_PERMISSIONS = new Set([
  "read-project",
  "isolated-workspace-write",
  "local-shell-in-workspace",
]);

/** Declared permissions that can never be granted by start (later authority). */
const FORBIDDEN_PERMISSION = /submi|external|network|internet|credential|deploy|publish/i;

export type StartHardGateId =
  | "project-absolute"
  | "evaluation-contract"
  | "reviewed-draft"
  | "explicit-authorization"
  | "enforceable-budget"
  | "supported-permissions"
  | "model-auth"
  | "controller-lock"
  | "already-started"
  | "admission"
  | "budget-gate"
  | "hang"
  | "t48"
  | "external-submission";

export type StartHardGateStatus = "pass" | "block" | "in-force";

export interface StartHardGate {
  readonly id: StartHardGateId;
  readonly status: StartHardGateStatus;
  readonly title: string;
  readonly detail: string;
}

export interface StartHardGateReport {
  readonly projectRoot: string;
  readonly missionId?: string;
  /** True only when every start-path blocking gate is clear. In-force gates never count as a pass. */
  readonly ready: boolean;
  readonly blocking: readonly StartHardGate[];
  readonly passed: readonly StartHardGate[];
  readonly inForce: readonly StartHardGate[];
}

export interface InspectStartHardGatesOptions {
  readonly projectRoot: string;
  readonly missionId?: string;
  readonly authorization?: StartAuthorization;
  readonly budgetUnits?: string;
  readonly modelProbe?: () => Promise<{ ok: true } | { ok: false; error: string }>;
}

function gate(
  id: StartHardGateId,
  status: StartHardGateStatus,
  title: string,
  detail: string,
): StartHardGate {
  return { id, status, title, detail };
}

function inForceGates(): readonly StartHardGate[] {
  return [
    gate(
      "admission",
      "in-force",
      "Admission",
      "Method/Skill writeback still requires official samples + an adversarial-labeled subset + a protected holdout. Missing holdout refuses. Elite or Team Fan-Out is not an Admission key. Not a pass.",
    ),
    gate(
      "budget-gate",
      "in-force",
      "Budget Gate",
      "reserve → settle still refuses continue or writeback when spend is unreserved or over the Mission Policy cap. Budget pass is not Admission pass. Not downgraded.",
    ),
    gate(
      "hang",
      "in-force",
      "hang",
      "Inconclusive hang is not pass. Hang predicates are unchanged.",
    ),
    gate(
      "t48",
      "in-force",
      "T48",
      "Unmapped T48 artifacts still block. T48 predicates are unchanged.",
    ),
    gate(
      "external-submission",
      "in-force",
      "External Submission / Broker",
      "True submit stays frozen. Start is not External Submission authorization. Broker predicates are unchanged.",
    ),
  ];
}

async function listMissionIds(projectRoot: string): Promise<readonly string[]> {
  const entries = await readdir(missionsDir(projectRoot), { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory() && isMissionId(entry.name)).map((entry) => entry.name);
}

async function inspectDraft(
  projectRoot: string,
  requestedId: string | undefined,
): Promise<{ missionId?: string; draft?: MissionDraft; draftGate: StartHardGate }> {
  let ids: readonly string[];
  try {
    ids = requestedId ? [requestedId] : await listMissionIds(projectRoot);
  } catch (error) {
    return {
      draftGate: gate(
        "reviewed-draft",
        "block",
        "reviewed Mission draft",
        `cannot read Mission storage: ${(error as Error).message}`,
      ),
    };
  }
  if (ids.length === 0) {
    return {
      draftGate: gate(
        "reviewed-draft",
        "block",
        "reviewed Mission draft",
        `no reviewed Mission draft under ${join(projectRoot, ".evok", "missions")}; run --intake before /start`,
      ),
    };
  }
  if (!requestedId && ids.length > 1) {
    return {
      draftGate: gate(
        "reviewed-draft",
        "block",
        "reviewed Mission draft",
        `multiple saved Missions (${ids.join(", ")}); name one with --mission <id>`,
      ),
    };
  }
  const missionId = requestedId ?? ids[0]!;
  try {
    const draft = await loadMissionDraft(projectRoot, missionId);
    if (!draftReadyForReview(draft)) {
      const missing: string[] = [];
      if (draft.objective.trim() === "") missing.push("objective");
      if (draft.successCriteria.length === 0) missing.push("success criteria");
      if (draft.data.description.trim() === "") missing.push("data description");
      if (draft.evaluation.method.trim() === "") missing.push("evaluation method");
      if (draft.budget.total <= 0) missing.push("a positive enforceable budget");
      if (draft.outputs.length === 0) missing.push("declared outputs");
      if (draft.stopConditions.length === 0) missing.push("stop conditions");
      if (draft.plan.tasks.length === 0) missing.push("the initial baseline task");
      const extra = draft.unresolvedPrerequisites.length > 0
        ? ` unresolved prerequisites: ${draft.unresolvedPrerequisites.join("; ")}`
        : "";
      return {
        missionId,
        draft,
        draftGate: gate(
          "reviewed-draft",
          "block",
          "reviewed Mission draft",
          `mission ${missionId} is not ready to start (missing: ${missing.join(", ") || "review requirements"})${extra}`,
        ),
      };
    }
    return {
      missionId,
      draft,
      draftGate: gate(
        "reviewed-draft",
        "pass",
        "reviewed Mission draft",
        `reviewable draft ${missionId} at ${join(projectRoot, ".evok", "missions", missionId, "draft.json")}`,
      ),
    };
  } catch (error) {
    return {
      missionId,
      draftGate: gate(
        "reviewed-draft",
        "block",
        "reviewed Mission draft",
        (error as Error).message,
      ),
    };
  }
}

function inspectAuthorization(auth: StartAuthorization | undefined): StartHardGate {
  if (!auth?.requested || !isExplicitStartRequest(auth.token)) {
    return gate(
      "explicit-authorization",
      "block",
      "explicit start authorization",
      "start intent is ambiguous or absent; discussing a Mission does not dispatch work",
    );
  }
  if (auth.source === "model") {
    return gate(
      "explicit-authorization",
      "block",
      "explicit start authorization",
      "start authorization must come from the user; a model-authored approval cannot dispatch a Mission",
    );
  }
  return gate(
    "explicit-authorization",
    "pass",
    "explicit start authorization",
    `user token ${JSON.stringify(auth.token)}`,
  );
}

function inspectBudget(draft: MissionDraft | undefined, units: string): StartHardGate {
  if (!draft) {
    return gate(
      "enforceable-budget",
      "block",
      "enforceable model-USD budget",
      "no reviewed draft to read a budget from",
    );
  }
  if (draft.budget.units !== units) {
    return gate(
      "enforceable-budget",
      "block",
      "enforceable model-USD budget",
      `declared budget unit "${draft.budget.units}" is not enforceable on this path (only "${units}" is metered)`,
    );
  }
  if (draft.budget.total <= 0) {
    return gate(
      "enforceable-budget",
      "block",
      "enforceable model-USD budget",
      "declared budget total must be a positive enforceable amount",
    );
  }
  return gate(
    "enforceable-budget",
    "pass",
    "enforceable model-USD budget",
    `${draft.budget.total} ${draft.budget.units} declared (spend still meters real provider usage)`,
  );
}

function inspectPermissions(draft: MissionDraft | undefined): StartHardGate {
  if (!draft) {
    return gate(
      "supported-permissions",
      "block",
      "supported permissions",
      "no reviewed draft to read permissions from",
    );
  }
  const permissions = draft.constraints.permissions ?? [];
  for (const permission of permissions) {
    if (FORBIDDEN_PERMISSION.test(permission)) {
      return gate(
        "supported-permissions",
        "block",
        "supported permissions",
        `declared permission "${permission}" cannot be granted at start (external/irreversible authority is never implicit)`,
      );
    }
    if (!SUPPORTED_PERMISSIONS.has(permission)) {
      return gate(
        "supported-permissions",
        "block",
        "supported permissions",
        `declared permission "${permission}" is not supported by the baseline path`,
      );
    }
  }
  return gate(
    "supported-permissions",
    "pass",
    "supported permissions",
    permissions.length === 0
      ? "no extra permissions declared"
      : `granted only: ${permissions.join(", ")}`,
  );
}

async function inspectAlreadyStarted(projectRoot: string, missionId: string | undefined): Promise<StartHardGate> {
  if (!missionId) {
    return gate(
      "already-started",
      "pass",
      "unstarted Mission",
      "no Mission id to check for a prior start record",
    );
  }
  try {
    const previous = await loadMissionRecord(projectRoot, missionId);
    return gate(
      "already-started",
      "block",
      "unstarted Mission",
      `mission ${missionId} was already started (status ${previous.status}); start is not idempotent`,
    );
  } catch (error) {
    if (error instanceof MissionStartRejectedError) {
      return gate("already-started", "pass", "unstarted Mission", `no accepted start record for ${missionId}`);
    }
    if (error instanceof MissionRecordCorruptionError) {
      return gate("already-started", "block", "unstarted Mission", error.message);
    }
    throw error;
  }
}

async function inspectControllerLock(projectRoot: string, missionId: string | undefined): Promise<StartHardGate> {
  if (!missionId) {
    return gate("controller-lock", "pass", "controller lock", "no Mission id to check for an active controller");
  }
  try {
    await stat(join(projectRoot, ".evok", "missions", missionId, "controller.lock"));
    return gate(
      "controller-lock",
      "block",
      "controller lock",
      `mission ${missionId} already has an active controller (controller.lock); a second controller cannot dispatch it`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return gate("controller-lock", "pass", "controller lock", "no active controller lock");
    }
    throw error;
  }
}

async function inspectEvaluation(projectRoot: string): Promise<StartHardGate> {
  try {
    const contract = await loadEvaluationContract(projectRoot);
    return gate(
      "evaluation-contract",
      "pass",
      "evaluation contract",
      `${evaluationContractPath(projectRoot)} id=${contract.id} artifact=${contract.artifact}`,
    );
  } catch (error) {
    const detail = error instanceof EvaluationContractError
      ? error.message
      : (error as Error).message;
    return gate("evaluation-contract", "block", "evaluation contract", detail);
  }
}

async function inspectModel(
  probe: InspectStartHardGatesOptions["modelProbe"],
): Promise<StartHardGate> {
  if (!probe) {
    return gate(
      "model-auth",
      "block",
      "Pi model/auth",
      "Pi model/auth was not probed; a live baseline Run still requires configured model and credentials. Missing auth is not a pass.",
    );
  }
  const result = await probe();
  if (result.ok) {
    return gate("model-auth", "pass", "Pi model/auth", "requested tier resolved and preflighted");
  }
  return gate("model-auth", "block", "Pi model/auth", result.error);
}

/**
 * Inspect start prerequisites without dispatching. Relative project roots are
 * refused (absolute-path operation). In-force gates are always listed and
 * never reported as pass.
 */
export async function inspectStartHardGates(
  options: InspectStartHardGatesOptions,
): Promise<StartHardGateReport> {
  const passed: StartHardGate[] = [];
  const blocking: StartHardGate[] = [];
  const push = (item: StartHardGate) => {
    if (item.status === "block") blocking.push(item);
    else if (item.status === "pass") passed.push(item);
  };

  const absolute = isAbsolute(options.projectRoot);
  push(absolute
    ? gate("project-absolute", "pass", "absolute project path", options.projectRoot)
    : gate(
      "project-absolute",
      "block",
      "absolute project path",
      `projectRoot must be an absolute path (got ${JSON.stringify(options.projectRoot)}); relative --project is resolved from the current working directory and is a footgun`,
    ));

  let missionId = options.missionId;
  if (absolute) {
    push(await inspectEvaluation(options.projectRoot));
    const draftView = await inspectDraft(options.projectRoot, options.missionId);
    missionId = draftView.missionId ?? missionId;
    push(draftView.draftGate);
    push(inspectAuthorization(options.authorization));
    if (options.authorization && missionId && options.authorization.missionSelector !== "displayed" && options.authorization.missionSelector !== missionId) {
      push(gate(
        "explicit-authorization",
        "block",
        "explicit start authorization",
        `start targets mission ${options.authorization.missionSelector} but the displayed mission is ${missionId}; refusing to guess which work was authorized`,
      ));
    }
    push(inspectBudget(draftView.draft, options.budgetUnits ?? ENFORCEABLE_BUDGET_UNITS));
    push(inspectPermissions(draftView.draft));
    push(await inspectAlreadyStarted(options.projectRoot, missionId));
    push(await inspectControllerLock(options.projectRoot, missionId));
  } else {
    push(gate(
      "evaluation-contract",
      "block",
      "evaluation contract",
      "not inspected: project path is not absolute",
    ));
    push(gate(
      "reviewed-draft",
      "block",
      "reviewed Mission draft",
      "not inspected: project path is not absolute",
    ));
  }
  push(await inspectModel(options.modelProbe));

  const inForce = inForceGates();
  return {
    projectRoot: options.projectRoot,
    ...(missionId ? { missionId } : {}),
    ready: blocking.length === 0,
    blocking,
    passed,
    inForce,
  };
}

export function formatStartHardGateReport(report: StartHardGateReport): string {
  const lines = [
    report.ready
      ? "evok: start-path prerequisites are present; remaining hard gates below stay in force (nothing extra was authorized)"
      : "evok: start not ready — remaining hard gates (nothing dispatched)",
    `project (absolute required): ${report.projectRoot}`,
    ...(report.missionId ? [`mission: ${report.missionId}`] : []),
    "",
  ];
  if (report.blocking.length > 0) {
    lines.push("Blocking this start:");
    for (const item of report.blocking) {
      lines.push(`- ${item.title} (${item.id}): ${item.detail}`);
    }
    lines.push("");
  }
  if (report.passed.length > 0) {
    lines.push("Start-path checks that passed (not a product-green, not Admission/submit):");
    for (const item of report.passed) {
      lines.push(`- ${item.title} (${item.id}): ${item.detail}`);
    }
    lines.push("");
  }
  lines.push("Still in force (not downgraded; not a pass; does not invent green):");
  for (const item of report.inForce) {
    lines.push(`- ${item.title} (${item.id}): ${item.detail}`);
  }
  lines.push("");
  lines.push("Start is not skill-authorization and does not authorize true submit. #40 Progressive stays off.");
  return `${lines.join("\n")}\n`;
}
