import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PiSubagentsProtocolError,
  probePiSubagentsEntryProtocol,
  probePiSubagentsProtocol,
  probePiSubagentsVersion,
  REQUIRED_PI_SUBAGENTS_VERSION,
  resolvePiSubagentsExtension,
} from "./pi-subagents-protocol";

async function install(manifest: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "evok-pi-subagents-"));
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  return dir;
}

test("a supported install negotiates once and reports the thinking-annotated model identity", () => {
  const protocol = probePiSubagentsProtocol(() => "0.84.0");
  expect(protocol.version).toBe("0.84.0");
  expect(protocol.modelIdentity("evok-meter-a/m", "max")).toBe("evok-meter-a/m:max");
  expect(probePiSubagentsProtocol(() => "0.86.1").version).toBe("0.86.1");
  expect(REQUIRED_PI_SUBAGENTS_VERSION).toBe("0.84");
});

test("an absent pi-subagents fails closed with a distinct error naming detected none and the required version", () => {
  const probe = () => probePiSubagentsProtocol(() => undefined);
  expect(probe).toThrow(PiSubagentsProtocolError);
  expect(probe).toThrow(/protocol unsupported/);
  expect(probe).toThrow(/detected none/);
  expect(probe).toThrow(/required >= 0\.84/);
});

test("a pre-0.84 install fails closed naming the detected and required versions", () => {
  const probe = () => probePiSubagentsProtocol(() => "0.79.1");
  expect(probe).toThrow(PiSubagentsProtocolError);
  expect(probe).toThrow(/detected 0\.79\.1/);
  expect(probe).toThrow(/required >= 0\.84/);
});

test("an unreadable version is unsupported rather than silently accepted", () => {
  expect(() => probePiSubagentsProtocol(() => "latest")).toThrow(/detected latest/);
});

test("the extension entry comes from the install's own manifest, not a hard-coded layout", async () => {
  const dir = await install({ version: "0.86.0", pi: { extensions: ["./bundle/index.js"] } });
  try {
    expect(probePiSubagentsVersion(dir)).toBe("0.86.0");
    expect(resolvePiSubagentsExtension(dir)).toBe(join(dir, "bundle", "index.js"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an explicitly launched extension entry negotiates that install's own protocol", async () => {
  const dir = await install({ version: "0.86.0", pi: { extensions: ["./bundle/index.js"] } });
  const old = await install({ version: "0.79.1", pi: { extensions: ["./bundle/index.js"] } });
  try {
    expect(probePiSubagentsEntryProtocol(join(dir, "bundle", "index.js")).version).toBe("0.86.0");
    expect(() => probePiSubagentsEntryProtocol(join(old, "bundle", "index.js"))).toThrow(
      /detected 0\.79\.1/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(old, { recursive: true, force: true });
  }
});

test("an install that declares no extension entry and no directory report nothing", async () => {
  const noEntry = await install({ version: "0.86.0" });
  const empty = await mkdtemp(join(tmpdir(), "evok-pi-subagents-empty-"));
  try {
    expect(probePiSubagentsVersion(noEntry)).toBe("0.86.0");
    expect(resolvePiSubagentsExtension(noEntry)).toBeUndefined();
    expect(probePiSubagentsVersion(empty)).toBeUndefined();
    expect(resolvePiSubagentsExtension(empty)).toBeUndefined();
    expect(() => probePiSubagentsProtocol(() => probePiSubagentsVersion(empty))).toThrow(/detected none/);
  } finally {
    await rm(noEntry, { recursive: true, force: true });
    await rm(empty, { recursive: true, force: true });
  }
});
