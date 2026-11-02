import { urlUtil } from '@grafana/data';

import { renderQueryText } from '../compile';
import { MetricInfo } from '../model/types';
import { readLinkParams } from '../model/url';
import { stateFromLink } from './deepLink';

jest.mock('@grafana/runtime', () => ({ locationService: {} }));

const metrics: MetricInfo[] = [
  { name: 'http_requests_total', kind: 'cumulative_counter', streams: { base: 'http_requests_total' } },
  { name: 'node_load1', kind: 'gauge', streams: { base: 'node_load1' } },
  { name: 'node_cpu_seconds_total', kind: 'cumulative_counter', streams: { base: 'node_cpu_seconds_total' } },
  {
    name: 'amazonaws_com_aws_sqs_sentmessagesize',
    kind: 'cloudwatch',
    streams: {
      base: 'amazonaws_com_aws_sqs_sentmessagesize',
      sum: 'amazonaws_com_aws_sqs_sentmessagesize_sum',
      count: 'amazonaws_com_aws_sqs_sentmessagesize_count',
    },
  },
];

const REQUESTS = 'sum:http_requests_total{job:api,!status:5*} by {service}.as_count()';
const LOAD = 'avg:node_load1{*}';
const TOP = "top(avg:node_cpu_seconds_total{mode:idle} by {cpu}, 5, 'mean', 'desc')";

/** The link as Grafana's location service reads it. */
const parseSearch = (search: string) => readLinkParams(urlUtil.parseKeyValue(search))!;

describe('stateFromLink', () => {
  it('reads the _sum and _count streams of a CloudWatch metric as its sum and count', () => {
    const link = parseSearch(
      'q=sum%3Aamazonaws_com_aws_sqs_sentmessagesize_sum%7Bqueuename%3Aorders%7D%20by%20%7Bqueuename%7D' +
        '&q=sum%3Aamazonaws_com_aws_sqs_sentmessagesize_count%7Bqueuename%3Aorders%7D%20by%20%7Bqueuename%7D&f=a%2Fb'
    );
    const { state, warning } = stateFromLink(link, metrics);
    expect(warning).toBeUndefined();
    expect(state.queries.map((q) => renderQueryText(q))).toEqual([
      'sum:amazonaws_com_aws_sqs_sentmessagesize{queuename:orders} by {queuename}',
      'count:amazonaws_com_aws_sqs_sentmessagesize{queuename:orders} by {queuename}',
    ]);
    expect(state.formulas.map((f) => f.expression)).toEqual(['a/b']);
  });

  it('builds one row per q, lettered in order', () => {
    const { state, warning } = stateFromLink({ q: [REQUESTS, LOAD, TOP] }, metrics);
    expect(warning).toBeUndefined();
    expect(state.queries.map((q) => [q.letter, q.hidden, renderQueryText(q)])).toEqual([
      ['a', false, REQUESTS],
      ['b', false, LOAD],
      ['c', false, TOP],
    ]);
    expect(state.queries[0]).toMatchObject({
      metric: 'http_requests_total',
      spaceAgg: 'sum',
      filters: [
        { key: 'job', op: 'eq', values: ['api'] },
        { key: 'status', op: 'neq', values: ['5*'] },
      ],
      groupBy: ['service'],
    });
    expect(new Set(state.queries.map((q) => q.id)).size).toBe(3);
    expect(state).toMatchObject({ viz: 'timeseries', formulas: [], split: { key: null } });
  });

  it('reads boolean filters with AND, OR, NOT and parentheses', () => {
    const { state, warning } = stateFromLink(
      { q: ['sum:http_requests_total{env:prod AND (service:api OR service:worker), NOT (method:GET OR method:HEAD)}'] },
      metrics
    );
    expect(warning).toBeUndefined();
    expect(state.queries[0].filters).toEqual([
      { key: 'env', op: 'eq', values: ['prod'] },
      {
        op: 'or',
        items: [
          { key: 'service', op: 'eq', values: ['api'] },
          { key: 'service', op: 'eq', values: ['worker'] },
        ],
      },
      {
        op: 'or',
        negated: true,
        items: [
          { key: 'method', op: 'eq', values: ['GET'] },
          { key: 'method', op: 'eq', values: ['HEAD'] },
        ],
      },
    ]);
    expect(renderQueryText(state.queries[0])).toBe(
      'sum:http_requests_total{env:prod,(service:api OR service:worker),NOT (method:GET OR method:HEAD)}'
    );
  });

  it('resolves dotted names against the catalogue and takes the default aggregator of the kind', () => {
    const { state } = stateFromLink({ q: ['node.load1{*}', 'http.requests.total{*}'] }, metrics);
    expect(state.queries.map((q) => [q.metric, q.spaceAgg])).toEqual([
      ['node_load1', 'avg'],
      ['http_requests_total', 'sum'],
    ]);
  });

  it('adds formulas and hides the query rows', () => {
    const { state, warning } = stateFromLink({ q: [REQUESTS, LOAD], f: ['a/b*100', 'a + 1'] }, metrics);
    expect(warning).toBeUndefined();
    expect(state.queries.map((q) => q.hidden)).toEqual([true, true]);
    expect(state.formulas.map((f) => [f.expression, f.hidden])).toEqual([
      ['a/b*100', false],
      ['a + 1', false],
    ]);
    expect(state.formulas[0].id).not.toBe(state.formulas[1].id);
  });

  it('applies viz, display and split', () => {
    const { state, warning } = stateFromLink(
      { q: [LOAD], viz: ['toplist'], display: ['bars'], split: ['instance'] },
      metrics
    );
    expect(warning).toBeUndefined();
    expect(state.viz).toBe('toplist');
    expect(state.display.display).toBe('bars');
    expect(state.split).toEqual({ byQuery: false, key: 'instance', limit: 24, order: 'top', sortBy: 'avg' });
  });

  it('keeps what parsed and names every parameter that did not', () => {
    const { state, warning } = stateFromLink(
      {
        q: ['avg:node_load1{', LOAD],
        f: ['a*2', 'b/', 'b*2'],
        viz: ['pie'],
        display: ['dots'],
        split: ['not a key'],
      },
      metrics
    );
    // The letter follows the position, so `b` is still the second q.
    expect(state.queries.map((q) => [q.letter, q.metric, q.hidden])).toEqual([['b', 'node_load1', true]]);
    expect(state.formulas.map((f) => f.expression)).toEqual(['b*2']);
    expect(state).toMatchObject({ viz: 'timeseries', display: { display: 'lines' }, split: { key: null } });
    expect(warning).toMatch(/^Ignored link parameters: /);
    for (const name of [
      'q=avg:node_load1{ (',
      'f=a*2 (',
      'f=b/ (',
      'viz=pie (not one of timeseries',
      'display=dots (',
    ]) {
      expect(warning).toContain(name);
    }
    expect(warning).toContain('split=not a key (not a tag key)');
  });

  it('starts from one empty query when no q parsed', () => {
    const { state, warning } = stateFromLink({ q: ['nonsense'], viz: ['table'] }, metrics);
    expect(state.queries.map((q) => [q.letter, q.metric])).toEqual([['a', '']]);
    expect(state.viz).toBe('table');
    expect(warning).toContain('q=nonsense');
  });

  it('takes at most 26 queries', () => {
    const { state, warning } = stateFromLink({ q: Array.from({ length: 27 }, () => LOAD) }, metrics);
    expect(state.queries).toHaveLength(26);
    expect(state.queries[25].letter).toBe('z');
    expect(warning).toContain('at most 26 queries');
  });
});

describe('readable links in the URL', () => {
  it('round-trips encoded values with braces, commas, quotes and spaces', () => {
    const q = [
      REQUESTS,
      TOP,
      'max:http_requests_total{path:"/a, b"} by {service,job}.rollup(max, 60)',
      'sum:http_requests_total{env:prod,(service:api OR service:worker),NOT (method:GET OR path:"/a OR b")}',
    ];
    const f = ['(a + b) / 2', "top(a, 10, 'max', 'asc')"];
    const encoded = [...q.map((v) => `q=${encodeURIComponent(v)}`), ...f.map((v) => `f=${encodeURIComponent(v)}`)];
    const link = parseSearch(`${encoded.join('&')}&viz=timeseries&from=now-6h`);
    expect(link).toEqual({ q, f, viz: ['timeseries'] });

    const { state, warning } = stateFromLink(link, metrics);
    expect(warning).toBeUndefined();
    expect(state.queries.map((q) => renderQueryText(q))).toEqual(q);
    expect(state.formulas.map((x) => x.expression)).toEqual(f);
  });

  it('reads form encoding, where a space is `+`', () => {
    const search = new URLSearchParams([
      ['q', LOAD],
      ['q', 'sum:http_requests_total{*} by {service}'],
      ['f', 'a+b'],
    ]).toString();
    expect(search).toContain('+by+');
    expect(parseSearch(search)).toEqual({ q: [LOAD, 'sum:http_requests_total{*} by {service}'], f: ['a+b'] });
  });

  it('reads raw braces, commas and quotes typed into the address bar', () => {
    expect(parseSearch(`q=${TOP}&split=cpu`)).toEqual({ q: [TOP], split: ['cpu'] });
  });

  it('turns values Grafana parses as numbers or booleans back into text, and a broken encoding into empty text', () => {
    expect(parseSearch('f=100&f=2&viz=true&q=%E0%A4%A')).toEqual({ f: ['100', '2'], viz: ['true'], q: [''] });
    const { warning } = stateFromLink(parseSearch('q=%E0%A4%A'), metrics);
    expect(warning).toContain('q= (');
  });
});
