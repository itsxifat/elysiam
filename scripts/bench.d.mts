/** Types for `bench.mjs`, the shared benchmark harness, for the benches written in TypeScript. */
export interface BenchResult {
  readonly name: string;
  readonly warmup: number;
  readonly samples: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
  readonly budgetMs: number | null;
  readonly withinBudget: boolean | null;
  readonly environment: Record<string, unknown>;
}

export function bench(options: {
  readonly name: string;
  readonly fn: () => unknown;
  readonly warmup?: number;
  readonly samples?: number;
  readonly budgetMs?: number;
}): Promise<BenchResult>;

export function formatResult(result: BenchResult): string;

export function writeResult(result: BenchResult): string;

export function percentile(sortedMs: readonly number[], fraction: number): number;
