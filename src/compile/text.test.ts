import { FilterGroup, FilterItem, FunctionCall, MetricInfo, MetricQuery, SpaceAgg, TagFilter } from '../model/types';
import { parseQueryText, renderQueryText } from './text';

const fn = (name: string, ...args: Array<number | string>): FunctionCall => ({ id: 'id', name, args });
const eq = (key: string, value: string): TagFilter => ({ key, op: 'eq', values: [value] });
const neq = (key: string, value: string): TagFilter => ({ key, op: 'neq', values: [value] });
const isIn = (key: string, ...values: string[]): TagFilter => ({ key, op: 'in', values });
const notIn = (key: string, ...values: string[]): TagFilter => ({ key, op: 'not_in', values });
const or = (...items: FilterItem[]): FilterGroup => ({ op: 'or', items });
const and = (...items: FilterItem[]): FilterGroup => ({ op: 'and', items });
const not = (group: FilterGroup): FilterGroup => ({ op: group.op, negated: true, items: group.items });

function query(
  metric: string,
  spaceAgg: SpaceAgg,
  filters: FilterItem[] = [],
  groupBy: string[] = [],
  functions: FunctionCall[] = []
): MetricQuery {
  return { kind: 'query', id: 'q', letter: 'a', hidden: false, metric, spaceAgg, filters, groupBy, functions };
}

const CATALOG: MetricInfo[] = [
  { name: 'http_server_requests_total', kind: 'delta_counter', streams: { base: 'http_server_requests_total' } },
  { name: 'http_client_request_duration', kind: 'distribution', streams: {} },
  { name: 'worker_pool_active_workers', kind: 'gauge', streams: {} },
  { name: 'amazonaws_com_aws_sqs_numberofmessagessent', kind: 'cloudwatch', streams: {} },
];

const stripIds = (q: Partial<MetricQuery>) => ({
  ...q,
  functions: q.functions?.map(({ name, args }) => ({ name, args })),
});

function roundTrip(q: MetricQuery) {
  return parseQueryText(renderQueryText(q), CATALOG);
}

const m = 'http_server_requests_total';
const h = 'http_client_request_duration';
const g = 'worker_pool_active_workers';

describe('renderQueryText', () => {
  it.each<[MetricQuery, string]>([
    [query(g, 'avg'), 'avg:worker_pool_active_workers{*}'],
    [
      query(m, 'sum', [eq('environment', 'prod'), neq('path', '/health')], ['path'], [fn('as_count')]),
      'sum:http_server_requests_total{environment:prod,!path:/health} by {path}.as_count()',
    ],
    [
      query(g, 'avg', [], ['host'], [fn('top', 10, 'mean', 'desc')]),
      "top(avg:worker_pool_active_workers{*} by {host}, 10, 'mean', 'desc')",
    ],
    [query(g, 'max', [], [], [fn('rollup', 'max', 60)]), 'max:worker_pool_active_workers{*}.rollup(max, 60)'],
    [query(g, 'avg', [], [], [fn('fill', 'zero', 300)]), 'avg:worker_pool_active_workers{*}.fill(zero)'],
    [query(g, 'avg', [], [], [fn('timeshift', -3600)]), 'timeshift(avg:worker_pool_active_workers{*}, -3600)'],
    [
      query(m, 'sum', [isIn('env', 'a', 'b'), notIn('path', '/x')]),
      'sum:http_server_requests_total{env IN (a,b),path NOT IN (/x)}',
    ],
    [
      query(m, 'sum', [], ['a', 'b'], [fn('as_rate'), fn('abs'), fn('round', 2)]),
      'round(abs(sum:http_server_requests_total{*} by {a,b}.as_rate()), 2)',
    ],
    [query('', 'avg'), 'avg:{*}'],
    [
      query(m, 'sum', [eq('env', 'prod'), or(eq('service', 'api'), eq('service', 'worker')), neq('status', '5*')]),
      'sum:http_server_requests_total{env:prod,(service:api OR service:worker),!status:5*}',
    ],
    [
      query(m, 'sum', [eq('env', 'prod'), not(or(eq('method', 'GET'), eq('method', 'HEAD')))], ['path']),
      'sum:http_server_requests_total{env:prod,NOT (method:GET OR method:HEAD)} by {path}',
    ],
  ])('%#: %s', (q, text) => {
    expect(renderQueryText(q)).toBe(text);
  });

  it('writes dotted modifiers after the query and wraps with the rest, keeping each group in list order', () => {
    expect(
      renderQueryText(query(m, 'sum', [], [], [fn('abs'), fn('as_count'), fn('day_before'), fn('rollup', 'sum', 300)]))
    ).toBe('day_before(abs(sum:http_server_requests_total{*}.as_count().rollup(sum, 300)))');
  });
});

describe('parse(render(q)) round trip', () => {
  const cases: MetricQuery[] = [
    query(g, 'avg'),
    query(m, 'sum', [eq('environment', 'prod'), neq('path', '/health')], ['path'], [fn('as_count')]),
    query(m, 'sum', [eq('path', '/v1/*')]),
    query(m, 'sum', [eq('path', '*')]),
    query(m, 'sum', [isIn('environment', 'prod', 'staging')]),
    query(m, 'sum', [notIn('status_code', '200', '201', '204')]),
    query(m, 'sum', [eq('path', 'a,b')]),
    query(m, 'sum', [eq('path', '/v1/applications/{uuid}/state')]),
    query(m, 'sum', [eq('msg', 'say "hi" \\ there')]),
    query(m, 'sum', [eq('msg', '  padded ')]),
    query(m, 'sum', [isIn('path', '/v1/(x)', 'a,b', 'plain')]),
    query(m, 'sum', [eq('msg', 'this OR that'), neq('msg', 'x AND y')]),
    query(m, 'sum', [eq('url', 'http://checkout.prod.example.com:8000')]),
    query(m, 'sum', [eq('provider', 'café crème')]),
    query(m, 'avg', [], ['environment', 'service_name', 'path']),
    query(m, 'sum', [], ['environment'], [fn('as_rate')]),
    query(g, 'avg', [], [], [fn('fill', 'zero', 300)]),
    query(g, 'avg', [], [], [fn('fill', 'linear', 600)]),
    query(g, 'max', [], ['cluster'], [fn('rollup', 'max', 60)]),
    query(g, 'avg', [], [], [fn('rollup', 'avg', 0)]),
    query(m, 'sum', [], [], [fn('as_count'), fn('fill', 'last', 300), fn('rollup', 'count', 3600)]),
    query(g, 'avg', [], ['service'], [fn('top', 10, 'mean', 'desc')]),
    query(g, 'avg', [], ['service'], [fn('bottom', 5, 'max', 'asc')]),
    query(g, 'avg', [], [], [fn('timeshift', -7200)]),
    query(m, 'sum', [], [], [fn('as_count'), fn('day_before'), fn('abs')]),
    query(g, 'avg', [], [], [fn('round', 2), fn('clamp_min', 0.5), fn('cutoff_max', -1)]),
    query(g, 'avg', [], [], [fn('ewma_10'), fn('median_5'), fn('rollingavg_13')]),
    query(g, 'avg', [], [], [fn('moving_rollup', 600, 'median')]),
    query(m, 'sum', [], ['path'], [fn('as_count'), fn('count_nonzero'), fn('count_not_null')]),
    query(m, 'sum', [], [], [fn('per_second'), fn('diff'), fn('monotonic_diff'), fn('derivative'), fn('throughput')]),
    query(g, 'avg', [], [], [fn('trend_line'), fn('cumsum'), fn('integral'), fn('default_zero'), fn('exclude_null')]),
    query(h, 'p99', [eq('environment', 'prod')], ['provider']),
    query('amazonaws_com_aws_sqs_numberofmessagessent', 'count', [eq('dimensions_queuename', '*-dlq.fifo')]),
    query(m, 'sum', [eq('environment', 'prod'), eq('environment', 'staging')]),
    query(g, 'avg', [], [], [fn('hour_before'), fn('week_before'), fn('month_before')]),
    query(g, 'avg', [], [], [fn('log2'), fn('log10'), fn('ceil'), fn('floor'), fn('per_minute'), fn('per_hour')]),
    query('', 'avg'),
    query('some_metric_not_in_catalog', 'min', [], [], [fn('per_hour')]),
    query(m, 'sum', [eq('env', 'prod'), or(eq('service', 'api'), eq('service', 'worker')), neq('status', '5*')]),
    query(m, 'sum', [not(or(eq('method', 'GET'), isIn('method', 'HEAD', 'OPTIONS')))], ['path'], [fn('as_rate')]),
    query(m, 'sum', [or(and(eq('a', '1'), neq('b', '2')), not(and(eq('c', '3'), notIn('d', 'x,y'))), eq('e', '*'))]),
    query(m, 'sum', [
      or(eq('msg', 'x OR y'), eq('msg', '(a)')),
      not(and(eq('x', '1'), or(eq('y', '2'), eq('z', '3')))),
    ]),
  ];

  it('has at least 30 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases.map((q) => [renderQueryText(q), q] as const))('%s', (_text, q) => {
    const { metric, spaceAgg, filters, groupBy, functions } = q;
    expect(stripIds(roundTrip(q) as Partial<MetricQuery>)).toEqual(
      stripIds({ metric, spaceAgg, filters, groupBy, functions })
    );
  });

  it('puts dotted modifiers first when the list mixed them with wrappers', () => {
    const parsed = roundTrip(query(m, 'sum', [], [], [fn('abs'), fn('as_count'), fn('hour_before')]));
    expect(stripIds(parsed as Partial<MetricQuery>).functions).toEqual([
      { name: 'as_count', args: [] },
      { name: 'abs', args: [] },
      { name: 'hour_before', args: [] },
    ]);
  });
});

describe('parseQueryText', () => {
  const parse = (text: string, catalog = CATALOG) => stripIds(parseQueryText(text, catalog) as Partial<MetricQuery>);

  it('resolves dotted and separator-insensitive metric names against the catalogue', () => {
    expect(parse('avg:http.server_requests.total{*}').metric).toBe('http_server_requests_total');
    expect(parse('sum:http.server.requests.total{*}.as_count()').metric).toBe('http_server_requests_total');
    expect(parse('p95:HTTP.CLIENT.REQUEST.DURATION{*}').metric).toBe('http_client_request_duration');
    expect(parseQueryText('avg:no.such.metric{*}', CATALOG)).toEqual({ error: 'Unknown metric "no.such.metric"' });
    expect(parse('avg:not_listed_yet{*}').metric).toBe('not_listed_yet');
  });

  it('takes the default aggregator of the metric kind when none is written', () => {
    expect(parse('http_server_requests_total{*}').spaceAgg).toBe('sum');
    expect(parse('worker_pool_active_workers{*}').spaceAgg).toBe('avg');
    expect(parse('unknown_metric{*}').spaceAgg).toBe('avg');
  });

  it('accepts the interval-only rollup, bare words, double quotes and loose spacing', () => {
    expect(parse('avg:m{*}.rollup(60)').functions).toEqual([{ name: 'rollup', args: ['avg', 60] }]);
    expect(parse('top(avg:m{*} by {h}, 25, max, "asc")').functions).toEqual([
      { name: 'top', args: [25, 'max', 'asc'] },
    ]);
    expect(parse('  avg : m { env:prod , path:/x }  by { path } .as_count( ) ')).toEqual({
      metric: 'm',
      spaceAgg: 'avg',
      filters: [eq('env', 'prod'), eq('path', '/x')],
      groupBy: ['path'],
      functions: [{ name: 'as_count', args: [] }],
    });
  });

  it('reads by {…} after or between the modifiers too', () => {
    expect(parse('sum:m{env:prod}.as_count() by {path}')).toMatchObject({
      groupBy: ['path'],
      functions: [{ name: 'as_count', args: [] }],
    });
    expect(parse('sum:m{*}.as_rate() by {a,b}.rollup(sum, 60)')).toMatchObject({
      groupBy: ['a', 'b'],
      functions: [
        { name: 'as_rate', args: [] },
        { name: 'rollup', args: ['sum', 60] },
      ],
    });
  });

  it('reads boolean scopes with AND, OR, NOT and parentheses', () => {
    expect(parse('sum:m{env:prod AND (service:api OR service:worker), !status:5*} by {path}')).toMatchObject({
      filters: [eq('env', 'prod'), or(eq('service', 'api'), eq('service', 'worker')), neq('status', '5*')],
      groupBy: ['path'],
    });
    expect(parse('sum:m{env:prod, NOT (method:GET OR method:HEAD)}').filters).toEqual([
      eq('env', 'prod'),
      not(or(eq('method', 'GET'), eq('method', 'HEAD'))),
    ]);
  });

  it.each([
    ['', 'Empty query'],
    ['foo:m{*}', 'Unknown aggregator "foo"'],
    ['avg:m{env:prod', 'Missing "}"'],
    ['avg:m', 'Expected "{" at the end'],
    ['bar(avg:m{*})', 'Unknown function bar()'],
    ['as_count(avg:m{*})', 'as_count() cannot wrap a query'],
    ['pow(avg:m{*}, 2)', 'pow() cannot wrap a query'],
    ['avg:m{*}.weighted()', 'Unknown modifier .weighted()'],
    ['avg:m{*}.fill(sideways)', 'fill(): method must be one of null, zero, linear, last'],
    ['avg:m{*}.rollup(avg, soon)', 'rollup(): seconds must be a number'],
    ['avg:m{*}.rollup(last)', 'rollup(): agg must be one of avg, count, max, min, sum'],
    ['top(avg:m{*}, 7)', 'top(): n must be one of'],
    ['abs(avg:m{*}, 1)', 'abs() takes 0 arguments'],
    ['avg:m{env:prod OR}', 'Expected a filter after "OR"'],
    ['avg:m{(env:prod OR env:staging}', 'Missing ")"'],
    ['avg:m{$env}', 'Template variables are not supported'],
    ['avg:m{*} by {bad-key}', 'Invalid tag key "bad-key"'],
    ['avg:m{*} extra', 'Unexpected text after the query'],
    ['avg:m{*} by {a}.as_count() by {b}', 'Unexpected text after the query: "by {b}"'],
    ['avg:m{*}.as_count', 'Expected "(" at the end'],
    ["top(avg:m{*}, 'mean)", 'Unterminated string'],
  ])('rejects %j', (text, message) => {
    const result = parseQueryText(text, CATALOG);
    expect('error' in result && result.error).toContain(message);
  });
});
