/**
 * Local-run and daily-submit budget. Port of `design/orchestrator.py` `Budget`.
 * `submitGate` does not increment `submits`; the caller records a real submit.
 */

export interface BudgetOptions {
  readonly maxLocalRuns?: number;
  readonly maxTokens?: number;
  readonly maxWallS?: number;
  readonly maxOnlineSubmitsPerDay?: number;
  readonly now?: () => number;
}

export class Budget {
  maxLocalRuns: number;
  maxTokens: number;
  maxWallS: number;
  maxOnlineSubmitsPerDay: number;
  usedRuns = 0;
  usedTokens = 0;
  started: number;
  submits: Record<string, number> = {};
  private readonly now: () => number;

  constructor(options: BudgetOptions = {}) {
    this.maxLocalRuns = options.maxLocalRuns ?? 200;
    this.maxTokens = options.maxTokens ?? 5_000_000;
    this.maxWallS = options.maxWallS ?? 8 * 3600;
    this.maxOnlineSubmitsPerDay = options.maxOnlineSubmitsPerDay ?? 1;
    this.now = options.now ?? (() => Date.now() / 1000);
    this.started = this.now();
  }

  canRun(estTokens = 0): boolean {
    return this.usedRuns < this.maxLocalRuns
      && this.usedTokens + estTokens <= this.maxTokens
      && this.now() - this.started < this.maxWallS;
  }

  canSubmit(day: string): boolean {
    return (this.submits[day] ?? 0) < this.maxOnlineSubmitsPerDay;
  }
}
