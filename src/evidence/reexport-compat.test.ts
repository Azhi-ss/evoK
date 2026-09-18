/**
 * ET-A1 compatibility seam: `src/evidence/` implementations and the flat
 * `src/*.ts` re-exports must stay isomorphic. Gate three-state literals
 * here are independent of the moved module bodies.
 */
import { describe, expect, test } from "bun:test";
import * as acceptanceFlat from "../methodology-acceptance";
import * as acceptancePacked from "./methodology-acceptance";
import * as contractsFlat from "../methodology-contracts";
import * as contractsPacked from "./methodology-contracts";
import * as hangFlat from "../kill-test-hang";
import * as hangPacked from "./kill-test-hang";
import * as kindsFlat from "../ledger-kinds";
import * as kindsPacked from "./ledger-kinds";
import * as ladderFlat from "../validation-ladder";
import * as ladderPacked from "./validation-ladder";
import * as ledgerFlat from "../hypothesis-ledger";
import * as ledgerPacked from "./hypothesis-ledger";
import * as methodologyFlat from "../methodology";
import * as methodologyPacked from "./methodology";
import * as brokerFlat from "../submission-broker";
import * as brokerPacked from "./submission-broker";
import * as gatesFlat from "../verification-gates";
import * as gatesPacked from "./verification-gates";

const DIGEST = "sha256:toy-split-ref-v1";
const OTHER_DIGEST = "sha256:different-split";

function runtimeKeys(mod: object): string[] {
  return Object.keys(mod).sort();
}

function expectSameRuntimeSurface(flat: object, packed: object): void {
  expect(runtimeKeys(flat)).toEqual(runtimeKeys(packed));
  for (const key of runtimeKeys(flat)) {
    expect((packed as Record<string, unknown>)[key]).toBe((flat as Record<string, unknown>)[key]);
  }
}

describe("evidence pack re-export isomorphism", () => {
  test("flat src/*.ts re-exports the same runtime bindings as src/evidence/", () => {
    expectSameRuntimeSurface(ledgerFlat, ledgerPacked);
    expectSameRuntimeSurface(hangFlat, hangPacked);
    expectSameRuntimeSurface(methodologyFlat, methodologyPacked);
    expectSameRuntimeSurface(contractsFlat, contractsPacked);
    expectSameRuntimeSurface(acceptanceFlat, acceptancePacked);
    expectSameRuntimeSurface(gatesFlat, gatesPacked);
    expectSameRuntimeSurface(ladderFlat, ladderPacked);
    expectSameRuntimeSurface(brokerFlat, brokerPacked);
    expectSameRuntimeSurface(kindsFlat, kindsPacked);
  });

  test("gate three-state is identical through flat and evidence/ imports", () => {
    const contracts = methodologyFlat.resolveMethodologyContracts({
      splitContract: { splitRef: { digest: DIGEST } },
      oofEnsemble: { required: true },
    });
    const sleepEvidence = { splitDigestAgreement: "unknown" as const, oofPresent: false };
    const missingEvidence = {
      splitRefDigest: OTHER_DIGEST,
      splitDigestAgreement: "disagree" as const,
      oofPresent: false,
    };
    const passEvidence = {
      splitRefDigest: DIGEST,
      splitDigestAgreement: "agree" as const,
      oofPresent: true,
    };

    expect(methodologyFlat.auditMethodology(sleepEvidence).ok).toBe(true);
    expect(methodologyPacked.auditMethodology(sleepEvidence).ok).toBe(true);
    expect(methodologyFlat.oofEnsembleGate(sleepEvidence).ok).toBe(true);
    expect(methodologyPacked.oofEnsembleGate(sleepEvidence).ok).toBe(true);

    expect(methodologyFlat.auditMethodology(missingEvidence, contracts).ok).toBe(false);
    expect(methodologyPacked.auditMethodology(missingEvidence, contracts).ok).toBe(false);
    expect(methodologyFlat.oofEnsembleGate(missingEvidence, contracts).ok).toBe(false);
    expect(methodologyPacked.oofEnsembleGate(missingEvidence, contracts).ok).toBe(false);

    expect(methodologyFlat.auditMethodology(passEvidence, contracts).ok).toBe(true);
    expect(methodologyPacked.auditMethodology(passEvidence, contracts).ok).toBe(true);
    expect(methodologyFlat.oofEnsembleGate(passEvidence, contracts).ok).toBe(true);
    expect(methodologyPacked.oofEnsembleGate(passEvidence, contracts).ok).toBe(true);
  });
});
