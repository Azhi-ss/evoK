/** Four usage counters. A missing counter is zero; it is not dropped from the sum. */
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

/** input + output + cacheRead + cacheWrite. */
export function usageTokens(usage: Partial<UsageParts> | null | undefined): number {
  const parts = usageParts(usage);
  return parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
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
