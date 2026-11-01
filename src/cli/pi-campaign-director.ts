// Pi owns the interactive Director session. The campaign host owns durable work and evidence.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface CampaignDispatch {
  role: "researcher" | "reviewer";
  jobId: string;
  objective: string;
  reviewRequested?: boolean;
  sourcePaths?: string[];
  sessionId: string;
  signal: AbortSignal;
}

export interface PiCampaignHost {
  status(): Promise<unknown>;
  dispatch(input: CampaignDispatch): Promise<{ job: { state: string } | null; summary?: string }>;
  retry(input: { jobId: string; claimId: string; reason: string }): Promise<unknown>;
  stop(input: { jobId: string; sessionId: string; reason: string }): Promise<unknown>;
}

function result(details: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
}

export function registerCampaignDirector(pi: ExtensionAPI, host: PiCampaignHost) {
  let active: { jobId: string; role: string; abort: AbortController; done: Promise<void> } | undefined;

  pi.registerTool({
    name: "evok_status",
    label: "EvoK · 状态",
    description:
      "Read the campaign state, evidence and current Pi job. Read this before selecting the next experiment.",
    promptSnippet: "Inspect EvoK's saved experiment and any available work.",
    parameters: Type.Object({}),
    async execute() {
      return result(await host.status());
    },
  });

  pi.registerTool({
    name: "evok_dispatch",
    label: "EvoK · 派发",
    description:
      "Start an EvoK child using pi-subagents. Choose a pending job from evok_status. Give the Researcher a concise testable hypothesis; request independent review when needed. For a review-pending candidate dispatch Reviewer on the same job. Completion is reported to this session.",
    promptSnippet: "Delegate a single EvoK experiment or independent review from this Director session.",
    promptGuidelines: [
      "Use evok_dispatch for competition research so the campaign supplies each child its scoped evidence, workspace and metered model.",
    ],
    parameters: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      role: Type.Union([Type.Literal("researcher"), Type.Literal("reviewer")]),
      objective: Type.String({
        minLength: 1,
        maxLength: 2000,
        description: "This round's hypothesis or review question. Do not copy the conversation or competition rules.",
      }),
      sourcePaths: Type.Optional(
        Type.Array(Type.String({ minLength: 1 }), {
          minItems: 1,
          maxItems: 6,
          uniqueItems: true,
          description:
            "Researcher only: select the specific runtime files for this experiment from evok_status, or name an intended new file. Reviewer automatically receives the frozen diff.",
        }),
      ),
      reviewRequested: Type.Optional(
        Type.Boolean({
          description: "Dispatch a fresh independent Reviewer on the finished candidate before evaluation.",
        }),
      ),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      if (active) throw Error("EvoK already has an active " + active.role + " for " + active.jobId);
      if (params.role === "researcher" && !params.sourcePaths?.length)
        throw Error("select sourcePaths for this experiment from evok_status");
      if (params.role === "reviewer" && (params.sourcePaths || params.reviewRequested))
        throw Error("the Reviewer uses the frozen candidate diff");
      const abort = new AbortController();
      const sessionId = ctx.sessionManager.getSessionId();
      if (ctx.hasUI) ctx.ui.setStatus("evok-child", "● " + params.role + " · " + params.jobId);
      const publish = (text: string) => {
        if (!abort.signal.aborted && ctx.sessionManager.getSessionId() === sessionId) {
          pi.sendMessage({ customType: "evok-experiment", content: text, display: true }, { triggerTurn: false });
        }
      };
      const run = async () => {
        const receipt = await host.dispatch({ ...params, sessionId, signal: abort.signal });
        if (params.role !== "researcher" || !params.reviewRequested || receipt.job?.state !== "review-pending")
          return receipt;
        abort.signal.throwIfAborted();
        if (active) active.role = "reviewer";
        if (ctx.hasUI) ctx.ui.setStatus("evok-child", "● reviewer · " + params.jobId);
        return host.dispatch({
          jobId: params.jobId,
          role: "reviewer",
          sessionId,
          signal: abort.signal,
          objective: "Review the frozen changes against the recorded hypothesis before evaluation.",
        });
      };
      const done = Promise.resolve()
        .then(run)
        .then(
          (outcome) => publish("EvoK · " + params.jobId + " · " + JSON.stringify(outcome)),
          (error) =>
            publish("EvoK · " + params.jobId + " · " + (error instanceof Error ? error.message : String(error))),
        )
        .finally(() => {
          if (active?.abort === abort) {
            active = undefined;
            if (ctx.hasUI) ctx.ui.setStatus("evok-child", undefined);
          }
        });
      active = { jobId: params.jobId, role: params.role, abort, done };
      return result({ jobId: params.jobId, role: params.role, state: "starting" });
    },
  });

  pi.registerTool({
    name: "evok_retry",
    label: "EvoK · 重开失败工单",
    description:
      "Reopen a failed proposal after its failure is understood. Use its exact claimId from evok_status. Reopening does not start a model call.",
    parameters: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      claimId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_call, params) {
      if (active) throw Error("cannot reopen a proposal while a child is active");
      return result(await host.retry(params));
    },
  });
  pi.registerTool({
    name: "evok_stop",
    label: "EvoK · 结束实验",
    description: "Record the Director's decision to stop a pending proposal when evidence supports stopping.",
    parameters: Type.Object({
      jobId: Type.String({ minLength: 1 }),
      reason: Type.String({ minLength: 1, maxLength: 2000 }),
    }),
    async execute(_call, params, _signal, _update, ctx) {
      if (active) throw Error("An EvoK child is active; read evok_status before stopping.");
      return result(await host.stop({ ...params, sessionId: ctx.sessionManager.getSessionId() }));
    },
  });
  pi.on("session_shutdown", async () => {
    active?.abort.abort();
    await active?.done;
  });
}
