import { Subject } from 'rxjs';
import {
  createDataFrame,
  DataQueryRequest,
  dateTime,
  FieldType,
  LoadingState,
  PanelData,
  QueryRunner,
  QueryRunnerOptions,
  TimeRange,
} from '@grafana/data';

import { MAX_QUERIES_PER_REQUEST, RunOutcome, SequentialRunner } from './sequential';

class FakeRunner implements QueryRunner {
  readonly data = new Subject<PanelData>();
  readonly runs: QueryRunnerOptions[] = [];
  readonly cancel = jest.fn();
  readonly destroy = jest.fn();

  get() {
    return this.data.asObservable();
  }

  run(options: QueryRunnerOptions) {
    this.runs.push(options);
  }

  /** Emits a response to the i-th run. */
  respond(i: number, state = LoadingState.Done, extra: Partial<PanelData> = {}) {
    const options = this.runs[i];
    const request = { targets: options.queries, range: options.timeRange } as unknown as DataQueryRequest;
    const series = options.queries.map((q) =>
      createDataFrame({ refId: q.refId, fields: [{ name: 'Value', type: FieldType.number, values: [1] }] })
    );
    this.data.next({
      state,
      series: state === LoadingState.Done ? series : [],
      timeRange: options.timeRange,
      request,
      ...extra,
    });
  }
}

const range = (from: number): TimeRange => {
  const f = dateTime(from);
  const t = dateTime(from + 3600_000);
  return { from: f, to: t, raw: { from: f, to: t } };
};

const options = (letters: string, timeRange = range(0)): QueryRunnerOptions => ({
  datasource: { type: 'prometheus', uid: 'ds' },
  queries: [...letters].map((refId) => ({ refId, expr: `up{q="${refId}"}` })),
  timeRange,
  timezone: 'utc',
  maxDataPoints: 100,
  minInterval: '60s',
});

describe('SequentialRunner', () => {
  let runner: FakeRunner;
  let outcomes: Array<RunOutcome<string>>;
  let seq: SequentialRunner<string>;

  beforeEach(() => {
    jest.useFakeTimers();
    runner = new FakeRunner();
    outcomes = [];
    seq = new SequentialRunner<string>(runner, (o) => outcomes.push(o), 30_000);
  });

  afterEach(() => {
    seq.destroy();
    jest.useRealTimers();
  });

  it('runs the queries in chunks one after another and merges the results', () => {
    seq.run('k1', 'plan', options('abcde'));
    expect(MAX_QUERIES_PER_REQUEST).toBe(3);
    expect(runner.runs.map((r) => r.queries.map((q) => q.refId).join(''))).toEqual(['abc']);
    expect(outcomes).toEqual([{ key: 'k1', tag: 'plan', loading: true }]);

    runner.respond(0, LoadingState.Loading);
    expect(runner.runs).toHaveLength(1);

    runner.respond(0);
    expect(runner.runs.map((r) => r.queries.map((q) => q.refId).join(''))).toEqual(['abc', 'de']);
    expect(outcomes).toHaveLength(1);

    runner.respond(1);
    const done = outcomes[1];
    expect(done).toMatchObject({ key: 'k1', tag: 'plan', loading: false });
    expect(done.data?.state).toBe(LoadingState.Done);
    expect(done.data?.series.map((s) => s.refId)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('ignores responses to an older request', () => {
    seq.run('k1', 'old', options('a'));
    seq.run('k2', 'new', options('b'));
    runner.respond(0);
    expect(outcomes.filter((o) => !o.loading)).toEqual([]);
    runner.respond(1);
    expect(outcomes[outcomes.length - 1]).toMatchObject({ key: 'k2', tag: 'new', loading: false });
  });

  it('tells requests for another time range apart', () => {
    seq.run('k1', 'p', options('a', range(0)));
    seq.run('k1', 'p', options('a', range(60_000)));
    runner.respond(0);
    expect(outcomes.filter((o) => !o.loading)).toEqual([]);
    runner.respond(1);
    expect(outcomes[outcomes.length - 1].data?.timeRange.from.valueOf()).toBe(60_000);
  });

  it('collects the errors of every chunk', () => {
    seq.run('k', 'p', options('abcd'));
    runner.respond(0, LoadingState.Error, { series: [], errors: [{ message: 'boom', refId: 'a' }] });
    runner.respond(1);
    const data = outcomes[outcomes.length - 1].data!;
    expect(data.errors).toEqual([{ message: 'boom', refId: 'a' }]);
    expect(data.state).toBe(LoadingState.Done);
    expect(data.series.map((s) => s.refId)).toEqual(['d']);
  });

  it('cancels a run that takes too long', () => {
    seq.run('k', 'p', options('a'));
    jest.advanceTimersByTime(30_000);
    expect(runner.cancel).toHaveBeenCalled();
    expect(outcomes[outcomes.length - 1]).toEqual({ key: 'k', tag: 'p', loading: false, timedOut: true });
    runner.respond(0);
    expect(outcomes).toHaveLength(2);
  });

  it('reports nothing after cancel', () => {
    seq.run('k', 'p', options('a'));
    seq.cancel();
    expect(runner.cancel).toHaveBeenCalled();
    runner.respond(0);
    jest.advanceTimersByTime(60_000);
    expect(outcomes).toHaveLength(1);
  });

  it('finishes at once without queries', () => {
    seq.run('k', 'p', options(''));
    expect(runner.runs).toEqual([]);
    expect(outcomes).toEqual([
      { key: 'k', tag: 'p', loading: false, data: expect.objectContaining({ state: LoadingState.Done, series: [] }) },
    ]);
  });

  it('destroys the Grafana runner', () => {
    seq.destroy();
    expect(runner.destroy).toHaveBeenCalled();
  });
});
