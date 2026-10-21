import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/**
 * Text the patched harness appends to the lead system prompt after it has
 * read the candidate config and hashed those bytes. Pi persists that prompt
 * as the system message `sections.preamble` in `.pi-sessions/*.jsonl`.
 */
export function candidateHashFragment(hash: string): string {
  return `\n\n### Loaded candidate config\ncandidateConfigHash: ${hash}\n`;
}

export interface ActivationInspection {
  readonly tracePath: string;
  readonly sessionFiles: readonly string[];
  readonly candidateConfigHash: string | null;
  readonly hashInSystemMessage: boolean;
  readonly effectiveKnob: unknown;
  readonly active: boolean;
}

export interface ActivationInput {
  readonly runDir: string;
  readonly tracePath: string;
  readonly candidateSha: string;
  readonly controlSha: string;
  readonly knob: string;
  readonly knobValue: unknown;
}

/**
 * Evidence is only what the executor wrote: the harness `run_start` fields and
 * a Pi session system message. A `systemPrompt` field on the trace is ignored.
 * Missing files, a hash the harness did not record, or a knob mismatch is inactive.
 */
export function inspectRunActivation(input: ActivationInput): ActivationInspection {
  const sessionFiles = listSessionFiles(input.runDir);
  const start = readRunStart(input.tracePath);
  const hash = start && typeof start.candidateConfigHash === "string" ? start.candidateConfigHash : null;
  const effective = start?.effective;
  const effectiveKnob = effective && typeof effective === "object" && !Array.isArray(effective)
    ? (effective as Record<string, unknown>)[input.knob]
    : undefined;
  const fragment = candidateHashFragment(input.candidateSha).trim();
  const hashInSystemMessage = sessionFiles.some((file) => systemMessageText(file).includes(fragment));
  const active = hash === input.candidateSha
    && input.candidateSha !== ""
    && input.candidateSha !== input.controlSha
    && hashInSystemMessage
    && input.knobValue !== undefined
    && sameValue(effectiveKnob, input.knobValue);
  return {
    tracePath: input.tracePath,
    sessionFiles,
    candidateConfigHash: hash,
    hashInSystemMessage,
    effectiveKnob,
    active,
  };
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readRunStart(tracePath: string): { readonly candidateConfigHash?: unknown; readonly effective?: unknown } | null {
  if (!existsSync(tracePath)) return null;
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

function listSessionFiles(runDir: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return;
    try {
      if (!statSync(file).isFile()) return;
    } catch {
      return;
    }
    seen.add(file);
    found.push(file);
  };
  walkSessions(join(runDir, ".pi-sessions"), add);
  const resultPath = join(runDir, "result.json");
  if (existsSync(resultPath)) {
    try {
      const parsed = JSON.parse(readFileSync(resultPath, "utf8")) as { session_file?: unknown };
      if (typeof parsed.session_file === "string" && parsed.session_file !== "") {
        add(isAbsolute(parsed.session_file) ? parsed.session_file : join(runDir, parsed.session_file));
      }
    } catch {
      /* a broken result.json is missing session evidence */
    }
  }
  return found;
}

function walkSessions(dir: string, add: (file: string) => void): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let linked;
    try {
      linked = lstatSync(full);
    } catch {
      continue;
    }
    if (linked.isSymbolicLink()) {
      try {
        const target = statSync(full);
        if (target.isFile() && name.endsWith(".jsonl")) add(full);
      } catch {
        continue;
      }
      continue;
    }
    if (linked.isDirectory()) {
      walkSessions(full, add);
      continue;
    }
    if (linked.isFile() && name.endsWith(".jsonl")) add(full);
  }
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

export function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
