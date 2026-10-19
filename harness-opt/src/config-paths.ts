import { HARNESS_PARTS, type HarnessPart } from "./types";

/**
 * Leaves the harness config actually stores. A patch key is legal only when
 * its normalized full path is one of these leaves. The list is walked from
 * this object; a segment named `id` is not rejected on its own.
 *
 * `search.*` is SearchGenes. `agent-loop.maxSteps` and `requireWrite` are
 * what the session, the empty run, and the sample bridge write.
 * `toolchain.checker`, `context.window`, and the skills leaves are the part
 * fields the closed loop already stores. `toolchain.tools.check.id` is the
 * nested check id.
 */
type ShapeNode = true | { readonly [key: string]: ShapeNode };

export const PART_CONFIG_SHAPE: Record<HarnessPart, ShapeNode> = {
  "agent-loop": { maxSteps: true, requireWrite: true },
  context: { window: true },
  memory: {},
  toolchain: {
    checker: true,
    tools: { check: { id: true } },
  },
  skills: {
    trigger: true,
    pack: true,
    selector: { weight: true, bias: true },
  },
};

const SEARCH_FIELDS = ["samples", "selfChecks", "retries"] as const;

function walk(node: ShapeNode, prefix: string, out: Set<string>): void {
  if (node === true) {
    out.add(prefix);
    return;
  }
  for (const key of Object.keys(node)) {
    walk(node[key] as ShapeNode, prefix === "" ? key : `${prefix}.${key}`, out);
  }
}

function buildWhitelist(): Set<string> {
  const out = new Set<string>();
  for (const part of HARNESS_PARTS) walk(PART_CONFIG_SHAPE[part], part, out);
  for (const field of SEARCH_FIELDS) out.add(`search.${field}`);
  return out;
}

/** Full paths: `skills.selector.weight`, `toolchain.tools.check.id`, `search.samples`. */
export const CONFIG_PATHS: ReadonlySet<string> = buildWhitelist();

export function isWhitelistedConfigPath(part: HarnessPart, relative: string): boolean {
  return CONFIG_PATHS.has(`${part}.${relative}`);
}

export function isWhitelistedConfigPrefix(part: HarnessPart, relative: string): boolean {
  const full = `${part}.${relative}.`;
  for (const path of CONFIG_PATHS) {
    if (path.startsWith(full)) return true;
  }
  return false;
}
