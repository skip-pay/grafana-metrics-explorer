import { act, renderHook } from '@testing-library/react';
import { Subject } from 'rxjs';
import { DataQueryRequest, dateTime, LoadingState, PanelData, QueryRunnerOptions, TimeRange } from '@grafana/data';

import { compile, CompileContext, CompiledPlan } from '../compile';
import { buildCharts, evaluate } from '../engine';
import { defaultState } from '../model/defaults';
import { ExplorerState, MetricQuery, ResolvedMetric } from '../model/types';
import { DEBOUNCE_MS, useExplorerData } from './index';

const mockRunner = {
  runs: [] as QueryRunnerOptions[],
  data: new Subject<PanelData>(),
  cancel: jest.fn(),
};
const mockCatalog = { resolve: jest.fn(), getMetric: jest.fn(), labelValues: jest.fn() };

jest.mock('@grafana/runtime', () => ({
  createQueryRunner: () => ({
    get: () => mockRunner.data.asObservable(),
    run: (options: QueryRunnerOptions) => mockRunner.runs.push(options),
    cancel: () => mockRunner.cancel(),
    destroy: () => {},
  }),
}));
jest.mock('@grafana/ui', () => ({ useTheme2: () => ({ isDark: false }) }));
jest.mock('../catalog', () => ({ getCatalog: () => mockCatalog }));
jest.mock('../compile', () => ({ compile: jest.fn(), GROUP_LIMIT: 200 }));
jest.mock('../engine', () => ({ evaluate: jest.fn(), buildCharts: jest.fn() }));

const compileMock = compile as jest.Mock;
const evaluateMock = evaluate as jest.Mock;
const buildChartsMock = buildCharts as jest.Mock;

const resolved = (name: string): ResolvedMetric => ({
  name,
  kind: 'gauge',
  streams: { base: name },
  temporality: { delta: false, cumulative: false },
  labelKeys: ['host'],
  hasInstanceId: false,
  nativeIntervalSec: 60,
});

/** A stand-in compiler: one `avg(<metric>)` per query with a metric; grouped ones get a capped variant. */
function fakeCompile(state: ExplorerState, ctx: CompileContext): CompiledPlan {
  const tooLong = ctx.range.to - ctx.range.from > 24 * 3600_000;
  return {
    stepSec: 60,
    queries: state.queries
      .filter((q) => q.metric !== '')
      .map((q) => ({
        letter: q.letter,
        refId: q.letter,
        expr: ctx.metrics[q.metric] ? `avg(${q.metric}${q.groupBy.length ? ` by ${q.groupBy}` : ''})` : '',
        stepSec: 60,
        windowSec: 60,
        clientChain: [],
        textForm: `avg:${q.metric}{*}`,
        warnings: [],
        groupBy: q.groupBy,
        ...(q.groupBy.length ? { cappedExpr: `capped(${q.metric})` } : {}),
        skip: ctx.metrics[q.metric] ? undefined : 'unknown metric',
      })),
    formulas: [],
    title: 'title',
    errors: tooLong ? ['Time range is limited to 24 h'] : [],
  };
}

const range = (from: number, hours = 1): TimeRange => {
  const f = dateTime(from);
  const t = dateTime(from + hours * 3600_000);
  return { from: f, to: t, raw: { from: f, to: t } };
};

const stateWith = (...queries: Array<Partial<MetricQuery>>): ExplorerState => {
  const base = defaultState();
  return {
    ...base,
    queries: queries.map((q, i) => ({ ...base.queries[0], id: `q${i}`, letter: 'abc'[i], ...q })),
  };
};

const respond = (i: number) => {
  const options = mockRunner.runs[i];
  const request = { targets: options.queries, range: options.timeRange } as unknown as DataQueryRequest;
  act(() => mockRunner.data.next({ state: LoadingState.Done, series: [], timeRange: options.timeRange, request }));
};

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  });

describe('useExplorerData', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockRunner.runs = [];
    mockRunner.cancel.mockClear();
    mockCatalog.resolve.mockReset().mockImplementation((name: string) => Promise.resolve(resolved(name)));
    mockCatalog.getMetric.mockReset().mockResolvedValue(undefined);
    mockCatalog.labelValues.mockReset().mockResolvedValue(['x', 'y']);
    compileMock.mockReset().mockImplementation(fakeCompile);
    evaluateMock.mockReset().mockReturnValue({ seriesByRow: {}, rowErrors: {}, warnings: [] });
    buildChartsMock.mockReset().mockReturnValue([{ title: 'chart' }]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const args = (timeRange = range(0)) => ({
    datasourceUid: 'ds',
    timeRange,
    timeZone: 'utc',
    widthPx: 800,
    maxRangeHours: 24,
  });

  it('runs nothing until a query has a metric', async () => {
    const { result } = renderHook(() => useExplorerData(defaultState(), args()));
    await flush();
    act(() => jest.runAllTimers());
    expect(mockRunner.runs).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.charts).toEqual([]);
  });

  it('resolves the metrics, then runs the compiled queries at once', async () => {
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }), args()));
    // Resolving the metric already counts as loading, so the chart never reads "No data" meanwhile.
    expect(result.current.loading).toBe(true);
    await flush();
    expect(mockCatalog.resolve).toHaveBeenCalledWith('cpu', { from: 0, to: 3600_000 });
    expect(result.current.resolved.cpu?.labelKeys).toEqual(['host']);
    expect(result.current.loading).toBe(true);
    act(() => jest.advanceTimersByTime(0));
    expect(mockRunner.runs).toHaveLength(1);
    expect(mockRunner.runs[0]).toMatchObject({
      datasource: { type: 'prometheus', uid: 'ds' },
      maxDataPoints: 62,
      minInterval: '60s',
      timezone: 'utc',
      queries: [
        {
          refId: 'a',
          expr: 'avg(cpu)',
          range: true,
          instant: false,
          interval: '60s',
          legendFormat: '__auto',
          datasource: { type: 'prometheus', uid: 'ds' },
        },
      ],
    });

    respond(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.charts).toEqual([{ title: 'chart' }]);
    expect(evaluateMock).toHaveBeenCalledWith(
      result.current.plan,
      expect.objectContaining({ state: LoadingState.Done }),
      expect.anything(),
      { cpu: resolved('cpu') }
    );
  });

  it('debounces edits and keeps showing the previous charts meanwhile', async () => {
    const { result, rerender } = renderHook(({ state }) => useExplorerData(state, args()), {
      initialProps: { state: stateWith({ metric: 'cpu' }) },
    });
    await flush();
    act(() => jest.advanceTimersByTime(0));
    respond(0);

    rerender({ state: stateWith({ metric: 'cpu', groupBy: ['host'] }) });
    expect(result.current.loading).toBe(true);
    expect(result.current.charts).toEqual([{ title: 'chart' }]);
    // The group estimate arrives first.
    await flush();
    expect(result.current.loading).toBe(true);
    act(() => jest.advanceTimersByTime(DEBOUNCE_MS - 1));
    expect(mockRunner.runs).toHaveLength(1);
    act(() => jest.advanceTimersByTime(1));
    expect(mockRunner.runs).toHaveLength(2);
    expect(mockRunner.runs[1].queries[0]).toMatchObject({ expr: 'avg(cpu by host)' });
  });

  it('estimates groups from the label values and caps a query above the limit', async () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    mockCatalog.labelValues.mockImplementation((_m, key: string) =>
      Promise.resolve(values(key === 'host' ? 30 : key === 'path' ? 10 : 3))
    );
    const state = stateWith(
      { metric: 'cpu', groupBy: ['host', 'path'], filters: [{ key: 'env', op: 'eq', values: ['prod'] }] },
      { metric: 'mem', groupBy: ['env'] }
    );
    const { result } = renderHook(() => useExplorerData(state, args()));
    await flush();
    act(() => jest.advanceTimersByTime(0));
    expect(mockCatalog.labelValues).toHaveBeenCalledWith(
      resolved('cpu'),
      'host',
      [{ key: 'env', op: 'eq', values: ['prod'] }],
      { from: 0, to: 3600_000 }
    );
    expect(mockRunner.runs[0].queries.map((q) => (q as unknown as { expr: string }).expr)).toEqual([
      'capped(cpu)',
      'avg(mem by env)',
    ]);
    expect(result.current.rowMessages).toEqual({ a: ['Showing the top 200 of ≈300 groups'] });
  });

  it('runs a grouped query uncapped when its estimate fails', async () => {
    mockCatalog.labelValues.mockRejectedValue(new Error('500'));
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu', groupBy: ['host'] }), args()));
    await flush();
    act(() => jest.advanceTimersByTime(0));
    expect(mockRunner.runs[0].queries).toMatchObject([{ expr: 'avg(cpu by host)' }]);
    expect(result.current.rowMessages).toEqual({});
  });

  it('does not re-run for changes that keep the PromQL', async () => {
    const { rerender } = renderHook(({ state }) => useExplorerData(state, args()), {
      initialProps: { state: stateWith({ metric: 'cpu' }) },
    });
    await flush();
    act(() => jest.advanceTimersByTime(0));
    respond(0);
    const evaluations = evaluateMock.mock.calls.length;

    rerender({ state: { ...stateWith({ metric: 'cpu', alias: 'CPU' }), viz: 'toplist' } });
    act(() => jest.runAllTimers());
    expect(mockRunner.runs).toHaveLength(1);
    expect(evaluateMock.mock.calls.length).toBeGreaterThan(evaluations);
  });

  it('re-runs at once when the time range changes', async () => {
    const state = stateWith({ metric: 'cpu' });
    const { rerender } = renderHook(({ timeRange }) => useExplorerData(state, args(timeRange)), {
      initialProps: { timeRange: range(0) },
    });
    await flush();
    act(() => jest.advanceTimersByTime(0));
    respond(0);
    rerender({ timeRange: range(60_000) });
    act(() => jest.advanceTimersByTime(0));
    expect(mockRunner.runs).toHaveLength(2);
    expect(mockRunner.runs[1].timeRange.from.valueOf()).toBe(60_000);
  });

  it('reports plan errors and runs nothing', async () => {
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }), args(range(0, 48))));
    await flush();
    act(() => jest.runAllTimers());
    expect(mockRunner.runs).toEqual([]);
    expect(result.current.errors).toEqual(['Time range is limited to 24 h']);
    expect(result.current.loading).toBe(false);
  });

  it('reports a metric that cannot be resolved and runs the rest', async () => {
    mockCatalog.resolve.mockImplementation((name: string) =>
      name === 'gone' ? Promise.reject(new Error('no such metric')) : Promise.resolve(resolved(name))
    );
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }, { metric: 'gone' }), args()));
    await flush();
    act(() => jest.advanceTimersByTime(0));
    expect(mockRunner.runs[0].queries.map((q) => q.refId)).toEqual(['a']);
    expect(result.current.rowMessages).toEqual({
      b: ['Metric `gone` could not be loaded: no such metric', 'unknown metric'],
    });
    expect(result.current.warnings).toEqual([]);
  });

  it('puts engine errors of a row under that row', async () => {
    compileMock.mockImplementation((state: ExplorerState, ctx: CompileContext) => ({
      ...fakeCompile(state, ctx),
      formulas: [{ id: 'x', refLetter: 'f1', expression: 'a * 2', hidden: false }],
    }));
    evaluateMock.mockReturnValue({
      seriesByRow: {},
      rowErrors: { f1: 'Unknown letter c', f9: 'gone' },
      warnings: ['Too many series'],
    });
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }), args()));
    await flush();
    act(() => jest.advanceTimersByTime(0));
    respond(0);
    expect(result.current.rowMessages).toEqual({ f1: ['Unknown letter c'] });
    expect(result.current.warnings).toEqual(['Too many series', 'f9: gone']);
  });

  it('reports query errors of the current run', async () => {
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }), args()));
    await flush();
    act(() => jest.advanceTimersByTime(0));
    const options = mockRunner.runs[0];
    const request = { targets: options.queries, range: options.timeRange } as unknown as DataQueryRequest;
    act(() =>
      mockRunner.data.next({
        state: LoadingState.Error,
        series: [],
        timeRange: options.timeRange,
        request,
        errors: [{ refId: 'a', message: 'bad_data: parse error' }],
      })
    );
    expect(result.current.errors).toEqual(['a: bad_data: parse error']);
  });

  it('leaves rows without a metric without messages', async () => {
    compileMock.mockImplementation((state: ExplorerState, ctx: CompileContext) => ({
      ...fakeCompile(state, ctx),
      queries: state.queries.map((q) => ({
        ...fakeCompile(state, ctx).queries[0],
        letter: q.letter,
        refId: q.letter,
        skip: 'Choose a metric',
      })),
    }));
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }, { metric: '' }), args()));
    await flush();
    expect(result.current.rowMessages).toEqual({ a: ['Choose a metric'] });
  });

  it('shows a compiler failure as an error', async () => {
    compileMock.mockImplementation(() => {
      throw new Error('bad');
    });
    const { result } = renderHook(() => useExplorerData(stateWith({ metric: 'cpu' }), args()));
    await flush();
    expect(result.current.errors).toEqual(['The queries could not be compiled: bad']);
    expect(result.current.plan).toBeUndefined();
  });
});
