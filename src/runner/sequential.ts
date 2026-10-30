import { Subscription } from 'rxjs';
import {
  DataFrame,
  DataQueryError,
  DataQueryRequest,
  LoadingState,
  PanelData,
  QueryRunner,
  QueryRunnerOptions,
  TimeRange,
} from '@grafana/data';
import type { DataQuery } from '@grafana/schema';

/** At most this many queries go into one request, so one explorer never loads the backend with more. */
export const MAX_QUERIES_PER_REQUEST = 3;
export const RUN_TIMEOUT_MS = 30_000;

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
  chunks: QueryRunnerOptions[];
  index: number;
  series: DataFrame[];
  errors: DataQueryError[];
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Runs one explorer request through a single Grafana QueryRunner, split into chunks of at most
 * MAX_QUERIES_PER_REQUEST queries that run one after another. A new run cancels the previous one; a
 * run still loading after RUN_TIMEOUT_MS is cancelled.
 */
export class SequentialRunner<T> {
  private current?: CurrentRun<T>;
  private readonly sub: Subscription;

  constructor(
    private readonly runner: QueryRunner,
    private readonly listener: (outcome: RunOutcome<T>) => void,
    private readonly timeoutMs = RUN_TIMEOUT_MS
  ) {
    this.sub = runner.get().subscribe((data) => this.onData(data));
  }

  run(key: string, tag: T, options: QueryRunnerOptions): void {
    this.stop();
    const chunks = chunkOptions(options);
    if (chunks.length === 0) {
      this.listener({ key, tag, loading: false, data: emptyData(options.timeRange) });
      return;
    }
    const run: CurrentRun<T> = { key, tag, chunks, index: 0, series: [], errors: [] };
    run.timer = setTimeout(() => this.timeout(run), this.timeoutMs);
    this.current = run;
    this.listener({ key, tag, loading: true });
    this.runner.run(chunks[0]);
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
      this.runner.run(run.chunks[run.index]);
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
        timeRange: chunk.timeRange,
      },
    });
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

function chunkOptions(options: QueryRunnerOptions): QueryRunnerOptions[] {
  const chunks: QueryRunnerOptions[] = [];
  for (let i = 0; i < options.queries.length; i += MAX_QUERIES_PER_REQUEST) {
    chunks.push({ ...options, queries: options.queries.slice(i, i + MAX_QUERIES_PER_REQUEST) });
  }
  return chunks;
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
