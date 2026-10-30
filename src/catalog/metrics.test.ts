import { MetricInfo } from '../model/types';
import names from './__fixtures__/label-name-values.json';
import metadata from './__fixtures__/metadata.json';
import { buildMetrics, isCloudWatchName, labelStream } from './metrics';
import { Metadata } from './types';

// A synthetic `api/v1/label/__name__/values` and `api/v1/metadata` of OTel, scraped, recording-rule and CloudWatch
// streams.
const metrics = buildMetrics(names.data, metadata.data as Metadata);
const byName = new Map(metrics.map((m) => [m.name, m]));

function metric(name: string): MetricInfo {
  const found = byName.get(name);
  if (!found) {
    throw new Error(`${name} is not a logical metric`);
  }
  return found;
}

describe('buildMetrics', () => {
  it('collapses the stream names into logical metrics', () => {
    expect(names.data).toHaveLength(180);
    expect(metrics).toHaveLength(84);
    const kinds: Record<string, number> = {};
    metrics.forEach((m) => (kinds[m.kind] = (kinds[m.kind] ?? 0) + 1));
    expect(kinds).toEqual({ cloudwatch: 31, gauge: 28, delta_counter: 16, distribution: 9 });
  });

  it('keeps every stream in exactly one logical metric', () => {
    const streams = metrics.flatMap((m) => Object.values(m.streams));
    expect(new Set(streams).size).toBe(streams.length);
    expect([...streams].sort()).toEqual([...names.data].sort());
  });

  it('sorts by name and has unique names', () => {
    const sorted = metrics.map((m) => m.name);
    expect(sorted).toEqual([...sorted].sort());
    expect(byName.size).toBe(metrics.length);
  });

  it('makes a histogram family one distribution', () => {
    expect(metric('http_client_request_duration')).toEqual({
      name: 'http_client_request_duration',
      kind: 'distribution',
      streams: {
        base: 'http_client_request_duration',
        bucket: 'http_client_request_duration_bucket',
        count: 'http_client_request_duration_count',
        sum: 'http_client_request_duration_sum',
        min: 'http_client_request_duration_min',
        max: 'http_client_request_duration_max',
      },
      unit: 'ms',
      unitLabel: 'Milliseconds',
      help: 'Duration of HTTP requests sent.',
      metadataType: 'histogram',
    });
    expect(byName.has('http_client_request_duration_bucket')).toBe(false);
    expect(byName.has('http_client_request_duration_count')).toBe(false);
  });

  it('makes a family without a bare stream or metadata one distribution', () => {
    expect(metric('prometheus_http_request_duration_seconds')).toEqual({
      name: 'prometheus_http_request_duration_seconds',
      kind: 'distribution',
      streams: {
        bucket: 'prometheus_http_request_duration_seconds_bucket',
        count: 'prometheus_http_request_duration_seconds_count',
        sum: 'prometheus_http_request_duration_seconds_sum',
      },
      unit: 's',
      unitLabel: 'Seconds',
    });
  });

  it('makes a CloudWatch summary one cloudwatch metric', () => {
    expect(metric('amazonaws_com_aws_rds_cpuutilization')).toEqual({
      name: 'amazonaws_com_aws_rds_cpuutilization',
      kind: 'cloudwatch',
      streams: {
        base: 'amazonaws_com_aws_rds_cpuutilization',
        sum: 'amazonaws_com_aws_rds_cpuutilization_sum',
        count: 'amazonaws_com_aws_rds_cpuutilization_count',
      },
      unit: 'percent',
      unitLabel: 'Percent',
    });
    expect(byName.has('amazonaws_com_aws_rds_cpuutilization_sum')).toBe(false);
  });

  it('handles CloudWatch metrics whose own name ends in _count', () => {
    expect(metric('amazonaws_com_aws_applicationelb_httpcode_target_5xx_count').streams).toEqual({
      base: 'amazonaws_com_aws_applicationelb_httpcode_target_5xx_count',
      sum: 'amazonaws_com_aws_applicationelb_httpcode_target_5xx_count_sum',
      count: 'amazonaws_com_aws_applicationelb_httpcode_target_5xx_count_count',
    });
    expect(byName.has('amazonaws_com_aws_applicationelb_httpcode_target_5xx')).toBe(false);
  });

  it('treats custom CloudWatch namespaces like AWS ones', () => {
    expect(metric('amazonaws_com_shop_queuedepth')).toMatchObject({ kind: 'cloudwatch', unit: 'short' });
    expect(metric('amazonaws_com_cloudwatchsynthetics_successpercent')).toMatchObject({
      kind: 'cloudwatch',
      unit: 'percent',
    });
  });

  it('keeps a CloudWatch stream without _sum and _count a plain metric', () => {
    expect(metric('amazonaws_com_aws_rds_dbload')).toEqual({
      name: 'amazonaws_com_aws_rds_dbload',
      kind: 'gauge',
      streams: { base: 'amazonaws_com_aws_rds_dbload' },
    });
    expect(isCloudWatchName('amazonaws_com_aws_rds_dbload')).toBe(true);
    expect(isCloudWatchName('aws_rds_dbload')).toBe(false);
  });

  it('infers counters from metadata or a _total suffix, provisionally as delta', () => {
    expect(metric('http_server_requests_total')).toEqual({
      name: 'http_server_requests_total',
      kind: 'delta_counter',
      streams: { base: 'http_server_requests_total' },
      unit: 'short',
      unitLabel: 'Requests',
      help: 'HTTP requests served.',
      metadataType: 'counter',
    });
    expect(metric('queue_messages_processed').kind).toBe('delta_counter');
    expect(metric('loadgen_iterations_total')).toEqual({
      name: 'loadgen_iterations_total',
      kind: 'delta_counter',
      streams: { base: 'loadgen_iterations_total' },
    });
  });

  it('infers gauges', () => {
    expect(metric('worker_pool_active_workers')).toMatchObject({
      kind: 'gauge',
      unit: 'short',
      unitLabel: 'Workers',
      metadataType: 'gauge',
    });
    expect(metric('http_server_active_requests')).toMatchObject({ kind: 'gauge', unitLabel: 'Requests' });
    expect(metric('node_load1')).toEqual({ name: 'node_load1', kind: 'gauge', streams: { base: 'node_load1' } });
    expect(metric('checkout_orders_5m').kind).toBe('gauge');
    expect(metric('service:http_server_requests:rate5m').kind).toBe('gauge');
  });

  it('keeps _count/_sum/_bucket names without the family pattern separate', () => {
    expect(metric('otelcol_processor_tail_sampling_sampling_policy_execution_count')).toMatchObject({
      kind: 'delta_counter',
      streams: { base: 'otelcol_processor_tail_sampling_sampling_policy_execution_count' },
    });
    expect(metric('service:http_server_request_duration_bucket:rate5m').kind).toBe('gauge');
    expect(metric('checkout_order_value_sum_1h').kind).toBe('gauge');
  });

  it('gives every CloudWatch metric a unit', () => {
    expect(metrics.filter((m) => m.kind === 'cloudwatch' && !m.unit)).toEqual([]);
  });

  it.each([
    ['http_server_request_duration', 'ms', 'Milliseconds'],
    ['job_queue_task_wait_time', 's', 'Seconds'],
    ['job_queue_task_duration', 's', 'Seconds'],
    ['queue_batch_size', 'short', 'Messages'],
    ['checkout_order_value', 'short', undefined],
    ['checkout_payments_failed_total', undefined, undefined],
    ['otelcol_process_memory_rss', 'bytes', 'Bytes'],
    ['otelcol_process_cpu_seconds', 's', 'Seconds'],
    ['node_memory_MemAvailable_bytes', 'bytes', 'Bytes'],
    ['node_network_receive_bytes_total', 'bytes', 'Bytes'],
    ['node_cpu_seconds_total', 's', 'Seconds'],
    ['probe_duration_seconds', 's', 'Seconds'],
    ['probe_http_last_modified_timestamp_seconds', undefined, undefined],
    ['api_usage_cost_usd', 'currencyUSD', 'USD'],
    ['api_rate_limit_used_percentage', 'percent', 'Percent'],
    ['amazonaws_com_aws_ecs_cpuutilization', 'percent', 'Percent'],
    ['amazonaws_com_aws_ecs_memoryreservation', 'percent', 'Percent'],
    ['amazonaws_com_aws_rds_freeablememory', 'bytes', 'Bytes'],
    ['amazonaws_com_aws_rds_readlatency', 's', 'Seconds'],
    ['amazonaws_com_aws_rds_commitlatency', 'ms', 'Milliseconds'],
    ['amazonaws_com_aws_rds_osmemoryfree', 'kbytes', 'Kilobytes'],
    ['amazonaws_com_aws_rds_osmemoryhugepagesfree', 'short', undefined],
    ['amazonaws_com_aws_rds_readthroughput', 'Bps', 'Bytes/s'],
    ['amazonaws_com_aws_rds_readiops', 'iops', 'IOPS'],
    ['amazonaws_com_aws_rds_volumereadiops', 'short', undefined],
    ['amazonaws_com_aws_rds_cpucreditbalance', 'short', undefined],
    ['amazonaws_com_aws_rds_ebsbytebalance', 'percent', 'Percent'],
    ['amazonaws_com_aws_es_freestoragespace', 'mbytes', 'Megabytes'],
    ['amazonaws_com_aws_es_searchlatency', 'ms', 'Milliseconds'],
    ['amazonaws_com_aws_es_jvmmemorypressure', 'percent', 'Percent'],
    ['amazonaws_com_aws_elasticache_gettypecmdslatency', 'µs', 'Microseconds'],
    ['amazonaws_com_aws_lambda_duration', 'ms', 'Milliseconds'],
    ['amazonaws_com_aws_sqs_approximateageofoldestmessage', 's', 'Seconds'],
    ['amazonaws_com_aws_sqs_numberofmessagessent', 'short', undefined],
    ['amazonaws_com_aws_sqs_sentmessagesize', 'bytes', 'Bytes'],
    ['amazonaws_com_aws_applicationelb_targetresponsetime', 's', 'Seconds'],
    ['amazonaws_com_aws_ec2_networkin', 'bytes', 'Bytes'],
    ['amazonaws_com_aws_ebs_volumeavgreadlatency', 'ms', 'Milliseconds'],
  ])('unit of %s is %s', (name, unit, unitLabel) => {
    const m = metric(name);
    expect([m.unit, m.unitLabel]).toEqual([unit, unitLabel]);
  });
});

describe('labelStream', () => {
  it('reads labels from _count for distributions, whose bare stream has no samples', () => {
    expect(labelStream(metric('http_client_request_duration'))).toBe('http_client_request_duration_count');
    expect(labelStream(metric('prometheus_http_request_duration_seconds'))).toBe(
      'prometheus_http_request_duration_seconds_count'
    );
  });

  it('reads labels from the bare stream otherwise', () => {
    expect(labelStream(metric('amazonaws_com_aws_rds_cpuutilization'))).toBe('amazonaws_com_aws_rds_cpuutilization');
    expect(labelStream(metric('http_server_requests_total'))).toBe('http_server_requests_total');
  });
});
