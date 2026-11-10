/** Durable child launch/fence/receipt records never carry credentials (C6).
 * Provider configs, API keys and tool tokens stay in memory: a structured record
 * is refused outright if it holds one, while free-text diagnostics are redacted
 * so a failed launch still leaves usable, secret-free evidence. The caller
 * writes the record itself; this module only decides what may be persisted.
 */
const SECRET_KEY =
  /^(?:api[-_]?key|authorization|bearer|token|access[-_]?token|refresh[-_]?token|secret|password|provider|providers|providerConfig|tool[-_]?server)$/i;
const SECRET_TEXT = /\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}=*)/g;

export class ChildRecordSecretError extends Error {
  constructor(label: string) {
    super("refusing to persist a child record with credentials: " + label);
    this.name = "ChildRecordSecretError";
  }
}

/** Throw before the write if a record would carry a provider config, key or token. */
export function assertNoCredentials(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (value.match(SECRET_TEXT)) throw new ChildRecordSecretError(label);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoCredentials(item, label);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new ChildRecordSecretError(label + " (" + key + ")");
    assertNoCredentials(item, label);
  }
}

/** Diagnostics keep their meaning but lose any credential-shaped text. */
export function redactCredentials(text: string): string {
  return text.replace(SECRET_TEXT, "[redacted]");
}

/** The one recipe for a persisted record built from free text: redact, then
 * still refuse if a provider config or token shape survived. */
export function redactedRecord(value: unknown, label: string): unknown {
  const record: unknown = JSON.parse(redactCredentials(JSON.stringify(value ?? null)));
  assertNoCredentials(record, label);
  return record;
}
