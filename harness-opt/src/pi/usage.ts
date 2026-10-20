/** Four usage counters. A missing counter is zero. The total counts input, output, and cacheRead. */
export interface UsageParts {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export const EMPTY_USAGE: UsageParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function usageParts(usage: Partial<UsageParts> | null | undefined): UsageParts {
  return {
    input: finite(usage?.input),
    output: finite(usage?.output),
    cacheRead: finite(usage?.cacheRead),
    cacheWrite: finite(usage?.cacheWrite),
  };
}

/** input + output + cacheRead. cacheWrite stays on the record and is not added. */
export function usageTokens(usage: Partial<UsageParts> | null | undefined): number {
  const parts = usageParts(usage);
  return parts.input + parts.output + parts.cacheRead;
}

export function addUsage(total: UsageParts, usage: Partial<UsageParts> | null | undefined): UsageParts {
  const parts = usageParts(usage);
  return {
    input: total.input + parts.input,
    output: total.output + parts.output,
    cacheRead: total.cacheRead + parts.cacheRead,
    cacheWrite: total.cacheWrite + parts.cacheWrite,
  };
}
