/**
 * Artifact collection, validation, content addressing and receipts (PRD §3 B2;
 * #253/#256).
 *
 * B2 splits one word into two owners. The harness **collects** what an
 * execution produced, **validates** that a receipt still addresses those bytes,
 * and **content-addresses** them; the Mission **adopts** — it decides whether
 * an artifact belongs to a Run and enters the Ledger. So nothing here writes a
 * ledger event, copies into durable storage, or decides an artifact is
 * evidence.
 *
 * The digest recipe is part of the contract, not an implementation detail:
 * every stored Run snapshot address is computed with it, so changing it
 * re-addresses history.
 */
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ArtifactProvenance } from "../execution/execution-protocol";
import type { ArtifactCollection, ArtifactFiles } from "./contracts";

const HEX_DIGEST = /^[0-9a-f]{64}$/;

/**
 * Collect a workspace as path -> text. Lexical walk, relative POSIX paths, and
 * only regular files: a symlink, socket or device is not a candidate artifact,
 * and following a symlink could collect a file from outside the workspace.
 */
export async function collectArtifacts(root: string): Promise<ArtifactFiles> {
  const files: ArtifactFiles = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else if (entry.isFile()) files[rel] = await readFile(full, "utf8");
    }
  }
  await walk(root, "");
  return files;
}

/** The content address: sorted paths and bytes, so walk order cannot change it. */
export function digestArtifacts(files: Readonly<ArtifactFiles>): string {
  const hash = createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files[name]!);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Collect, address and issue the receipt in one step. The producer is the
 * execution that ran in that workspace — the ledger decision to adopt this
 * receipt is the Mission's (B2), which is why this returns it instead of
 * recording it.
 */
export async function collectArtifactCollection(
  root: string,
  producer: string,
  parentExecutionId?: string,
): Promise<ArtifactCollection> {
  if (typeof producer !== "string" || producer.trim() === "")
    throw Error("artifact collection needs a producer: the execution that ran in that workspace");
  const files = await collectArtifacts(root);
  const receipt: ArtifactProvenance = {
    producer,
    ...(parentExecutionId === undefined ? {} : { parentExecutionId }),
    digest: digestArtifacts(files),
  };
  return { files, receipt: assertArtifactReceipt(receipt) };
}

/**
 * Validate a receipt: it must name a producer and a real content address, so a
 * receipt cannot be issued (or adopted) that addresses nothing.
 */
export function assertArtifactReceipt(receipt: ArtifactProvenance): ArtifactProvenance {
  if (typeof receipt?.producer !== "string" || receipt.producer.trim() === "")
    throw Error("artifact receipt producer must be a non-empty execution id");
  if (typeof receipt.digest !== "string" || !HEX_DIGEST.test(receipt.digest))
    throw Error("artifact receipt digest must be a sha256 content address");
  if (receipt.parentExecutionId !== undefined && receipt.parentExecutionId.trim() === "")
    throw Error("artifact receipt parentExecutionId must be a non-empty execution id when present");
  return receipt;
}
