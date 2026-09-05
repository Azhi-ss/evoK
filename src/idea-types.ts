/**
 * Idea typing registry for research diversity policy. Every plan-level or candidate-level idea
 * type must resolve to one of three base kinds: systems, algorithmic, or open-search. Extensions
 * (for example "systems:augmentation") are allowed but must be registered before use so that
 * diversity quotas can bucket them by base kind.
 */

export const IDEA_TYPE_KINDS = ["systems", "algorithmic", "open-search"] as const;
export type IdeaTypeKind = (typeof IDEA_TYPE_KINDS)[number];

const registry = new Map<string, IdeaTypeKind>(IDEA_TYPE_KINDS.map((kind) => [kind, kind]));

/** Registers an idea type extension under one of the three base kinds. */
export function registerIdeaType(type: string, kind: IdeaTypeKind): void {
  if (typeof type !== "string" || type.trim() === "") throw new TypeError("idea type must be a non-empty string");
  if (!(IDEA_TYPE_KINDS as readonly string[]).includes(kind)) throw new RangeError(`unknown idea type kind: ${String(kind)}`);
  const existing = registry.get(type);
  if (existing !== undefined && existing !== kind) {
    throw new RangeError(`idea type is already registered under a different base kind: ${type}`);
  }
  registry.set(type, kind);
}

/** Base kind for a registered idea type, or undefined when the type is not registered. */
export function ideaTypeKind(type: string): IdeaTypeKind | undefined {
  return registry.get(type);
}

/** Validates that a value is a registered idea type and returns it. */
export function requireIdeaType(value: unknown): string {
  if (typeof value !== "string" || ideaTypeKind(value) === undefined) {
    throw new TypeError(`idea type must be a registered idea type: ${String(value)}`);
  }
  return value;
}
