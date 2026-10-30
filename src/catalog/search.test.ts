import { MetricInfo } from '../model/types';
import names from './__fixtures__/label-name-values.json';
import metadata from './__fixtures__/metadata.json';
import { buildMetrics } from './metrics';
import { searchMetrics, searchTags } from './search';
import { Metadata, MetricMatch, TagPair } from './types';

const metrics = buildMetrics(names.data, metadata.data as Metadata);
const rawStreams: MetricInfo[] = names.data.map((name) => ({ name, kind: 'gauge', streams: { base: name } }));

function top(query: string, n = 5): string[] {
  return searchMetrics(query, metrics, n).map((m) => m.metric.name);
}

function highlighted(match: MetricMatch): string[] {
  return match.ranges.map(([start, end]) => match.metric.name.slice(start, end));
}

describe('searchMetrics', () => {
  it('ranks an exact name first', () => {
    const [first] = searchMetrics('http_server_requests_total', metrics);
    expect(first.metric.name).toBe('http_server_requests_total');
    expect(first.ranges).toEqual([[0, 26]]);
  });

  it('treats dots, dashes and spaces as underscores', () => {
    expect(top('http.server', 1)).toEqual(['http_server_requests_total']);
    expect(top('http.server.request', 2)).toEqual(['http_server_requests_total', 'http_server_request_duration']);
    expect(top('HTTP-Server Requests Total', 1)).toEqual(['http_server_requests_total']);
    const prefixed = metrics.filter((m) => m.name.startsWith('http_server_')).length;
    const hits = searchMetrics('http.server', metrics);
    expect(hits.slice(0, prefixed).every((m) => m.metric.name.startsWith('http_server_'))).toBe(true);
  });

  it('finds words in the middle of a name', () => {
    expect(top('server requests')).toContain('http_server_requests_total');
    expect(top('requests total', 2)).toEqual(['http_client_requests_total', 'http_server_requests_total']);
    expect(top('client.request.duration', 1)).toEqual(['http_client_request_duration']);
    expect(top('queue.task', 3)).toEqual([
      'job_queue_tasks_total',
      'job_queue_task_duration',
      'job_queue_task_wait_time',
    ]);
  });

  it('ranks prefix over token prefix over loose matches', () => {
    const [prefix] = searchMetrics('worker_pool', metrics);
    const [token] = searchMetrics('pool_active', metrics);
    const [loose] = searchMetrics('active workers pool', metrics);
    expect([prefix.metric.name, token.metric.name, loose.metric.name]).toEqual([
      'worker_pool_active_workers',
      'worker_pool_active_workers',
      'worker_pool_active_workers',
    ]);
    expect(prefix.score).toBeGreaterThan(token.score);
    expect(token.score).toBeGreaterThan(loose.score);
  });

  it('matches several words in order inside glued CloudWatch names', () => {
    const hits = searchMetrics('cpu util', metrics, 5);
    expect(hits.map((m) => m.metric.name)).toEqual([
      'amazonaws_com_aws_es_cpuutilization',
      'amazonaws_com_aws_ec2_cpuutilization',
      'amazonaws_com_aws_ecs_cpuutilization',
      'amazonaws_com_aws_rds_cpuutilization',
      'amazonaws_com_aws_elasticache_cpuutilization',
    ]);
    expect(highlighted(hits[0])).toEqual(['cpuutil']);
  });

  it('prefers whole-word matches', () => {
    expect(top('rds cpu', 5)).toContain('amazonaws_com_aws_rds_cpuutilization');
    expect(top('messages', 2)).toEqual(['queue_messages_deleted', 'queue_messages_processed']);
    expect(top('messages', 10)).toContain('amazonaws_com_aws_sqs_numberofmessagessent');
    expect(top('rds read lat', 1)).toEqual(['amazonaws_com_aws_rds_readlatency']);
    expect(top('freeable')).toEqual([
      'amazonaws_com_aws_rds_freeablememory',
      'amazonaws_com_aws_elasticache_freeablememory',
    ]);
  });

  it('accepts words in any order below words in order', () => {
    const [inOrder] = searchMetrics('queue messages', metrics);
    const [anyOrder] = searchMetrics('messages queue', metrics);
    expect(anyOrder.metric.name).toBe('queue_messages_deleted');
    expect(anyOrder.score).toBeLessThan(inOrder.score);
    expect(highlighted(anyOrder)).toEqual(['queue', 'messages']);
  });

  it('falls back to a subsequence for abbreviations and typos', () => {
    const [hit] = searchMetrics('wrkractive', metrics);
    expect(hit.metric.name).toBe('worker_pool_active_workers');
    expect(hit.score).toBeLessThan(500);
    expect(top('htsrvreq', 3)).toContain('http_server_requests_total');
    expect(top('otel mem', 1)).toEqual(['otelcol_process_memory_rss']);
  });

  it('drops scattered-character matches once a word matches', () => {
    expect(top('https', 1000)).toContain('amazonaws_com_aws_elasticache_gettypecmdslatency');
    const hits = searchMetrics('http.s', metrics, 1000);
    expect(hits.every((m) => m.score >= 500)).toBe(true);
    expect(hits.map((m) => m.metric.name)).not.toContain('amazonaws_com_aws_elasticache_gettypecmdslatency');
  });

  it('does not scatter one or two characters', () => {
    expect(searchMetrics('qu', metrics, 1000).every((m) => m.metric.name.includes('qu'))).toBe(true);
    expect(searchMetrics('zzzzz', metrics)).toEqual([]);
  });

  it('lists metrics by name for an empty query', () => {
    const hits = searchMetrics('  ', metrics, 3);
    expect(hits.map((m) => m.metric.name)).toEqual(metrics.slice(0, 3).map((m) => m.name));
    expect(hits[0]).toMatchObject({ score: 0, ranges: [] });
  });

  it('honours the limit and defaults to 100', () => {
    expect(searchMetrics('', rawStreams)).toHaveLength(100);
    expect(searchMetrics('amazonaws', metrics, 7)).toHaveLength(7);
  });

  it('returns ranges inside the name, sorted and not overlapping', () => {
    for (const q of ['cpu util', 'queue messages', 'htsrvreq', 'messages queue', 'http.server']) {
      for (const hit of searchMetrics(q, metrics)) {
        let last = 0;
        for (const [start, end] of hit.ranges) {
          expect(start).toBeGreaterThanOrEqual(last);
          expect(end).toBeGreaterThan(start);
          expect(end).toBeLessThanOrEqual(hit.metric.name.length);
          last = end;
        }
      }
    }
  });

  it('runs 1000 searches over the catalogue in well under 2 s', () => {
    const queries = [
      'cpu util',
      'http.server',
      'requests total',
      'rds cpu',
      'queue messages',
      'htsrvreq',
      'a',
      'latency',
    ];
    for (const list of [metrics, rawStreams]) {
      searchMetrics('warm up', list);
      const started = performance.now();
      for (let i = 0; i < 1000; i++) {
        searchMetrics(queries[i % queries.length], list);
      }
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe('searchTags', () => {
  const pairs: TagPair[] = [
    { key: 'environment', value: 'dev' },
    { key: 'environment', value: 'preview' },
    { key: 'environment', value: 'prod' },
    { key: 'environment', value: 'staging' },
    { key: 'service_name', value: 'web' },
    { key: 'service_name', value: 'api-public' },
    { key: 'service_name', value: 'api-billing' },
    { key: 'path', value: '/v1/sessions' },
    { key: 'path', value: '/v1/products' },
    { key: 'status_code', value: '200' },
    { key: 'status_code', value: '1000' },
    { key: 'status_code', value: '404' },
    { key: 'service_instance_id', value: 'worker-prod-1' },
    { key: 'url', value: 'http://checkout.prod.example.com:8000' },
  ];

  function labels(query: string, limit?: number): string[] {
    return searchTags(query, pairs, limit).map((m) => `${m.negated ? '!' : ''}${m.pair.key}:${m.pair.value}`);
  }

  it('ranks values and keys like metric names', () => {
    expect(labels('prod', 1)).toEqual(['environment:prod']);
    expect(labels('api public', 1)).toEqual(['service_name:api-public']);
    expect(labels('sessions')).toEqual(['path:/v1/sessions']);
  });

  it('drops scattered-character matches once a word matches', () => {
    expect(labels('env')).toEqual([
      'environment:dev',
      'environment:prod',
      'environment:preview',
      'environment:staging',
    ]);
  });

  it('puts low-priority keys after useful ones on equal scores', () => {
    expect(labels('prod')).toEqual([
      'environment:prod',
      'path:/v1/products',
      'url:http://checkout.prod.example.com:8000',
      'service_instance_id:worker-prod-1',
    ]);
  });

  it('narrows to a key with key:', () => {
    expect(labels('status_code:')).toEqual(['status_code:200', 'status_code:404', 'status_code:1000']);
    expect(labels('environment:pro')).toEqual(['environment:prod']);
    expect(labels('env:p')).toEqual(['environment:prod', 'environment:preview']);
    expect(labels('service.name:api')).toEqual(['service_name:api-public', 'service_name:api-billing']);
  });

  it('highlights the key and the value inside key:value', () => {
    const [hit] = searchTags('environment:prod', pairs);
    expect(hit.ranges).toEqual([
      [0, 11],
      [12, 16],
    ]);
    const [free] = searchTags('api bil', pairs);
    const text = `${free.pair.key}:${free.pair.value}`;
    expect(free.ranges.map(([s, e]) => text.slice(s, e))).toEqual(['api-bil']);
  });

  it('strips a leading ! for matching and reports it', () => {
    expect(labels('!environment:prod')).toEqual(['!environment:prod']);
    expect(labels('! prod', 1)).toEqual(['!environment:prod']);
  });

  it('matches values containing a colon when the text before it names no key', () => {
    expect(labels('http://checkout')).toEqual(['url:http://checkout.prod.example.com:8000']);
  });

  it('lists pairs grouped by key for an empty query', () => {
    expect(labels('', 5)).toEqual([
      'environment:dev',
      'environment:preview',
      'environment:prod',
      'environment:staging',
      'path:/v1/products',
    ]);
    expect(labels('').slice(-2)).toEqual([
      'url:http://checkout.prod.example.com:8000',
      'service_instance_id:worker-prod-1',
    ]);
  });
});
