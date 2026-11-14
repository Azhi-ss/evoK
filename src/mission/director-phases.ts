/**
 * The controller's DIRECTOR DECISION stage (PRD §4 Stage 4; #211/#253/#257).
 *
 * One bounded decision point, in the two stages the evidence discipline
 * requires:
 *
 *   1. **blind** — the Director sees the trusted base state and NOTHING from
 *      Research Memory; its validated proposal is frozen durably before any
 *      Memory card is loaded, so a revision or crash can never regenerate a
 *      purportedly blind decision;
 *   2. **pin** — one Research Memory packet and one Insight sidecar are pinned
 *      for this decision only, failing closed on damaged memory;
 *   3. **revision** — the same base state plus the frozen blind proposal and
 *      the pinned inputs; ONLY its validated Revised Proposal can dispatch.
 *
 * Research judgement stays the Director's: this module never invents an action,
 * an objective or a rationale. It validates, meters (B3: attribution and
 * settlement stay Mission-side), and records one durable `DecisionRecord` per
 * priced call. The already-durable stages of a crashed decision group are
 * reused, never re-called or re-charged (`recovery.ts`).
 *
 * Terminal decision failures throw their typed errors after persisting the
 * truthful state, exactly as before the extraction; the loop's own
 * recover-or-terminate step is `recovery.ts`.
 */
import {
  DirectorDecisionFailedError,
  DirectorProposalRejectedError,
  deriveDecisionDelta,
  validateDirectorProposal,
  type DirectorAction,
  type DirectorDecision,
  type DirectorInput,
  type DirectorProposal,
  type MissionDirector,
} from "./mission-director";
import {
  assertRevisionInsightDispositions,
  buildDirectorInsightSidecar,
  emptyDirectorInsightSidecar,
  recordRevisionInsightDispositions,
  undispositionedInsightIds,
  type DirectorInsightSidecar,
} from "./director-insight-sidecar";
import type { InsightLedger } from "./insight-inbox";
import {
  loadActiveResearchMemorySnapshot,
  researchMemoryStoreFor,
} from "../memory";
import {
  assertPacketCardRefs,
  projectResearchDecisionPacket,
  shamResearchDecisionPacket,
  type ResearchDecisionPacket,
  type ResearchMemoryEvaluationMode,
} from "../evidence/research-memory";
import type { RejectedDirectionApplicability } from "./decision-accountability";
import type { ModelConfigView, RuntimeUsage } from "../pi-agent-runtime";
import {
  BudgetExhaustedError,
  DirectorBlockedError,
  candidateNetworkInstruction,
  ZERO_USAGE,
  withEvent,
  type DecisionAuditFields,
  type DecisionPhase,
  type DecisionRecord,
  type HistoryEvent,
  type MissionRecord,
  type MissionTaskRecord,
  type RejectedAlternative,
  type StartMissionOptions,
  type UsageLine,
} from "./mission-start";
import { recoveredApplication, recoveredDecisionGroup } from "./recovery";

/** Three bounded priced attempts per decision stage, then stop for a human. */
export const MAX_DECISION_ATTEMPTS = 3;

/** What one decision point must not re-derive from the controller's options. */
export interface DirectorPhasePorts {
  readonly projectRoot: string;
  readonly missionId: string;
  readonly director: MissionDirector;
  /** The controller's single abort owner (an unconfirmed abort is never success). */
  readonly signal?: AbortSignal;
  readonly aborted: () => boolean;
  readonly abortError: (label: string) => Error;
  readonly now: () => string;
  readonly persist: (projectRoot: string, record: MissionRecord) => Promise<void>;
  readonly releaseLock: () => Promise<void>;
  /** Reserved for ONE decision call (B3: reserve here, settle as metered). */
  readonly reserveCost: number;
  readonly priceModelCost?: StartMissionOptions["priceModelCost"];
  /**
   * The durable Research Memory arm and directory. The phase PINS a packet;
   * publishing stays the controller's derived-memory step.
   */
  readonly memory: {
    readonly enabled: boolean;
    readonly mode: ResearchMemoryEvaluationMode;
    readonly dir: string;
  };
  readonly insightLedger?: InsightLedger;
}

/** One decision point's frozen inputs. */
export interface DirectorDecisionArgs {
  readonly record: MissionRecord;
  /** The trusted base state the controller built and checked (F5/#231). */
  readonly input: DirectorInput;
}

export interface DirectorPhaseResult {
  readonly record: MissionRecord;
  readonly proposal: DirectorProposal;
  readonly stateVersion: number;
  readonly decisionGroupId: string;
}

export interface DirectorPhases {
  /** Blind → pin → revision for one state version; throws on a terminal failure. */
  readonly decideNextAction: (args: DirectorDecisionArgs) => Promise<DirectorPhaseResult>;
}

/**
 * The decision stages close over one Run's ports, exactly as the controller's
 * closures did, so every persistence and metering rule stays in one place.
 */
export function createDirectorPhases(ports: DirectorPhasePorts): DirectorPhases {
  const {
    projectRoot, missionId, director, signal, aborted, abortError, now, persist,
    releaseLock, reserveCost, priceModelCost, insightLedger,
  } = ports;
  const { enabled: researchMemoryEnabled, mode: researchMemoryMode, dir: memoryDir } = ports.memory;

  /** Meter one decision-model call with the same honest cost rules as Runs. */
  const meterDecision = async (args: {
    current: MissionRecord;
    decisionId: string;
    stateVersion: number;
    attempt: number;
    usage: RuntimeUsage;
    sessionId?: string;
    model?: ModelConfigView;
  }): Promise<{ record: MissionRecord; cost: number; unknownCost: boolean }> => {
    let cost = args.usage.cost.total;
    let unknownCost = false;
    if (!Number.isFinite(cost) || cost === 0) {
      const pricer = priceModelCost;
      const priced = pricer && args.model ? pricer(args.model)(args.usage.tokens) : undefined;
      if (args.usage.tokens.total > 0 && (priced === undefined || !Number.isFinite(priced))) {
        // Token-positive usage with no meterable price is UNKNOWN cost, never a
        // verified zero: record the call and stop rather than dispatch again.
        unknownCost = true;
        cost = 0;
      } else if (priced !== undefined && Number.isFinite(priced)) {
        cost = priced;
      }
    }
    const consumed = args.current.budget.consumed + cost;
    const line: UsageLine = {
      at: now(), sessionId: args.sessionId ?? args.decisionId,
      tokens: { ...args.usage.tokens }, cost: { ...args.usage.cost, total: cost },
    };
    const r: MissionRecord = {
      ...args.current,
      budget: { ...args.current.budget, consumed, remaining: args.current.budget.total - consumed },
      usage: { ...args.current.usage, decisions: [...(args.current.usage.decisions ?? []), line] },
    };
    return { record: r, cost, unknownCost };
  };

  const appendDecision = async (
    r: MissionRecord,
    args: { decisionId: string; stateVersion: number; attempt: number; sessionId?: string },
    cost: number,
    accepted: boolean,
    rejection: string | undefined,
    proposal?: DirectorProposal,
    usage?: RuntimeUsage,
    extra: Partial<DecisionAuditFields> = {},
  ): Promise<MissionRecord> => {
    const decision: DecisionRecord = {
      decisionId: args.decisionId,
      stateVersion: args.stateVersion,
      attempt: args.attempt,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      accepted,
      ...(proposal?.action ? { action: proposal.action } : {}),
      ...(proposal?.rationale ? { rationale: proposal.rationale } : {}),
      ...(proposal ? { proposal } : {}),
      ...(rejection ? { rejection } : {}),
      tokens: { ...(usage?.tokens ?? ZERO_USAGE.tokens) },
      cost,
      at: now(),
      ...extra,
    };
    const event: HistoryEvent = accepted
      ? { type: "DIRECTOR_CALLED", at: now(), detail: { decisionId: args.decisionId, action: proposal?.action, cost, ...(extra.phase ? { phase: extra.phase } : {}), ...(extra.delta ? { delta: extra.delta } : {}) } }
      : { type: "PROPOSAL_REJECTED", at: now(), detail: { decisionId: args.decisionId, attempt: args.attempt, reason: rejection, ...(extra.phase ? { phase: extra.phase } : {}) } };
    return withEvent(r, event, { decisions: [...(r.decisions ?? []), decision] });
  };

  const reserveDecisionSlot = (r: MissionRecord): MissionRecord => {
    const available = r.budget.remaining - r.reserved;
    if (available + 1e-12 < reserveCost) {
      const stopped = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { available, requested: reserveCost, stage: "before-director-decision" } }, {
        status: "budget-exhausted",
        stopReason: `budget exhausted before the next decision: ${available} ${r.budget.units} available; no further dispatch even if the model would continue`,
      });
      return stopped;
    }
    return { ...r, reserved: r.reserved + reserveCost };
  };

  const decideStage = async (args: {
    current: MissionRecord;
    stageInput: DirectorInput;
    phase: DecisionPhase;
    decisionGroupId: string;
    decisionId: (attempt: number) => string;
    /** First unused attempt: a resumed stage never re-charges completed attempts. */
    startAttempt?: number;
    blindProposal?: DirectorProposal;
    packet?: ResearchDecisionPacket;
    insightSidecar?: DirectorInsightSidecar;
  }): Promise<{ record: MissionRecord; proposal?: DirectorProposal; blockedReason?: string }> => {
    let r = args.current;
    let blockedReason: string | undefined;
    const stageExtra = { phase: args.phase, decisionGroupId: args.decisionGroupId } as const;

    /** Durable audit fields for one accepted stage call (#211 AC6). */
    const auditOf = (proposal: DirectorProposal, call: DirectorDecision): Partial<DecisionAuditFields> => {
      const usedCardRefs = [...new Set(call.usedMemoryRefs ?? [])];
      // #240: only a stage that was handed a sidecar records what it read.
      const unanswered = args.insightSidecar === undefined
        ? []
        : undispositionedInsightIds(args.insightSidecar, call.insightDispositions ?? []);
      const insightAudit = args.insightSidecar === undefined ? {} : {
        insight: {
          sidecarDigest: args.insightSidecar.digest,
          items: args.insightSidecar.items.map((item) => ({ insightId: item.insightId, version: item.version })),
          ...(unanswered.length > 0 ? { undispositioned: unanswered } : {}),
          omittedCount: args.insightSidecar.omittedCount,
          truncated: args.insightSidecar.truncated,
        },
      };
      const base = { ...stageExtra, ...(call.model ? { model: call.model } : {}), ...insightAudit };
      if (args.phase === "blind") return base;
      // M1-T6: every rejected direction keeps the Memory refs that informed the
      // revision, their applicability, and an UNOBSERVED counterfactual. Nothing
      // in this record can call an unexecuted direction a failure or a regret.
      const influencingMemoryRefs = usedCardRefs;
      const applicability = applicabilityOf(args.packet, influencingMemoryRefs);
      const rejectedAlternative = (
        alternative: { action: DirectorAction; objective?: string },
        reason: string,
        extra: Partial<RejectedAlternative> = {},
      ): RejectedAlternative => ({
        action: alternative.action,
        ...(alternative.objective !== undefined ? { objective: alternative.objective } : {}),
        reason,
        influencingMemoryRefs,
        applicability,
        counterfactualStatus: "unobserved",
        ...extra,
      });
      const rejectedAlternatives: RejectedAlternative[] = (proposal.alternatives ?? []).map((alternative) =>
        rejectedAlternative(alternative, "not selected: only the head action dispatches"));
      // A delta only exists when Memory was actually delivered; an Off or
      // unpinned Mission must never attribute a change to Memory it never saw.
      if (args.packet === undefined || args.blindProposal === undefined) {
        return {
          ...base,
          revisionReason: proposal.rationale,
          ...(rejectedAlternatives.length ? { rejectedAlternatives } : {}),
        };
      }
      const delta = deriveDecisionDelta(args.blindProposal, proposal);
      if (delta !== "unchanged") {
        rejectedAlternatives.push(rejectedAlternative(
          { action: args.blindProposal.action, ...(args.blindProposal.task ? { objective: args.blindProposal.task.objective } : {}) },
          `superseded by the Memory-informed revision (delta ${delta})`,
          { proposal: args.blindProposal },
        ));
      }
      return {
        ...base,
        delta,
        revisionReason: proposal.rationale,
        ...(rejectedAlternatives.length ? { rejectedAlternatives } : {}),
        memory: {
          snapshotId: args.packet.snapshotId,
          snapshotDigest: args.packet.snapshotDigest,
          packetDigest: args.packet.digest,
          cardRefs: args.packet.cards.map((card) => card.cardId),
          usedCardRefs,
        },
      };
    };

    for (let decisionAttempt = args.startAttempt ?? 1; decisionAttempt <= MAX_DECISION_ATTEMPTS; decisionAttempt++) {
      const stateVersion = r.stateVersion ?? 0;
      const decisionId = args.decisionId(decisionAttempt);
      const reserved = reserveDecisionSlot(r);
      if (reserved.status === "budget-exhausted") return { record: reserved };
      r = reserved;
      let call: DirectorDecision;
      try {
        call = await director.decide(args.stageInput, signal, decisionAttempt);
      } catch (error) {
        if ((error as Error).name === "AbortError" || aborted()) {
          r = withEvent(r, { type: "RUN_INTERRUPTED", at: now(), detail: { decisionId } }, {
            status: "interrupted",
            stopReason: "user interruption during a director decision; result unconfirmed until recovery",
          });
          await persist(projectRoot, r);
          await releaseLock();
          throw abortError("director decision");
        }
        if (error instanceof DirectorDecisionFailedError) {
          r = { ...r, reserved: Math.max(0, r.reserved - reserveCost) };
          r = withEvent(r, { type: "PROPOSAL_REJECTED", at: now(), detail: { decisionId, reason: error.message, phase: args.phase } }, {
            status: "decision-failed",
            stopReason: `decision-model run failed: ${error.message}`,
          });
          await persist(projectRoot, r);
          await releaseLock();
          throw error;
        }
        // A rejection surfaced by the adapter (non-JSON / invalid JSON) is
        // still a REAL priced model call: meter its carried usage so the
        // correction attempt counts against the budget (AC7), then retry.
        if (error instanceof DirectorProposalRejectedError && error.usage) {
          const metered = await meterDecision({
            current: { ...r, reserved: Math.max(0, r.reserved - reserveCost) },
            decisionId, stateVersion, attempt: decisionAttempt,
            usage: error.usage, sessionId: error.sessionId, model: error.model,
          });
          r = await appendDecision(metered.record, { decisionId, stateVersion, attempt: decisionAttempt, sessionId: error.sessionId }, metered.cost, false, error.message, undefined, error.usage, { ...stageExtra, ...(error.model ? { model: error.model } : {}) });
          if (metered.unknownCost) {
            r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { decisionId, reason: "decision usage without meterable cost" } }, {
              status: "budget-exhausted",
              stopReason: "decision-model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
            });
            await persist(projectRoot, r);
            await releaseLock();
            throw new BudgetExhaustedError(r.stopReason!);
          }
          blockedReason = error.message;
          await persist(projectRoot, r);
          continue;
        }
        // A rejection without any carried usage (no model call happened).
        const reason = error instanceof DirectorProposalRejectedError ? error.message : String((error as Error).message ?? error);
        r = { ...r, reserved: Math.max(0, r.reserved - reserveCost) };
        r = await appendDecision(r, { decisionId, stateVersion, attempt: decisionAttempt }, 0, false, reason, undefined, ZERO_USAGE, stageExtra);
        blockedReason = reason;
        await persist(projectRoot, r);
        continue;
      }

      // Validate AGAIN in the controller (never trust the adapter). A revision
      // must also only claim Memory cards that were actually delivered.
      let accepted: DirectorProposal;
      try {
        accepted = validateDirectorProposal(call.proposal, args.stageInput);
        // The stage input is the frozen base state (#209 "same trusted state"),
        // so the authoritative budget can only have shrunk since it was built:
        // re-check the request against the live available budget here instead
        // of accepting a proposal the dispatch gate must refuse.
        const liveAvailable = r.budget.remaining - Math.max(0, r.reserved - reserveCost);
        if ((accepted.expectedCost ?? 0) > liveAvailable + 1e-12) {
          throw new DirectorProposalRejectedError(
            `over-budget proposal: it expects ${accepted.expectedCost} ${r.budget.units} but only ${liveAvailable} is available now; propose within the remaining budget or stop`,
          );
        }
        if (args.packet) assertPacketCardRefs(args.packet, call.usedMemoryRefs ?? []);
        else if (call.usedMemoryRefs?.length) {
          throw new DirectorProposalRejectedError("no Research Decision Packet was delivered, so no Memory card can be claimed as used");
        }
        // #240: a Revision owes one answer per pinned Insight before anything
        // becomes durable; a bad answer is a rejected attempt, not a silent gap.
        if (args.insightSidecar !== undefined) {
          assertRevisionInsightDispositions(args.insightSidecar, call.insightDispositions ?? []);
        }
      } catch (error) {
        const reason = (error as Error).message;
        const metered = await meterDecision({
          current: { ...r, reserved: Math.max(0, r.reserved - reserveCost) },
          decisionId, stateVersion, attempt: decisionAttempt,
          usage: call.usage, sessionId: call.sessionId, model: call.model,
        });
        r = await appendDecision(metered.record, { decisionId, stateVersion, attempt: decisionAttempt, sessionId: call.sessionId }, metered.cost, false, reason, undefined, call.usage, { ...stageExtra, ...(call.model ? { model: call.model } : {}) });
        if (metered.unknownCost) {
          r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { decisionId, reason: "decision usage without meterable cost" } }, {
            status: "budget-exhausted",
            stopReason: "decision-model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
          });
          await persist(projectRoot, r);
          await releaseLock();
          throw new BudgetExhaustedError(r.stopReason!);
        }
        blockedReason = reason;
        await persist(projectRoot, r);
        continue;
      }

      const metered = await meterDecision({
        current: { ...r, reserved: Math.max(0, r.reserved - reserveCost) },
        decisionId, stateVersion, attempt: decisionAttempt,
        usage: call.usage, sessionId: call.sessionId, model: call.model,
      });
      r = await appendDecision(metered.record, { decisionId, stateVersion, attempt: decisionAttempt, sessionId: call.sessionId }, metered.cost, true, undefined, accepted, call.usage, auditOf(accepted, call));
      if (metered.unknownCost) {
        r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { decisionId, reason: "decision usage without meterable cost" } }, {
          status: "budget-exhausted",
          stopReason: "decision-model usage has no meterable cost in the declared unit; refusing to treat unknown cost as zero",
        });
        await persist(projectRoot, r);
        await releaseLock();
        throw new BudgetExhaustedError(r.stopReason!);
      }
      // #240: the accepted Revision's judgements become ledger events THROUGH
      // the existing Insight path, before its own record is durable. Recording
      // first means a crash loses nothing (an answered Insight is no longer
      // pending, so a re-decided Revision pins only the rest) and duplicates
      // nothing (an identical retry in this cycle is a no-op).
      if (insightLedger !== undefined && args.insightSidecar !== undefined && args.insightSidecar.items.length > 0) {
        recordRevisionInsightDispositions(insightLedger, {
          missionId: r.id,
          sidecar: args.insightSidecar,
          decisionRef: args.decisionGroupId,
          dispositions: call.insightDispositions ?? [],
        });
      }
      // A priced decision may itself cross the budget: metered cost leaves
      // consumed/remaining honest; enforce a hard stop here.
      if (r.budget.consumed > r.budget.total + 1e-12) {
        r = withEvent(r, { type: "BUDGET_EXHAUSTED", at: now(), detail: { consumed: r.budget.consumed, total: r.budget.total } }, {
          status: "budget-exhausted",
          stopReason: `declared budget ${r.budget.total} ${r.budget.units} exceeded after a decision call; no further dispatch`,
        });
      }
      // The accepted proposal is durable BEFORE the caller shows any Memory.
      await persist(projectRoot, r);
      return { record: r, proposal: accepted };
    }
    return {
      record: r,
      ...(blockedReason === undefined && args.startAttempt !== undefined && args.startAttempt > MAX_DECISION_ATTEMPTS
        // Every bounded attempt was already priced and persisted pre-crash.
        ? { blockedReason: "all bounded attempts for this stage were already priced before the interruption; no new call was made" }
        : { blockedReason }),
    };
  };
  async function decideNextAction(args: DirectorDecisionArgs): Promise<DirectorPhaseResult> {
    let record = args.record;
    // ── M1-T2 two-stage decision (#211) ──────────────────────────────────
    // Stage 1 is Memory-blind: it sees the same trusted state as before and
    // nothing from Research Memory. Its validated proposal is persisted
    // (frozen) BEFORE any Memory card is loaded, so a crash or revision can
    // never regenerate a purportedly blind proposal after Memory was visible.
    // Stage 2 receives that same base state plus the frozen proposal and one
    // pinned Decision Packet, and ONLY its Revised Proposal can dispatch.
    const stateVersion = record.stateVersion ?? 0;
    const decisionGroupId = `${missionId}:director:${stateVersion}`;
    // M1-T7: a stage already durable for THIS state version is reused, never
    // re-called or re-charged (recovery.ts reads that durable state).
    const recovered = recoveredDecisionGroup(record, { decisionGroupId, stateVersion });
    const frozenBlind = recovered.blind;
    const frozenRevision = recovered.revision;

    // The already-validated Revised Proposal of a resumed decision needs no
    // second model call, no new snapshot pin, and no second charge.
    let proposal = frozenRevision.proposal;
    if (proposal === undefined) {
      // The frozen Blind Proposal is reused as-is; only a decision group with
      // no durable blind stage may call the Memory-blind stage again.
      let blindProposal = frozenBlind.proposal;
      if (blindProposal === undefined) {
        const blindStage = await decideStage({
          current: record,
          stageInput: args.input,
          phase: "blind",
          decisionGroupId,
          decisionId: (attempt) => `${decisionGroupId}:${attempt}`,
          startAttempt: frozenBlind.nextAttempt,
        });
        record = blindStage.record;
        if (record.status === "budget-exhausted") {
          await persist(projectRoot, record);
          await releaseLock();
          throw new BudgetExhaustedError(record.stopReason ?? "budget exhausted before the next decision; no further dispatch");
        }
        if (!blindStage.proposal) {
          const reason = blindStage.blockedReason ?? "the decision model returned no usable proposal";
          record = withEvent(record, { type: "PROPOSAL_REJECTED", at: now(), detail: { exhausted: MAX_DECISION_ATTEMPTS, reason, phase: "blind" } }, {
            status: "director-blocked",
            stopReason: `decision model produced only invalid proposals after ${MAX_DECISION_ATTEMPTS} bounded attempts in the Memory-blind stage (${reason}); stopping for an explicit decision instead of guessing`,
          });
          await persist(projectRoot, record);
          await releaseLock();
          throw new DirectorBlockedError(record.stopReason!, reason);
        }
        blindProposal = blindStage.proposal;
      }

      // Stage 0/2 pin: one snapshot, loaded only after the blind proposal is
      // durably frozen. Damaged Memory fails closed rather than deciding on an
      // empty research history.
      let pinnedPacket: ResearchDecisionPacket | undefined;
      if (researchMemoryEnabled) {
        try {
          const snapshot = await loadActiveResearchMemorySnapshot(researchMemoryStoreFor(memoryDir));
          if (snapshot !== undefined) {
            const projected = projectResearchDecisionPacket(snapshot);
            // M1-T9: the Sham arm delivers the Schema-only control packet, not
            // the research packet, with the same structure and bounds.
            pinnedPacket = researchMemoryMode === "sham" ? shamResearchDecisionPacket(projected) : projected;
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          record = withEvent(record, { type: "PROPOSAL_REJECTED", at: now(), detail: { decisionId: decisionGroupId, reason } }, {
            status: "director-blocked",
            stopReason: `Research Memory could not be pinned for the revision stage (${reason}); refusing to decide on damaged memory`,
          });
          await persist(projectRoot, record);
          await releaseLock();
          throw new DirectorBlockedError(record.stopReason!, reason);
        }
      }

      // #240: the Insight sidecar is pinned here, next to the Memory packet and
      // AFTER the Blind Proposal is durable, so no human idea can reach the
      // blind stage. Loading is unconditional: without an Insight ledger the
      // Revision receives an explicit empty sidecar instead of no input at all.
      let insightSidecar: DirectorInsightSidecar;
      try {
        insightSidecar = insightLedger === undefined
          ? emptyDirectorInsightSidecar(record.id)
          : buildDirectorInsightSidecar(insightLedger.events(), { missionId: record.id });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        record = withEvent(record, { type: "PROPOSAL_REJECTED", at: now(), detail: { decisionId: decisionGroupId, reason } }, {
          status: "director-blocked",
          stopReason: `human Insight could not be pinned for the revision stage (${reason}); refusing to revise without the operator's pending input`,
        });
        await persist(projectRoot, record);
        await releaseLock();
        throw new DirectorBlockedError(record.stopReason!, reason);
      }

      const revisionStage = await decideStage({
        current: record,
        stageInput: {
          ...args.input,
          decisionPhase: {
            blindProposal,
            ...(pinnedPacket ? { memoryPacket: pinnedPacket } : {}),
            insightSidecar,
          },
        },
        phase: "revision",
        decisionGroupId,
        decisionId: (attempt) => `${decisionGroupId}:${attempt}:revision`,
        startAttempt: frozenRevision.nextAttempt,
        blindProposal,
        ...(pinnedPacket ? { packet: pinnedPacket } : {}),
        insightSidecar,
      });
      record = revisionStage.record;
      if (record.status === "budget-exhausted") {
        await persist(projectRoot, record);
        await releaseLock();
        throw new BudgetExhaustedError(record.stopReason ?? "budget exhausted before the Memory-informed revision; no further dispatch");
      }
      if (!revisionStage.proposal) {
        const reason = revisionStage.blockedReason ?? "the decision model returned no usable revised proposal";
        record = withEvent(record, { type: "PROPOSAL_REJECTED", at: now(), detail: { exhausted: MAX_DECISION_ATTEMPTS, reason, phase: "revision" } }, {
          status: "director-blocked",
          stopReason: `decision model produced only invalid proposals after ${MAX_DECISION_ATTEMPTS} bounded attempts in the Memory-informed stage (${reason}); the frozen Blind Proposal was NOT dispatched`,
        });
        await persist(projectRoot, record);
        await releaseLock();
        throw new DirectorBlockedError(record.stopReason!, reason);
      }
      proposal = revisionStage.proposal;
    }

    return { record, proposal, stateVersion, decisionGroupId };
  }

  return { decideNextAction };
}

/** The applicability the delivered, actually-used cards declared (#215 AC3). */
function applicabilityOf(
  packet: ResearchDecisionPacket | undefined,
  usedCardRefs: readonly string[],
): RejectedDirectionApplicability {
  const cards = packet?.cards.filter((card) => usedCardRefs.includes(card.cardId)) ?? [];
  const declared = [...new Set(cards.flatMap((card) => card.applicability))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Undeclared is unknown, never silently compatible.
  return { declared, status: declared.length > 0 ? "declared" : "unknown" };
}

/** One validated proposal rendered as an applied Task with a Run identity. */
export interface AppliedProposal {
  readonly record: MissionRecord;
  readonly task: MissionTaskRecord;
  readonly application: { readonly runId: string; readonly taskId: string; readonly attempt: number };
}

/**
 * Apply the bounded proposal THROUGH the existing operations: one Task Contract
 * entry, then a fresh Run. M1-T7: an already-durable PROPOSAL_APPLIED for this
 * state version keeps its Run identity, so recovery never creates a second
 * Experiment for one validated action.
 */
export function applyDirectorProposal(
  record: MissionRecord,
  args: {
    readonly proposal: DirectorProposal;
    readonly stateVersion: number;
    /** baseline is attempt 1; resume climbs past every prior attempt. */
    readonly nextAttemptNumber: number;
    readonly missionId: string;
    readonly at: string;
  },
): AppliedProposal {
  const { proposal, nextAttemptNumber, missionId, at } = args;
  const applied = recoveredApplication(record, args.stateVersion);
  const attempt = applied?.attempt ?? nextAttemptNumber;
  const runId = applied?.runId ?? `${missionId}:exp:${attempt}`;
  const taskId = applied?.taskId ?? `task-exp-${attempt}`;
  let task = (record.tasks ?? []).find((entry) => entry.taskId === taskId);
  if (task === undefined) {
    task = {
      taskId,
      objective: proposal.task!.objective,
      ...(proposal.task!.kind ? { kind: proposal.task!.kind } : {}),
      ...(proposal.task!.artifacts ? { artifacts: proposal.task!.artifacts } : {}),
      ...(proposal.task!.expectedOutputs ? { expectedOutputs: proposal.task!.expectedOutputs } : {}),
      ...(proposal.task!.constraints ? { constraints: proposal.task!.constraints } : {}),
      ...(proposal.basedOn ? { dependencies: proposal.basedOn } : {}),
      source: "director",
    };
    record = withEvent(record, {
      type: "PROPOSAL_APPLIED",
      at,
      detail: { runId, action: proposal.action, stateVersion: args.stateVersion, taskId: task.taskId, attempt, basedOn: proposal.basedOn ?? [] },
    }, { tasks: [...(record.tasks ?? []), task] });
  }
  return { record, task, application: { runId, taskId: task.taskId, attempt } };
}

/** The Mission-owned context one Experiment instruction renders. */
export interface ExperimentInstructionContext {
  readonly objective: string;
  readonly outputs: readonly string[];
  readonly evaluation: { readonly method: string; readonly metric?: string };
  readonly hardRules: readonly string[];
  readonly network?: readonly string[];
  /** A brokered role context carries the rules; the prompt then points at it. */
  readonly brokered: boolean;
}

/**
 * The accepted decision rendered as the next Experiment's instructions. Text
 * only: the Run's authority still comes from the Task Contract and the sandbox.
 */
export function experimentInstructions(
  proposal: DirectorProposal,
  observations: DirectorInput["observations"],
  context: ExperimentInstructionContext,
): string {
  const evidence = observations.map((obs) => {
    const measured = obs.ok ? `measured score ${obs.score ?? "n/a"}` : `NOT ok${obs.ruleViolations?.length ? ` (${obs.ruleViolations.join("; ")})` : ""}${obs.error ? ` (${obs.error})` : ""}`;
    return `- ${obs.runId} [${obs.action}] ${measured}; refs: ${obs.evidenceRefs.join(", ") || "(none; dispatch failed)"}`;
  }).join("\n");
  const outputs = proposal.task?.expectedOutputs?.length ? proposal.task!.expectedOutputs : context.outputs;
  return [
    "You are executing the NEXT Experiment of one authorized evoK Mission, chosen by the Mission Director from measured evidence. Work only inside your isolated run workspace; it is the current working directory. This is a FRESH Run: prior sessions are not available, only the evidence summary below.",
    `Mission objective: ${context.objective}`,
    `Director action: ${proposal.action}. Rationale: ${proposal.rationale}`,
    `Task: ${proposal.task!.objective}`,
    `Required output artifacts: ${outputs.join(", ")}`,
    `Measured evidence so far (independent evaluator; durable refs live under this mission's runs dir):\n${evidence}`,
    context.evaluation.metric ? `The independent evaluator measures "${context.evaluation.method}" with metric ${context.evaluation.metric}.` : `The independent evaluator measures "${context.evaluation.method}".`,
    "Produce the real artifact files. Do NOT write a score file, do NOT self-report a score, do NOT claim success: an independent evaluator measures the immutable snapshot after you finish. Failed attempts are evidence, not results to hide.",
    context.brokered
      ? "Your competition rules for this role are in the ROLE CONTEXT block. No external submission is authorized."
      : `Hard rules: ${[...context.hardRules, "no external submission"].join("; ")}`,
    candidateNetworkInstruction(context.network),
    "Read-only project inspection is allowed; writes are confined to this workspace.",
  ].join("\n");
}
