import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { assertNoCredentials, ChildRecordSecretError, redactedRecord, redactCredentials } from "./pi-child-records";

const secret = "sk-live-0123456789abcdef0123456789";

test("no provider config, API key or tool token may be persisted in a child record", () => {
  const refused: unknown[] = [
    { provider: { alias: "evok-meter-child", config: { apiKey: secret } } },
    { providerConfig: { baseUrl: "http://127.0.0.1:8642" } },
    { toolServer: { url: "http://127.0.0.1:9000", key: secret } },
    { registration: { definition: { apiKey: secret } } },
    { params: { headers: { Authorization: "Bearer " + secret } } },
    { action: { args: { summary: "use " + secret } } },
  ];
  for (const record of refused)
    expect(() => assertNoCredentials(record, "receipt")).toThrow(ChildRecordSecretError);
  // A receipt that only carries the approved shapes still round-trips.
  expect(() =>
    assertNoCredentials(
      { nativeRunId: randomUUID(), action: { name: "evok_deliver", args: { summary: "阶段发现就绪" } } },
      "receipt",
    ),
  ).not.toThrow();
  expect(redactCredentials('{"error":"401 for ' + secret + '"}')).toBe('{"error":"401 for [redacted]"}');
  // A diagnostic record is redacted, and a structural leak left over is still refused.
  expect(redactedRecord({ error: "401 for " + secret }, "started")).toEqual({ error: "401 for [redacted]" });
  expect(() => redactedRecord({ provider: { apiKey: secret } }, "started")).toThrow(ChildRecordSecretError);
});
