import { Subscription } from 'rxjs';
import {
  DataFrame,
  DataQueryError,
  DataQueryRequest,
  dateTime,
  LoadingState,
  PanelData,
  QueryRunner,
  QueryRunnerOptions,
  TimeRange,
} from '@grafana/data';
import type { DataQuery } from '@grafana/schema';

/** At most this many queries go into one request, so one explorer never loads the backend with more. */
export const MAX_QUERIES_PER_REQUEST = 3;
export const REQUEST_TIMEOUT_MS = 30_000;

export interface RunOutcome<T> {
  key: string;
  tag: T;
  loading: boolean;
  /** All chunks merged; set once the run finished. */
  data?: PanelData;
  timedOut?: boolean;
}

interface CurrentRun<T> {
  key: string;
  tag: T;
  timeRange: TimeRange;
  chunks: QueryRunnerOptions[];
  index: number;
  series: DataFrame[];
  errors: DataQueryError[];
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Runs one explorer request through a single Grafana QueryRunner, split into chunks of at most
 * MAX_QUERIES_PER_REQUEST queries over at most one slice of the time range that run one after another. A new run
 * cancels the previous one; a run whose request is still loading after REQUEST_TIMEOUT_MS is cancelled.
 */
export class SequentialRunner<T> {
  private current?: CurrentRun<T>;
  private readonly sub: Subscription;

  constructor(
    private readonly runner: QueryRunner,
    private readonly listener: (outcome: RunOutcome<T>) => void,
    private readonly timeoutMs = REQUEST_TIMEOUT_MS
  ) {
    this.sub = runner.get().subscribe((data) => this.onData(data));
  }

  /** Runs `options`, a range longer than `sliceMs` in slices of that length. */
  run(key: string, tag: T, options: QueryRunnerOptions, sliceMs = Infinity): void {
    this.stop();
    const chunks = chunkOptions(options, sliceMs);
    if (chunks.length === 0) {
      this.listener({ key, tag, loading: false, data: emptyData(options.timeRange) });
      return;
    }
    const run: CurrentRun<T> = { key, tag, timeRange: options.timeRange, chunks, index: 0, series: [], errors: [] };
    this.current = run;
    this.listener({ key, tag, loading: true });
    this.send(run);
  }

  /** Stops the current run; nothing is reported for it any more. */
  cancel(): void {
    if (this.current) {
      this.stop();
      this.runner.cancel();
    }
  }

  destroy(): void {
    this.stop();
    this.sub.unsubscribe();
    this.runner.destroy();
  }

  private stop(): void {
    if (this.current?.timer) {
      clearTimeout(this.current.timer);
    }
    this.current = undefined;
  }

  private onData(data: PanelData): void {
    const run = this.current;
    if (!run || data.state === LoadingState.Loading || data.state === LoadingState.NotStarted) {
      return;
    }
    // The runner may still deliver an older request (e.g. one started before the datasource resolved).
    const chunk = run.chunks[run.index];
    if (!data.request || requestSignature(data.request) !== optionsSignature(chunk)) {
      return;
    }
    run.series.push(...data.series);
    run.errors.push(...(data.errors ?? []));
    run.index++;
    if (run.index < run.chunks.length) {
      this.send(run);
      return;
    }
    this.stop();
    this.listener({
      key: run.key,
      tag: run.tag,
      loading: false,
      data: {
        ...data,
        state: run.errors.length > 0 && run.series.length === 0 ? LoadingState.Error : LoadingState.Done,
        series: run.series,
        errors: run.errors.length > 0 ? run.errors : undefined,
        timeRange: run.timeRange,
      },
    });
  }

  private send(run: CurrentRun<T>): void {
    clearTimeout(run.timer);
    run.timer = setTimeout(() => this.timeout(run), this.timeoutMs);
    this.runner.run(run.chunks[run.index]);
  }

  private timeout(run: CurrentRun<T>): void {
    if (this.current !== run) {
      return;
    }
    this.stop();
    this.runner.cancel();
    this.listener({ key: run.key, tag: run.tag, loading: false, timedOut: true });
  }
}

function chunkOptions(options: QueryRunnerOptions, sliceMs: number): QueryRunnerOptions[] {
  const chunks: QueryRunnerOptions[] = [];
  for (const timeRange of slices(options.timeRange, sliceMs)) {
    for (let i = 0; i < options.queries.length; i += MAX_QUERIES_PER_REQUEST) {
      chunks.push({ ...options, timeRange, queries: options.queries.slice(i, i + MAX_QUERIES_PER_REQUEST) });
    }
  }
  return chunks;
}

/**
 * The range cut every `sliceMs` from its start. With `sliceMs` a multiple of the step, the datasource aligns the end
 * of a slice and the start of the next to the same timestamp, so the slices meet without a gap.
 */
function slices(range: TimeRange, sliceMs: number): TimeRange[] {
  const from = range.from.valueOf();
  const to = range.to.valueOf();
  if (!(to - from > sliceMs)) {
    return [range];
  }
  const out: TimeRange[] = [];
  for (let start = from; start < to; start += sliceMs) {
    const f = dateTime(start);
    const t = dateTime(Math.min(start + sliceMs, to));
    out.push({ from: f, to: t, raw: { from: f, to: t } });
  }
  return out;
}

function emptyData(timeRange: TimeRange): PanelData {
  return { state: LoadingState.Done, series: [], timeRange };
}

function signature(queries: DataQuery[], range: TimeRange): string {
  const parts = queries.map((q) => `${q.refId}\u0000${(q as DataQuery & { expr?: string }).expr ?? ''}`);
  return `${range.from.valueOf()}-${range.to.valueOf()}\u0001${parts.join('\u0001')}`;
}

function optionsSignature(options: QueryRunnerOptions): string {
  return signature(options.queries, options.timeRange);
}

function requestSignature(request: DataQueryRequest): string {
  return signature(request.targets, request.range);
}
