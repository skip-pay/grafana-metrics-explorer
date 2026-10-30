import { defaultState } from '../model/defaults';
import { ExplorerState, FunctionCall, MetricInfo, MetricQuery, ResolvedMetric, TagFilter } from '../model/types';
import { compile } from './compile';
import { CompileContext, CompiledQuery } from './types';

const HOUR = 3600_000;
const TO = Date.UTC(2026, 9, 30, 12, 0, 0);
const DELTA = 'aggregation_temporality="AGGREGATION_TEMPORALITY_DELTA"';
const CUMULATIVE = 'aggregation_temporality="AGGREGATION_TEMPORALITY_CUMULATIVE"';

function resolved(name: string, kind: ResolvedMetric['kind'], extra: Partial<ResolvedMetric> = {}): ResolvedMetric {
  return {
    name,
    kind,
    streams: { base: name },
    temporality: { delta: false, cumulative: false },
    labelKeys: ['environment', 'path', 'cluster', 'service', 'provider', 'event_category', 'result'],
    hasInstanceId: false,
    nativeIntervalSec: 60,
    ...extra,
  };
}

function histogram(name: string, delta: boolean, minMax = true): ResolvedMetric {
  return resolved(name, 'distribution', {
    streams: {
      base: name,
      bucket: `${name}_bucket`,
      count: `${name}_count`,
      sum: `${name}_sum`,
      ...(minMax ? { min: `${name}_min`, max: `${name}_max` } : {}),
    },
    temporality: { delta, cumulative: !delta },
  });
}

function cloudwatch(name: string): ResolvedMetric {
  return resolved(name, 'cloudwatch', {
    streams: { base: name, sum: `${name}_sum`, count: `${name}_count` },
    labelKeys: ['dimensions_clustername', 'dimensions_servicename'],
  });
}

const METRICS: Record<string, ResolvedMetric | MetricInfo> = {
  gauge: resolved('gauge', 'gauge'),
  rule: resolved('rule', 'gauge', { nativeIntervalSec: 300 }),
  fast: resolved('fast', 'gauge', { nativeIntervalSec: 20 }),
  half_minute: resolved('half_minute', 'gauge', { nativeIntervalSec: 30 }),
  requests: resolved('requests', 'delta_counter', { temporality: { delta: true, cumulative: false } }),
  untyped_total: resolved('untyped_total', 'delta_counter'),
  events: resolved('events', 'cumulative_counter', { temporality: { delta: false, cumulative: true } }),
  scraped_total: resolved('scraped_total', 'cumulative_counter'),
  scraped_fast_total: resolved('scraped_fast_total', 'cumulative_counter', { nativeIntervalSec: 15 }),
  dur: histogram('dur', true),
  dur_nominmax: histogram('dur_nominmax', true, false),
  cdur: histogram('cdur', false),
  // A scraped histogram: no aggregation_temporality label, so no temporality either.
  lat: { ...histogram('lat', false, false), temporality: { delta: false, cumulative: false } },
  cpu: cloudwatch('cpu'),
  pending: { name: 'pending', kind: 'delta_counter', streams: { base: 'pending' } },
};

const fn = (name: string, ...args: Array<number | string>): FunctionCall => ({ id: name, name, args });
const eq = (key: string, value: string): TagFilter => ({ key, op: 'eq', values: [value] });

function q(metric: string, spaceAgg: MetricQuery['spaceAgg'], extra: Partial<MetricQuery> = {}): Partial<MetricQuery> {
  return { metric, spaceAgg, ...extra };
}

function stateWith(...queries: Array<Partial<MetricQuery>>): ExplorerState {
  const state = defaultState();
  state.queries = queries.map((query, i) => ({ ...state.queries[0], id: `q${i}`, letter: 'abcdefgh'[i], ...query }));
  return state;
}

function ctx(hours = 2, metrics = METRICS): CompileContext {
  return { range: { from: TO - hours * HOUR, to: TO }, widthPx: 1200, metrics, maxRangeHours: 24 };
}

function one(query: Partial<MetricQuery>, hours = 2, state?: Partial<ExplorerState>): CompiledQuery {
  return compile({ ...stateWith(query), ...state }, ctx(hours)).queries[0];
}

const expr = (query: Partial<MetricQuery>, hours = 2) => {
  const c = one(query, hours);
  expect(c.skip).toBeUndefined();
  return c.expr;
};

describe('golden PromQL (2 h range, 60 s step)', () => {
  describe('gauge', () => {
    it.each<[Partial<MetricQuery>, string]>([
      [q('gauge', 'avg'), 'avg(avg_over_time(gauge[60s]))'],
      [q('gauge', 'avg', { groupBy: ['cluster'] }), 'avg by (cluster) (avg_over_time(gauge[60s]))'],
      [q('gauge', 'sum', { groupBy: ['cluster', 'service'] }), 'sum by (cluster, service) (avg_over_time(gauge[60s]))'],
      [q('gauge', 'min'), 'min(avg_over_time(gauge[60s]))'],
      [q('gauge', 'max', { functions: [fn('rollup', 'max', 0)] }), 'max(max_over_time(gauge[60s]))'],
      [q('gauge', 'avg', { functions: [fn('rollup', 'min')] }), 'avg(min_over_time(gauge[60s]))'],
      [q('gauge', 'sum', { functions: [fn('rollup', 'count', 0)] }), 'sum(count_over_time(gauge[60s]))'],
      [q('gauge', 'count', { groupBy: ['cluster'] }), 'count by (cluster) (last_over_time(gauge[60s]))'],
      [
        q('gauge', 'sum', { filters: [eq('service', 'api*'), { key: 'cluster', op: 'neq', values: ['staging'] }] }),
        'sum(avg_over_time(gauge{service=~"(?:api.*)",cluster!="staging"}[60s]))',
      ],
      [q('gauge', 'avg', { functions: [fn('as_count')] }), 'avg(avg_over_time(gauge[60s]))'],
    ])('%j', (query, promql) => {
      expect(expr(query)).toBe(promql);
    });

    it('averages a slow stream over steps of its interval', () => {
      const c = one(q('rule', 'sum', { groupBy: ['environment'] }));
      expect(c.stepSec).toBe(300);
      expect(c.expr).toBe('sum by (environment) (avg_over_time(rule[300s]))');
    });

    it('does not offer percentiles', () => {
      expect(one(q('gauge', 'p95')).skip).toBe('p95 is only available for distribution metrics');
    });
  });

  describe('delta counter', () => {
    const sel = `requests{${DELTA}}[60s]`;
    it.each<[Partial<MetricQuery>, string]>([
      [q('requests', 'sum', { functions: [fn('as_count')] }), `sum(sum_over_time(${sel}))`],
      [q('requests', 'sum'), `sum(sum_over_time(${sel}))`],
      [
        q('requests', 'sum', { groupBy: ['environment'], functions: [fn('as_count')] }),
        `sum by (environment) (sum_over_time(${sel}))`,
      ],
      [
        q('requests', 'sum', { groupBy: ['environment'], functions: [fn('as_rate')] }),
        `sum by (environment) (sum_over_time(${sel})) / 60`,
      ],
      [
        q('requests', 'avg', { groupBy: ['environment'] }),
        `avg by (environment) (sum without (instance_id, start_time, exemplars, flag) (sum_over_time(${sel})))`,
      ],
      [q('requests', 'max'), `max(sum without (instance_id, start_time, exemplars, flag) (sum_over_time(${sel})))`],
      [
        q('requests', 'max', { groupBy: ['instance_id'] }),
        `max by (instance_id) (sum without (start_time, exemplars, flag) (sum_over_time(${sel})))`,
      ],
      [
        q('requests', 'count', { functions: [fn('as_rate')] }),
        `count(sum without (instance_id, start_time, exemplars, flag) (sum_over_time(${sel})))`,
      ],
      [q('requests', 'sum', { functions: [fn('as_count'), fn('rollup', 'max', 0)] }), `sum(max_over_time(${sel}))`],
      [
        q('requests', 'sum', { filters: [eq('environment', 'prod'), eq('environment', 'staging')] }),
        `sum(sum_over_time(requests{${DELTA},environment=~"(?:prod|staging)"}[60s]))`,
      ],
      [q('untyped_total', 'sum'), 'sum(sum_over_time(untyped_total[60s]))'],
    ])('%j', (query, promql) => {
      expect(expr(query)).toBe(promql);
    });
  });

  describe('cumulative counter', () => {
    it.each<[Partial<MetricQuery>, string]>([
      [
        q('events', 'sum', { groupBy: ['environment'], functions: [fn('as_count')] }),
        `sum by (environment) (rate(events{${CUMULATIVE}}[240s])) * 60`,
      ],
      [q('events', 'sum', { functions: [fn('as_rate')] }), `sum(rate(events{${CUMULATIVE}}[240s]))`],
      [q('events', 'max', { groupBy: ['result'] }), `max by (result) (rate(events{${CUMULATIVE}}[240s])) * 60`],
      [q('scraped_total', 'sum'), 'sum(rate(scraped_total[240s])) * 60'],
      [q('scraped_total', 'count', { groupBy: ['service'] }), 'count by (service) (rate(scraped_total[240s]))'],
    ])('%j', (query, promql) => {
      expect(expr(query)).toBe(promql);
    });

    it('widens the rate window to the step', () => {
      expect(expr(q('events', 'sum'), 24)).toBe(`sum(rate(events{${CUMULATIVE}}[300s])) * 300`);
    });

    it('rates over at least four export intervals', () => {
      const c = one(q('scraped_fast_total', 'sum'), 1);
      expect(c.stepSec).toBe(15);
      expect(c.expr).toBe('sum(rate(scraped_fast_total[60s])) * 15');
    });

    it('warns that a rollup aggregator does not apply', () => {
      expect(one(q('events', 'sum', { functions: [fn('rollup', 'max', 0)] })).warnings).toEqual([
        'rollup(max): only the interval applies to cumulative counters',
      ]);
    });
  });

  describe('distribution, delta', () => {
    const s = (stream: string) => `${stream}{${DELTA}}[60s]`;
    it.each<[Partial<MetricQuery>, string]>([
      [q('dur', 'p50'), `histogram_quantile(0.5, sum by (le) (sum_over_time(${s('dur_bucket')})))`],
      [
        q('dur', 'p95', { groupBy: ['environment'] }),
        `histogram_quantile(0.95, sum by (le, environment) (sum_over_time(${s('dur_bucket')})))`,
      ],
      [q('dur', 'p75'), `histogram_quantile(0.75, sum by (le) (sum_over_time(${s('dur_bucket')})))`],
      [q('dur', 'p90'), `histogram_quantile(0.9, sum by (le) (sum_over_time(${s('dur_bucket')})))`],
      [q('dur', 'p99'), `histogram_quantile(0.99, sum by (le) (sum_over_time(${s('dur_bucket')})))`],
      [
        q('dur', 'avg', { groupBy: ['provider'] }),
        `sum by (provider) (sum_over_time(${s('dur_sum')})) / (sum by (provider) (sum_over_time(${s('dur_count')})) > 0)`,
      ],
      [q('dur', 'count'), `sum(sum_over_time(${s('dur_count')}))`],
      [q('dur', 'count', { functions: [fn('as_rate')] }), `sum(sum_over_time(${s('dur_count')})) / 60`],
      [q('dur', 'sum'), `sum(sum_over_time(${s('dur_sum')}))`],
      [q('dur', 'min'), `min(min_over_time(${s('dur_min')}))`],
      [q('dur', 'max', { groupBy: ['environment'] }), `max by (environment) (max_over_time(${s('dur_max')}))`],
      [q('dur_nominmax', 'max'), `histogram_quantile(1, sum by (le) (sum_over_time(${s('dur_nominmax_bucket')})))`],
    ])('%j', (query, promql) => {
      expect(expr(query)).toBe(promql);
    });

    it('cannot give min without a _min stream', () => {
      expect(one(q('dur_nominmax', 'min')).skip).toBe('min is not available: the histogram has no _min stream');
    });

    it('ignores the rollup aggregator with a warning', () => {
      const c = one(q('dur', 'p95', { functions: [fn('rollup', 'max', 300)] }));
      expect(c.expr).toBe(`histogram_quantile(0.95, sum by (le) (sum_over_time(dur_bucket{${DELTA}}[300s])))`);
      expect(c.warnings).toEqual(['rollup(max): only the interval applies to distributions']);
    });
  });

  describe('distribution, cumulative', () => {
    const r = (stream: string) => `rate(${stream}{${CUMULATIVE}}[240s])`;
    it.each<[Partial<MetricQuery>, string]>([
      [q('cdur', 'p95'), `histogram_quantile(0.95, sum by (le) (${r('cdur_bucket')}))`],
      [
        q('cdur', 'avg', { groupBy: ['event_category'] }),
        `sum by (event_category) (${r('cdur_sum')}) / (sum by (event_category) (${r('cdur_count')}) > 0)`,
      ],
      [q('cdur', 'count'), `sum(${r('cdur_count')}) * 60`],
      [q('cdur', 'count', { functions: [fn('as_rate')] }), `sum(${r('cdur_count')})`],
      [q('cdur', 'sum'), `sum(${r('cdur_sum')}) * 60`],
    ])('%j', (query, promql) => {
      expect(expr(query)).toBe(promql);
    });

    it('does not offer min and max', () => {
      expect(one(q('cdur', 'max')).skip).toBe('max is not available for cumulative histograms');
    });

    it('treats a histogram without the OTel label as cumulative, without the temporality matcher', () => {
      expect(expr(q('lat', 'p95'))).toBe('histogram_quantile(0.95, sum by (le) (rate(lat_bucket[240s])))');
      expect(expr(q('lat', 'avg'))).toBe('sum(rate(lat_sum[240s])) / (sum(rate(lat_count[240s])) > 0)');
      expect(expr(q('lat', 'count'))).toBe('sum(rate(lat_count[240s])) * 60');
    });
  });

  describe('cloudwatch', () => {
    it.each<[Partial<MetricQuery>, string]>([
      [
        q('cpu', 'avg', { groupBy: ['dimensions_clustername'] }),
        'avg by (dimensions_clustername) (sum_over_time(cpu_sum[60s]) / sum_over_time(cpu_count[60s]))',
      ],
      [q('cpu', 'max'), 'max(max_over_time(cpu{quantile="1"}[60s]))'],
      [
        q('cpu', 'min', { filters: [eq('dimensions_servicename', '*')] }),
        'min(min_over_time(cpu{quantile="0",dimensions_servicename=~"(?:.+)"}[60s]))',
      ],
      [q('cpu', 'sum'), 'sum(sum_over_time(cpu_sum[60s]))'],
      [q('cpu', 'count'), 'sum(sum_over_time(cpu_count[60s]))'],
    ])('%j', (query, promql) => {
      expect(expr(query)).toBe(promql);
    });
  });

  describe('timeshift', () => {
    it('puts the offset into every selector', () => {
      expect(expr(q('dur', 'avg', { functions: [fn('hour_before')] }))).toBe(
        `sum(sum_over_time(dur_sum{${DELTA}}[60s] offset 3600s)) / (sum(sum_over_time(dur_count{${DELTA}}[60s] offset 3600s)) > 0)`
      );
      expect(expr(q('cpu', 'avg', { functions: [fn('timeshift', -7200)] }))).toBe(
        'avg(sum_over_time(cpu_sum[60s] offset 7200s) / sum_over_time(cpu_count[60s] offset 7200s))'
      );
      expect(expr(q('events', 'sum', { functions: [fn('day_before')] }))).toBe(
        `sum(rate(events{${CUMULATIVE}}[240s] offset 86400s)) * 60`
      );
    });

    it('adds up several shifts and allows shifting forward', () => {
      expect(expr(q('gauge', 'avg', { functions: [fn('hour_before'), fn('day_before')] }))).toBe(
        'avg(avg_over_time(gauge[60s] offset 90000s))'
      );
      expect(expr(q('gauge', 'avg', { functions: [fn('timeshift', 600)] }))).toBe(
        'avg(avg_over_time(gauge[60s] offset -600s))'
      );
    });
  });
});

describe('post functions', () => {
  const base = `sum by (environment) (sum_over_time(requests{${DELTA}}[60s]))`;
  const withFns = (...functions: FunctionCall[]) =>
    one(q('requests', 'sum', { groupBy: ['environment'], functions: [fn('as_count'), ...functions] }));

  it('compiles a PromQL-able chain server side, in order', () => {
    const c = withFns(fn('abs'), fn('round', 2), fn('clamp_min', 1), fn('cutoff_max', 100));
    expect(c.expr).toBe(`clamp_min(round(abs(${base}), 0.01), 1) <= 100`);
    expect(c.clientChain).toEqual([]);
  });

  it('compiles count and throughput functions', () => {
    expect(withFns(fn('count_nonzero')).expr).toBe(`count(${base} != 0)`);
    expect(withFns(fn('count_not_null'), fn('log10')).expr).toBe(`log10(count(${base}))`);
    expect(withFns(fn('throughput')).expr).toBe(`${base} / 60`);
    expect(withFns(fn('cutoff_min', 5), fn('throughput')).expr).toBe(`(${base} >= 5) / 60`);
  });

  it('switches the rest of the chain to the client at the first client-only function', () => {
    const c = withFns(fn('abs'), fn('ewma_10'), fn('ceil'), fn('top', 10, 'mean', 'desc'));
    expect(c.expr).toBe(`abs(${base})`);
    expect(c.clientChain.map((call) => call.name)).toEqual(['ewma_10', 'ceil', 'top']);
  });

  it('keeps modifiers out of the chain wherever they sit', () => {
    const c = one(
      q('requests', 'sum', { functions: [fn('abs'), fn('as_rate'), fn('default_zero'), fn('fill', 'zero', 120)] })
    );
    expect(c.expr).toBe(`abs(sum(sum_over_time(requests{${DELTA}}[60s])) / 60)`);
    expect(c.clientChain).toEqual([fn('default_zero')]);
    expect(c.fill).toEqual({ method: 'zero', limitSec: 120 });
  });

  it('completes missing arguments and warns about bad ones', () => {
    const c = withFns({ id: 'r', name: 'round', args: [] }, fn('top', 7));
    expect(c.expr).toBe(`round(${base}, 1)`);
    expect(c.clientChain).toEqual([{ id: 'top', name: 'top', args: [5, 'mean', 'desc'] }]);
    expect(c.warnings).toEqual(['top(): n must be one of 5, 10, 25, 50, 100, not 7']);
  });

  it('ignores unknown and formula-only functions with a warning', () => {
    const c = withFns(fn('nope'), fn('pow', 2));
    expect(c.expr).toBe(base);
    expect(c.warnings).toEqual(['Unknown function nope() is ignored', 'pow() can only be used in formulas']);
  });
});

describe('plan', () => {
  it('shares the largest step, raised by an explicit rollup interval', () => {
    const plan = compile(
      stateWith(q('requests', 'sum'), q('gauge', 'avg', { functions: [fn('rollup', 'avg', 600)] })),
      ctx(2)
    );
    expect(plan.stepSec).toBe(600);
    expect(plan.queries.map((c) => [c.stepSec, c.windowSec])).toEqual([
      [600, 600],
      [600, 600],
    ]);
    expect(plan.queries[0].expr).toBe(`sum(sum_over_time(requests{${DELTA}}[600s]))`);
  });

  it('ignores a rollup interval below the step, takes any interval above it', () => {
    const stepWith = (seconds: number) =>
      compile(stateWith(q('gauge', 'avg', { functions: [fn('rollup', 'avg', seconds)] })), ctx(2)).stepSec;
    expect(stepWith(30)).toBe(60);
    expect(stepWith(0)).toBe(60);
    expect(stepWith(-600)).toBe(60);
    expect(stepWith(90)).toBe(90);
  });

  it("steps on a multiple of every queried metric's interval", () => {
    const stepOf = (...queries: Array<Partial<MetricQuery>>) => compile(stateWith(...queries), ctx(1)).stepSec;
    expect(stepOf(q('requests', 'sum'))).toBe(60);
    expect(stepOf(q('fast', 'avg'))).toBe(20);
    expect(stepOf(q('fast', 'avg'), q('half_minute', 'avg'))).toBe(60);
    expect(stepOf(q('fast', 'avg'), q('cpu', 'avg'))).toBe(60);
    expect(stepOf(q('fast', 'avg'), q('rule', 'avg'))).toBe(300);
    expect(stepOf(q('fast', 'avg'), q('pending', 'sum'))).toBe(60);
    expect(stepOf(q('fast', 'avg'), q('', 'avg'))).toBe(20);
    expect(
      compile({ ...stateWith(q('fast', 'avg')), display: { ...defaultState().display, display: 'bars' } }, ctx(1))
        .stepSec
    ).toBe(60);
  });

  it('refuses ranges above the limit', () => {
    const plan = compile(stateWith(q('requests', 'sum')), ctx(25));
    expect(plan.queries).toEqual([]);
    expect(plan.errors).toEqual(['Time range is limited to 24 h. Choose a shorter range.']);
    expect(compile(stateWith(q('requests', 'sum')), ctx(24)).errors).toEqual([]);
  });

  it('adds the split key to every query on timeseries, and drops grouping for a query value', () => {
    const state = {
      ...stateWith(q('requests', 'sum', { groupBy: ['path'] }), q('gauge', 'avg', { groupBy: ['environment'] })),
      split: { key: 'environment', limit: 12, order: 'top' as const, sortBy: 'avg' as const },
    };
    expect(compile(state, ctx()).queries.map((c) => c.expr)).toEqual([
      `sum by (path, environment) (sum_over_time(requests{${DELTA}}[60s]))`,
      'avg by (environment) (avg_over_time(gauge[60s]))',
    ]);
    expect(compile({ ...state, viz: 'toplist' }, ctx()).queries[0].expr).toBe(
      `sum by (path) (sum_over_time(requests{${DELTA}}[60s]))`
    );
    expect(compile({ ...state, viz: 'queryvalue' }, ctx()).queries[0].expr).toBe(
      `sum(sum_over_time(requests{${DELTA}}[60s]))`
    );
    expect(compile(state, ctx()).queries.map((c) => c.groupBy)).toEqual([['path', 'environment'], ['environment']]);
    expect(compile({ ...state, viz: 'queryvalue' }, ctx()).queries[0].groupBy).toEqual([]);
  });

  it('keeps a split key that a delta counter otherwise collapses', () => {
    const state = {
      ...stateWith(q('requests', 'avg')),
      split: { key: 'flag', limit: 12, order: 'top' as const, sortBy: 'avg' as const },
    };
    expect(compile(state, ctx()).queries[0].expr).toBe(
      `avg by (flag) (sum without (instance_id, start_time, exemplars) (sum_over_time(requests{${DELTA}}[60s])))`
    );
  });

  it('skips queries that cannot run, with the reason', () => {
    const skips = compile(
      stateWith(
        q('', 'avg'),
        q('requests', 'sum', { filters: [eq('nonexistent', 'x')] }),
        q('requests', 'sum', { groupBy: ['bad-key'] }),
        q('requests', 'sum', { filters: [{ key: 'path', op: 'neq', values: ['*'] }] }),
        q('bad.name', 'avg')
      ),
      ctx()
    ).queries.map((c) => [c.skip, c.expr]);
    expect(skips).toEqual([
      ['Choose a metric', ''],
      ['Tag `nonexistent` does not exist on `requests`', ''],
      ['Invalid tag key "bad-key"', ''],
      ['Filtering on a missing tag (!key:*) is not supported', ''],
      ['Invalid metric name "bad.name"', ''],
    ]);
  });

  it('compiles an unresolved metric with its provisional kind and flags it', () => {
    const c = one(q('pending', 'sum', { filters: [eq('anything', 'x')] }));
    expect(c.unresolved).toBe(true);
    expect(c.expr).toBe(`sum(sum_over_time(pending{${DELTA},anything="x"}[60s]))`);
    expect(one(q('missing_metric', 'avg')).unresolved).toBe(true);
    expect(one(q('missing_metric', 'avg')).expr).toBe('avg(avg_over_time(missing_metric[60s]))');
    expect(one(q('requests', 'sum')).unresolved).toBeUndefined();
  });

  it('gives grouped queries a capped variant ranked over the whole range', () => {
    const c = one(
      q('requests', 'sum', { groupBy: ['path'], functions: [fn('as_rate'), fn('abs'), fn('hour_before')] })
    );
    const query = `sum by (path) (sum_over_time(requests{${DELTA}}[60s] offset 3600s)) / 60`;
    const ranked = `sum by (path) (sum_over_time(requests{${DELTA}}[7200s] offset 3600s @ end())) / 7200`;
    expect(c.expr).toBe(`abs(${query})`);
    expect(c.cappedExpr).toBe(`abs((${query}) and topk(200, ${ranked}))`);
    expect(one(q('requests', 'sum')).cappedExpr).toBeUndefined();
  });

  it('carries row metadata, formulas and the title', () => {
    const state = stateWith(
      q('requests', 'sum', { groupBy: ['path'], functions: [fn('as_count')] }),
      q('gauge', 'avg', { alias: 'Gauge' }),
      q('gauge', 'max', { hidden: true }),
      q('', 'avg')
    );
    state.formulas = [
      { kind: 'formula', id: 'f', expression: 'a / b * 100', hidden: false },
      { kind: 'formula', id: 'g', expression: 'a', hidden: true, alias: 'hidden' },
      { kind: 'formula', id: 'h', expression: 'b', hidden: false, alias: 'Named' },
    ];
    const plan = compile(state, ctx());
    expect(plan.queries.map((c) => [c.letter, c.refId, c.textForm])).toEqual([
      ['a', 'a', 'sum:requests{*} by {path}.as_count()'],
      ['b', 'b', 'avg:gauge{*}'],
      ['c', 'c', 'max:gauge{*}'],
      ['d', 'd', 'avg:{*}'],
    ]);
    expect(plan.formulas).toEqual([
      { id: 'f', refLetter: 'f1', expression: 'a / b * 100', hidden: false },
      { id: 'g', refLetter: 'f2', expression: 'a', alias: 'hidden', hidden: true },
      { id: 'h', refLetter: 'f3', expression: 'b', alias: 'Named', hidden: false },
    ]);
    expect(plan.title).toBe('requests, gauge, a / b * 100, b');
  });

  describe('title', () => {
    const titleOf = (state: ExplorerState) => compile(state, ctx()).title;

    it('one visible row: its text form with only the in-query modifiers', () => {
      const functions = [fn('as_count'), fn('top', 5, 'mean', 'desc'), fn('rollup', 'sum', 300), fn('hour_before')];
      const state = stateWith(q('requests', 'sum', { groupBy: ['path'], functions, alias: 'Requests' }));
      expect(titleOf(state)).toBe('sum:requests{*} by {path}.as_count().rollup(sum, 300)');
    });

    it('two or more rows: bare metric names and formula expressions, without aliases', () => {
      const state = stateWith(q('requests', 'sum', { alias: 'Requests' }), q('gauge', 'avg'));
      expect(titleOf(state)).toBe('requests, gauge');
      state.formulas = [{ kind: 'formula', id: 'f', expression: ' a * 2 ', hidden: false, alias: 'double' }];
      expect(titleOf({ ...state, queries: [state.queries[0]] })).toBe('requests, a * 2');
    });

    it('a lone formula is its expression; invalid formulas are left out', () => {
      const state = stateWith(q('requests', 'sum', { hidden: true }), q('gauge', 'avg'));
      state.formulas = [
        { kind: 'formula', id: 'f', expression: 'a / 60', hidden: false },
        { kind: 'formula', id: 'g', expression: 'a * c', hidden: false },
        { kind: 'formula', id: 'h', expression: 'a *', hidden: false },
      ];
      expect(titleOf({ ...state, queries: [state.queries[0]] })).toBe('a / 60');
      expect(titleOf(state)).toBe('gauge, a / 60');
    });
  });
});
