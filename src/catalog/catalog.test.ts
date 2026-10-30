import { getDataSourceSrv } from '@grafana/runtime';

import { ResolvedMetric, TagFilter } from '../model/types';
import labelKeys from './__fixtures__/label-keys.json';
import names from './__fixtures__/label-name-values.json';
import metadata from './__fixtures__/metadata.json';
import { cadenceQuery, peakQuery } from './cadence';
import { Catalog, getCatalog, TagPair } from './index';

jest.mock('@grafana/runtime', () => ({ getDataSourceSrv: jest.fn() }));
// The compiler owns the matcher syntax; a plain stand-in keeps these tests about the catalogue.
jest.mock('../compile', () => ({
  filtersToMatchers: (filters: TagFilter[]) =>
    filters.map((f) => `${f.key}${f.op === 'neq' ? '!=' : '='}"${f.values.join('|')}"`),
}));

type Params = Record<string, string | number>;

const NOW = Date.UTC(2026, 9, 30, 10, 2, 0);
const HOUR = 3600_000;
const LAST_HOUR = { from: NOW - HOUR, to: NOW };
// 09:02–10:02 UTC snapped outwards to 5 min: 09:00–10:05.
const LAST_HOUR_SEC = { start: 1793350800, end: 1793354700 };

const OTEL = ['aggregation_temporality', 'exemplars', 'flag', 'start_time'];
const KEYS: Record<string, string[]> = {
  ...labelKeys,
  loadgen_iterations_total: ['__name__', 'scenario'],
  http_server_active_requests: ['__name__', 'environment', 'service_name', ...OTEL],
  checkout_orders_total: ['__name__', 'environment', 'instance_id', ...OTEL],
  queue_messages_deleted: ['__name__', 'queue', ...OTEL],
};
const TEMPORALITY: Record<string, string[]> = {
  http_server_requests_total: ['AGGREGATION_TEMPORALITY_DELTA'],
  http_client_request_duration_count: ['AGGREGATION_TEMPORALITY_DELTA'],
  checkout_orders_total: ['AGGREGATION_TEMPORALITY_DELTA'],
  queue_messages_processed: ['AGGREGATION_TEMPORALITY_CUMULATIVE'],
  queue_messages_deleted: ['AGGREGATION_TEMPORALITY_CUMULATIVE'],
  http_server_active_requests: ['AGGREGATION_TEMPORALITY_CUMULATIVE'],
};
/** Samples of the two densest series per stream and probe window (10 min, 6 h). */
const COUNTS: Record<string, Record<number, number[]>> = {
  http_server_requests_total: { 600: [30, 30] },
  http_client_request_duration_count: { 600: [31, 29] },
  checkout_orders_total: { 600: [2, 1] },
  queue_messages_processed: { 600: [10, 10] },
  http_server_active_requests: { 600: [10, 10] },
  otelcol_process_memory_rss: { 600: [20, 20] },
  worker_pool_active_workers: { 600: [10, 10] },
  loadgen_iterations_total: { 600: [1], 21600: [36] },
  checkout_orders_5m: { 600: [2, 2], 21600: [72, 70] },
  queue_messages_deleted: { 600: [2, 2], 21600: [72, 72] },
};
/** The most samples in 2 min of the last 10 min, for the two densest series of the sub-minute streams. */
const PEAKS: Record<string, number[]> = {
  http_server_requests_total: [6, 6],
  http_client_request_duration_count: [7, 6],
  otelcol_process_memory_rss: [4, 4],
};

let getResource: jest.Mock<Promise<unknown>, [string, Params]>;
let dsGet: jest.Mock;
let respond: (path: string, params: Params) => unknown;

function ok(data: unknown) {
  return { status: 'success', data };
}

function streamOf(params: Params): string {
  return /__name__="([^"]+)"/.exec(String(params['match[]']))?.[1] ?? '';
}

function defaultResponse(path: string, params: Params): unknown {
  if (path === 'api/v1/query') {
    const query = String(params.query);
    const stream = /__name__="([^"]+)"/.exec(query)?.[1] ?? '';
    const window = Number(/\[(\d+)s\]/.exec(query)?.[1]);
    const counts = query.includes('max_over_time') ? (PEAKS[stream] ?? []) : (COUNTS[stream]?.[window] ?? []);
    return ok({ resultType: 'vector', result: counts.map((n) => ({ metric: {}, value: [params.time, String(n)] })) });
  }
  if (path === 'api/v1/label/__name__/values') {
    return ok(names.data);
  }
  if (path === 'api/v1/metadata') {
    return ok(metadata.data);
  }
  if (path === 'api/v1/labels') {
    return ok(KEYS[streamOf(params)] ?? []);
  }
  const key = /^api\/v1\/label\/(\w+)\/values$/.exec(path)?.[1];
  if (key === 'aggregation_temporality') {
    return ok(TEMPORALITY[streamOf(params)] ?? []);
  }
  return ok(key === 'error_type' ? [] : [`${key}-a`, `${key}-b`]);
}

function calls(path?: string | RegExp): Array<[string, Params]> {
  return getResource.mock.calls.filter(
    ([p]) => path === undefined || (typeof path === 'string' ? p === path : path.test(p))
  );
}

beforeEach(() => {
  sessionStorage.clear();
  jest.restoreAllMocks();
  jest.spyOn(Date, 'now').mockReturnValue(NOW);
  respond = defaultResponse;
  getResource = jest.fn(async (path: string, params: Params) => respond(path, params));
  dsGet = jest.fn().mockResolvedValue({ getResource });
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the catalogue uses it, see index.ts
  (getDataSourceSrv as jest.Mock).mockReturnValue({ get: dsGet });
});

describe('listMetrics', () => {
  it('loads names and metadata once and shares concurrent calls', async () => {
    const catalog = new Catalog('metrics');
    const [a, b] = await Promise.all([catalog.listMetrics(), catalog.listMetrics()]);
    expect(a).toBe(b);
    expect(a).toHaveLength(84);
    expect(await catalog.getMetric('http_server_requests_total')).toMatchObject({ kind: 'delta_counter' });
    expect(await catalog.getMetric('http_server_request_duration_bucket')).toBeUndefined();
    expect(dsGet).toHaveBeenCalledWith({ uid: 'metrics' });
    expect(getResource.mock.calls.map(([path]) => path)).toEqual(['api/v1/label/__name__/values', 'api/v1/metadata']);
  });

  it('keeps the catalogue for 10 min in memory and in sessionStorage', async () => {
    await new Catalog('ds').listMetrics();
    expect(await new Catalog('ds').listMetrics()).toHaveLength(84);
    expect(getResource).toHaveBeenCalledTimes(2);

    const catalog = new Catalog('ds');
    await catalog.listMetrics();
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 10 * 60_000 + 1);
    await catalog.listMetrics();
    await new Catalog('ds').listMetrics();
    expect(getResource).toHaveBeenCalledTimes(4);
  });

  it('keeps one sessionStorage entry per datasource', async () => {
    await new Catalog('a').listMetrics();
    await new Catalog('b').listMetrics();
    expect(getResource).toHaveBeenCalledTimes(4);
  });

  it('works when sessionStorage is blocked or damaged', async () => {
    sessionStorage.setItem('skippay-metricsexplorer:catalog:ds', '{not json');
    expect(await new Catalog('ds').listMetrics()).toHaveLength(84);
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(await new Catalog('ds2').listMetrics()).toHaveLength(84);
  });

  it('retries after a failure', async () => {
    respond = () => Promise.reject({ status: 502, data: 'Bad Gateway' });
    const catalog = new Catalog('ds');
    await expect(catalog.listMetrics()).rejects.toThrow(
      'Metric catalogue request api/v1/label/__name__/values failed: 502 Bad Gateway'
    );
    respond = defaultResponse;
    expect(await catalog.listMetrics()).toHaveLength(84);
  });
});

describe('resolve', () => {
  it.each([
    ['http_server_requests_total', 'delta_counter', { delta: true, cumulative: false }, true, 20],
    ['queue_messages_processed', 'cumulative_counter', { delta: false, cumulative: true }, false, 60],
    ['loadgen_iterations_total', 'cumulative_counter', { delta: false, cumulative: false }, false, 600],
    ['http_client_request_duration', 'distribution', { delta: true, cumulative: false }, true, 20],
    ['http_server_active_requests', 'gauge', { delta: false, cumulative: true }, false, 60],
    ['otelcol_process_memory_rss', 'gauge', { delta: false, cumulative: false }, false, 30],
    ['worker_pool_active_workers', 'gauge', { delta: false, cumulative: false }, false, 60],
    ['amazonaws_com_aws_rds_cpuutilization', 'cloudwatch', { delta: false, cumulative: false }, false, 60],
    ['checkout_orders_5m', 'gauge', { delta: false, cumulative: false }, false, 300],
  ])('%s → %s', async (name, kind, temporality, hasInstanceId, nativeIntervalSec) => {
    const resolved = await new Catalog('ds').resolve(name, LAST_HOUR);
    expect(resolved).toMatchObject({ name, kind, temporality, hasInstanceId, nativeIntervalSec });
    expect(resolved.labelKeys).toEqual([...resolved.labelKeys].sort());
    expect(resolved.labelKeys).not.toContain('__name__');
  });

  it('reads the schema without a window and the temporality with one', async () => {
    await new Catalog('ds').resolve('http_client_request_duration', LAST_HOUR);
    expect(calls('api/v1/labels')).toEqual([
      ['api/v1/labels', { 'match[]': '{__name__="http_client_request_duration_count"}' }],
    ]);
    const [[, params]] = calls('api/v1/label/aggregation_temporality/values');
    expect(params).toEqual({ 'match[]': '{__name__="http_client_request_duration_count"}', ...LAST_HOUR_SEC });
  });

  it('skips the temporality call for streams without the label', async () => {
    const resolved = await new Catalog('ds').resolve('amazonaws_com_aws_rds_cpuutilization', LAST_HOUR);
    expect(resolved.labelKeys).toContain('dimensions_dbinstanceidentifier');
    expect(calls(/aggregation_temporality/)).toEqual([]);
  });

  it('caches per metric for 5 min and shares concurrent calls', async () => {
    const catalog = new Catalog('ds');
    const [a, b] = await Promise.all([
      catalog.resolve('http_server_requests_total', LAST_HOUR),
      catalog.resolve('http_server_requests_total', LAST_HOUR),
    ]);
    expect(a).toBe(b);
    expect(calls('api/v1/labels')).toHaveLength(1);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 5 * 60_000 + 1);
    await catalog.resolve('http_server_requests_total', LAST_HOUR);
    expect(calls('api/v1/labels')).toHaveLength(2);
  });

  it('rejects an unknown metric', async () => {
    await expect(new Catalog('ds').resolve('no_such_metric', LAST_HOUR)).rejects.toThrow(
      'Metric no_such_metric does not exist'
    );
  });
});

describe('cadence detection', () => {
  const probes = () => calls('api/v1/query').map(([, params]) => params);

  it('probes the last 10 min at the end of the range, then the last 6 h when that is too sparse', async () => {
    const end = LAST_HOUR.to / 1000;
    await new Catalog('ds').resolve('worker_pool_active_workers', LAST_HOUR);
    expect(probes()).toEqual([
      { query: cadenceQuery('worker_pool_active_workers', 600), time: end },
      { query: peakQuery('worker_pool_active_workers', 600), time: end },
    ]);
    getResource.mockClear();
    await new Catalog('ds').resolve('checkout_orders_5m', LAST_HOUR);
    expect(probes()).toEqual([
      { query: cadenceQuery('checkout_orders_5m', 600), time: end },
      { query: peakQuery('checkout_orders_5m', 600), time: end },
      { query: cadenceQuery('checkout_orders_5m', 21600), time: end },
    ]);
  });

  it('probes distributions on _count and evaluates a future range end now', async () => {
    await new Catalog('ds').resolve('http_client_request_duration', { from: NOW - HOUR, to: NOW + HOUR });
    expect(probes()).toEqual([
      { query: cadenceQuery('http_client_request_duration_count', 600), time: NOW / 1000 },
      { query: peakQuery('http_client_request_duration_count', 600), time: NOW / 1000 },
    ]);
  });

  it('probes alongside the labels call', async () => {
    let release = () => {};
    const labels = new Promise<void>((resolve) => (release = resolve));
    respond = async (path, params) => {
      if (path === 'api/v1/labels') {
        await labels;
      }
      return defaultResponse(path, params);
    };
    const resolving = new Catalog('ds').resolve('worker_pool_active_workers', LAST_HOUR);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(probes()).toHaveLength(2);
    release();
    expect((await resolving).nativeIntervalSec).toBe(60);
  });

  it('gives sparse delta sums no long probe: they count rare events', async () => {
    expect((await new Catalog('ds').resolve('checkout_orders_total', LAST_HOUR)).nativeIntervalSec).toBe(60);
    expect(probes()).toHaveLength(2);
  });

  it('gives sparse cumulative OTel sums the long probe: they export every interval', async () => {
    expect((await new Catalog('ds').resolve('queue_messages_deleted', LAST_HOUR)).nativeIntervalSec).toBe(300);
    expect(probes()).toHaveLength(3);
  });

  it('uses 60 s for CloudWatch streams and streams without samples', async () => {
    await new Catalog('ds').resolve('amazonaws_com_aws_rds_cpuutilization', LAST_HOUR);
    expect(probes()).toEqual([]);
    expect((await new Catalog('ds').resolve('node_load1', LAST_HOUR)).nativeIntervalSec).toBe(60);
    expect(probes()).toHaveLength(3);
  });

  it('keeps the cadence for 10 min, longer than the rest of the resolution', async () => {
    const catalog = new Catalog('ds');
    await catalog.resolve('worker_pool_active_workers', LAST_HOUR);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 5 * 60_000 + 1);
    await catalog.resolve('worker_pool_active_workers', LAST_HOUR);
    expect(calls('api/v1/labels')).toHaveLength(2);
    expect(probes()).toHaveLength(2);
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 10 * 60_000 + 2);
    await catalog.resolve('worker_pool_active_workers', LAST_HOUR);
    expect(probes()).toHaveLength(4);
  });

  it('falls back to 60 s when the probe fails and probes again on the next resolution', async () => {
    const catalog = new Catalog('ds');
    respond = (path, params) =>
      path === 'api/v1/query'
        ? Promise.reject({ status: 422, data: { error: 'bad query' } })
        : defaultResponse(path, params);
    expect((await catalog.resolve('otelcol_process_memory_rss', LAST_HOUR)).nativeIntervalSec).toBe(60);
    respond = defaultResponse;
    jest.spyOn(Date, 'now').mockReturnValue(NOW + 5 * 60_000 + 1);
    expect((await catalog.resolve('otelcol_process_memory_rss', LAST_HOUR)).nativeIntervalSec).toBe(30);
  });
});

describe('labelValues', () => {
  async function resolved(name = 'http_server_requests_total'): Promise<{ catalog: Catalog; metric: ResolvedMetric }> {
    const catalog = new Catalog('ds');
    return { catalog, metric: await catalog.resolve(name, LAST_HOUR) };
  }

  it('passes the filters as matchers and the window in whole seconds', async () => {
    const { catalog, metric } = await resolved();
    const filters: TagFilter[] = [
      { key: 'environment', op: 'eq', values: ['prod'] },
      { key: 'method', op: 'neq', values: ['GET'] },
    ];
    expect(await catalog.labelValues(metric, 'path', filters, LAST_HOUR)).toEqual(['path-a', 'path-b']);
    expect(calls('api/v1/label/path/values')).toEqual([
      [
        'api/v1/label/path/values',
        {
          'match[]': '{__name__="http_server_requests_total",environment="prod",method!="GET"}',
          ...LAST_HOUR_SEC,
        },
      ],
    ]);
  });

  it('reads distribution values from _count', async () => {
    const { catalog, metric } = await resolved('http_client_request_duration');
    await catalog.labelValues(metric, 'peer_service', [], LAST_HOUR);
    expect(streamOf(calls('api/v1/label/peer_service/values')[0][1])).toBe('http_client_request_duration_count');
  });

  it.each([
    ['a 3-day range to its last 24 h', { from: NOW - 72 * HOUR, to: NOW }, 24 * 3600],
    ['an empty range to the last hour', { from: NaN, to: NaN }, 3600 + 300],
    ['a reversed range to the last hour', { from: NOW, to: NOW - HOUR }, 3600 + 300],
  ])('clamps %s', async (_, range, seconds) => {
    const { catalog, metric } = await resolved();
    await catalog.labelValues(metric, 'path', [], range);
    const [[, params]] = calls('api/v1/label/path/values');
    const start = Number(params.start);
    const end = Number(params.end);
    expect(end - start).toBe(seconds);
    expect(end).toBeGreaterThanOrEqual(NOW / 1000);
    expect([start % 300, end % 300]).toEqual([0, 0]);
  });

  it('caches within the 5-minute window step and shares concurrent calls', async () => {
    const { catalog, metric } = await resolved();
    await Promise.all([
      catalog.labelValues(metric, 'path', [], LAST_HOUR),
      catalog.labelValues(metric, 'path', [], LAST_HOUR),
    ]);
    await catalog.labelValues(metric, 'path', [], { from: LAST_HOUR.from + 30_000, to: LAST_HOUR.to + 30_000 });
    expect(calls('api/v1/label/path/values')).toHaveLength(1);
    await catalog.labelValues(metric, 'path', [{ key: 'environment', op: 'eq', values: ['prod'] }], LAST_HOUR);
    expect(calls('api/v1/label/path/values')).toHaveLength(2);
  });

  it('reports the server error and retries the next time', async () => {
    const { catalog, metric } = await resolved();
    respond = () =>
      Promise.reject({ status: 500, data: { status: 'error', error: 'Error# [file_list] invalid time range' } });
    await expect(catalog.labelValues(metric, 'path', [], LAST_HOUR)).rejects.toThrow(
      'Metric catalogue request api/v1/label/path/values failed: 500 Error# [file_list] invalid time range'
    );
    respond = () => ({ status: 'error', error: 'bad match[]' });
    await expect(catalog.labelValues(metric, 'path', [], LAST_HOUR)).rejects.toThrow(
      'Metric catalogue request api/v1/label/path/values failed: bad match[]'
    );
    respond = defaultResponse;
    expect(await catalog.labelValues(metric, 'path', [], LAST_HOUR)).toEqual(['path-a', 'path-b']);
  });
});

describe('tagPairs', () => {
  const USEFUL = ['environment', 'host', 'method', 'path', 'service_name', 'status_code', 'instance_id'];

  async function setup(): Promise<{ catalog: Catalog; metric: ResolvedMetric }> {
    const catalog = new Catalog('ds');
    const metric = await catalog.resolve('http_server_requests_total', LAST_HOUR);
    getResource.mockClear();
    return { catalog, metric };
  }

  it('fetches every non-noise key, four at a time, and streams the pairs', async () => {
    const { catalog, metric } = await setup();
    let inFlight = 0;
    let maxInFlight = 0;
    respond = async (path, params) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight--;
      return defaultResponse(path, params);
    };
    const progress: TagPair[][] = [];
    const pairs = await catalog.tagPairs(metric, [], LAST_HOUR, (p) => progress.push(p));

    expect(maxInFlight).toBe(4);
    const fetched = calls().map(([path]) => /label\/(\w+)\/values/.exec(path)?.[1]);
    expect([...fetched].sort()).toEqual([...USEFUL, 'error_type'].sort());
    // error_type has no values in the window, so it yields no pairs.
    expect([...new Set(pairs.map((p) => p.key))]).toEqual(USEFUL);
    expect(pairs.slice(0, 2)).toEqual([
      { key: 'environment', value: 'environment-a' },
      { key: 'environment', value: 'environment-b' },
    ]);
    expect(progress).toHaveLength(USEFUL.length);
    expect(progress.map((p) => p.length)).toEqual(USEFUL.map((_, i) => 2 * (i + 1)));
    expect(progress[progress.length - 1]).toBe(pairs);
  });

  it("leaves a key's own filters out of its values", async () => {
    const { catalog, metric } = await setup();
    await catalog.tagPairs(metric, [{ key: 'environment', op: 'eq', values: ['prod'] }], LAST_HOUR);
    expect(streamOf(calls('api/v1/label/environment/values')[0][1])).toBe('http_server_requests_total');
    expect(calls('api/v1/label/environment/values')[0][1]['match[]']).toBe('{__name__="http_server_requests_total"}');
    expect(calls('api/v1/label/path/values')[0][1]['match[]']).toBe(
      '{__name__="http_server_requests_total",environment="prod"}'
    );
  });

  it('shares an identical call in flight, including its progress, and caches the result', async () => {
    const { catalog, metric } = await setup();
    const first: number[] = [];
    const second: number[] = [];
    const a = catalog.tagPairs(metric, [], LAST_HOUR, (p) => first.push(p.length));
    const b = catalog.tagPairs(metric, [], LAST_HOUR, (p) => second.push(p.length));
    expect(a).toBe(b);
    await a;
    expect(second).toEqual(first);
    const requests = getResource.mock.calls.length;

    const third: number[] = [];
    expect(await catalog.tagPairs(metric, [], LAST_HOUR, (p) => third.push(p.length))).toBe(await a);
    expect(third).toEqual([2 * USEFUL.length]);
    expect(getResource.mock.calls.length).toBe(requests);
  });

  it('rejects when a key fails and starts over on the next call', async () => {
    const { catalog, metric } = await setup();
    respond = (path, params) =>
      path.includes('/path/')
        ? Promise.reject({ status: 500, data: { error: 'boom' } })
        : defaultResponse(path, params);
    await expect(catalog.tagPairs(metric, [], LAST_HOUR)).rejects.toThrow('500 boom');
    respond = defaultResponse;
    expect(await catalog.tagPairs(metric, [], LAST_HOUR)).toHaveLength(2 * USEFUL.length);
  });
});

describe('data source', () => {
  it('rejects a data source without resource calls', async () => {
    dsGet.mockResolvedValue({});
    await expect(new Catalog('plain').listMetrics()).rejects.toThrow('Data source plain does not serve resource calls');
  });

  it('shares one catalogue per data source', () => {
    expect(getCatalog('x')).toBe(getCatalog('x'));
    expect(getCatalog('x')).not.toBe(getCatalog('y'));
  });
});
