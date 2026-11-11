---
name: charter
description: Bind pre-Mission research scoping to evoK's charter schema, ledger events and frozen protocol rules. Use when proposing, approving, freezing, or amending a Research Charter inside an evoK project.
owner: evok
namespace: evok
state: candidate
category: intake
---

# Charter

Bind the **pre-Mission research scoping procedure** to this repository's contract. The
procedure itself — how to scope literature, choose baselines, propose an evaluation
protocol — lives in the global `evok-charter` skill. This file says what an evoK project
requires of the result.

This skill is instruction only. Loading L0 or L1 is not authorization to start,
continue, or submit. A charter, an approval, or a frozen protocol is not a Mission
launch. Chat is not authority. Do not dispatch work from this text. This skill does not
relax Admission, Budget, hang, T48, or Promotion predicates.

Authoring language of this skill is English. **Respond in the user's language** unless
the user asks otherwise. Keep code identifiers, tool names, file paths, and metric names
exactly as written.

## Schema authority stays in the repo

The charter record is **`evok.research-charter/v1`**. The schema, its field validation and
its versioning live in `src/mission/research-charter.ts` (C1, #250) — that code is the
authority. If that module is not present in your checkout, say so instead of restating
fields from memory.

- Reference the schema id. **Do not restate, extend, or re-derive its fields** from this
  skill, from a global skill, or from conversation. If the field list matters, read the
  schema.
- A breaking change to the schema requires a **new version id and a migration note**. Do
  not edit v1 in place to mean something new.
- Editing a globally installed skill must never be able to break evoK parsing at runtime.
  That is why the procedure is global and the contract is here.

## Ledger events, not a document store

Four events, nothing more, initially:

| Event | Records |
|---|---|
| `RESEARCH_CHARTER_PROPOSED` | charter version, artifact refs, schema id |
| `RESEARCH_CHARTER_APPROVED` | human authorization, approved version |
| `BENCHMARK_PROTOCOL_FROZEN` | frozen protocol version and digest |
| `BENCHMARK_EXTENSION_ADDED` | a later comparator added without altering the frozen set |

Full charter text, literature evidence and reproduction material stay in **referenced
Mission artifacts**. The ledger records versions, approvals and references; it is not a
document store. Do not paste a charter body or a reading list into an event.

## Freezing and amendment

1. **Propose, then approve.** The agent proposes the protocol; a human approves that
   proposal. Human approval is never a request to hand-pick baseline papers — operator
   papers are input, not the portfolio; if the human starts listing papers, the scoping
   work has not been done and the proposal goes back to the agent.
2. **Freeze before results exist.** `BENCHMARK_PROTOCOL_FROZEN` happens before the first
   experiment of the study. An evaluation decision made after seeing results is not a
   frozen protocol.
3. **Amend by new version.** Changing the primary protocol creates a **new protocol
   version** with a recorded reason. Prior results are never re-scored under the new
   version and never overwritten.
4. **Extend, do not replace.** Newer work may be added as a supplementary comparator via
   `BENCHMARK_EXTENSION_ADDED`. It never silently replaces the frozen baseline set or the
   frozen protocol.

## Conclusions the charter may and may not draw

- Every claim carries its evidence class: **published claim**, **independently reproduced
  result**, **agent hypothesis**, or **unverified assumption**. An inferred research gap
  is never presented as established fact; source it or label it.
- `no_go_recommended` with evidence is a **successful** scoping outcome, not a failed
  one. Nothing is authorized by it.
- **Ambition never enters termination or convergence conditions.** It sets how strong the
  baselines and controls must be. It must not suppress abandonment.

## Context discipline

- **No new agent role.** The existing agent runs the scoping skill.
- **No full-charter or full-literature injection into the Director.** The Director gets a
  compact summary: objective, ambition, current stage goal, relevant baselines, current
  protocol version, open questions.
- **Artifacts over context.** Full documents stay in artifacts and are pulled only when a
  node needs them.
- **No vector store, no embeddings, no retrieval-attention subsystem.**

## Handoff

The charter is the input to a Research Program; it does not run one. Mission start
authorization is a separate, explicit human action owned elsewhere. Confirm the proposal
was reviewed and approved, record the events and versions, cite the artifacts — then stop.

## Pilot

The procedure is unproven until the NOSE pilot in `docs/research-charter-prd.md` §11 has
been run and judged. This skill ships as `candidate` until then.
