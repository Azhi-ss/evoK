export function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

/** `--json` keeps the remainder of the raw string, including spaces. */
export function splitArgsPreservingJson(args: string): string[] {
  const trimmed = args.trim();
  if (trimmed === "") return [];
  const marker = "--json";
  const index = trimmed.indexOf(marker);
  if (index < 0) return trimmed.split(/\s+/);
  const head = trimmed.slice(0, index).trim();
  const tail = trimmed.slice(index + marker.length).trim();
  const headArgs = head === "" ? [] : head.split(/\s+/);
  return tail === "" ? [...headArgs, marker] : [...headArgs, marker, tail];
}
