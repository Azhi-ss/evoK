export function flag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

export function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}
