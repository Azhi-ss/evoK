import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { VerifiedAttestation } from "./attestation";

/**
 * Text the patched harness appends to the lead system prompt after it has
 * read the candidate config and hashed those bytes. Pi persists that prompt
 * as the system message `sections.preamble` in `.pi-sessions/*.jsonl`.
 */
export function candidateHashFragment(hash: string): string {
  return `\n\n### Loaded candidate config\ncandidateConfigHash: ${hash}\n`;
}

export interface ActivationInspection {
  readonly tracePath: string | null;
  readonly sessionFiles: readonly string[];
  readonly candidateConfigHash: string | null;
  readonly hashInSystemMessage: boolean;
  readonly effectiveKnob: unknown;
  readonly attestOk: boolean;
  readonly attestReasons: readonly string[];
  readonly active: boolean;
}

export interface AttestedActivationInput {
  readonly verified: VerifiedAttestation | null;
  readonly rejection?: readonly string[];
  readonly candidateSha: string;
  readonly controlSha: string;
  readonly knob: string;
  readonly knobValue: unknown;
  /** When false, a relay log did not show the mounted config hash on every request. */
  readonly relayPatchActive?: boolean;
}

/**
 * Activation evidence is the verified host attestation only.
 * The mounted config hash has to be the host candidate file, and an attested
 * Pi session system message has to contain that hash. Files named by the
 * executor, including `result.json`'s `session_file`, are not evidence.
 */
export function inspectAttestedActivation(input: AttestedActivationInput): ActivationInspection {
  const verified = input.verified;
  if (!verified) {
    return {
      tracePath: null,
      sessionFiles: [],
      candidateConfigHash: null,
      hashInSystemMessage: false,
      effectiveKnob: undefined,
      attestOk: false,
      attestReasons: input.rejection ?? ["missing"],
      active: false,
    };
  }
  const start = verified.tracePath ? readRunStart(verified.tracePath) : null;
  const hash = start && typeof start.candidateConfigHash === "string" ? start.candidateConfigHash : null;
  const effective = start?.effective;
  const effectiveKnob = effective && typeof effective === "object" && !Array.isArray(effective)
    ? (effective as Record<string, unknown>)[input.knob]
    : undefined;
  const fragment = candidateHashFragment(input.candidateSha).trim();
  const hashInSystemMessage = verified.sessionFiles.some((file) => systemMessageText(file).includes(fragment));
  const relayOk = input.relayPatchActive !== false;
  const active = relayOk
    && verified.mountedConfigSha === input.candidateSha
    && input.candidateSha !== ""
    && input.candidateSha !== input.controlSha
    && hash === input.candidateSha
    && hashInSystemMessage
    && input.knobValue !== undefined
    && sameValue(effectiveKnob, input.knobValue);
  return {
    tracePath: verified.tracePath,
    sessionFiles: verified.sessionFiles,
    candidateConfigHash: hash,
    hashInSystemMessage,
    effectiveKnob,
    attestOk: true,
    attestReasons: [],
    active,
  };
}

export function runStartConfigHash(tracePath: string): string | null {
  const start = readRunStart(tracePath);
  return start && typeof start.candidateConfigHash === "string" ? start.candidateConfigHash : null;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readRunStart(tracePath: string): { readonly candidateConfigHash?: unknown; readonly effective?: unknown } | null {
  let text: string;
  try {
    text = readFileSync(tracePath, "utf8");
  } catch {
    return null;
  }
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { type?: unknown; candidateConfigHash?: unknown; effective?: unknown };
      if (parsed.type === "run_start") return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function systemMessageText(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const message = entry && typeof entry === "object" ? (entry as { message?: unknown }).message : undefined;
    if (!message || typeof message !== "object") continue;
    const record = message as { role?: unknown; content?: unknown; sections?: unknown };
    if (record.role !== "system") continue;
    collectText(record.content, parts);
    if (record.sections && typeof record.sections === "object" && !Array.isArray(record.sections)) {
      for (const value of Object.values(record.sections as Record<string, unknown>)) collectText(value, parts);
    }
  }
  return parts.join("\n");
}

function collectText(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") parts.push(item);
    else if (item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string") {
      parts.push((item as { text: string }).text);
    }
  }
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
