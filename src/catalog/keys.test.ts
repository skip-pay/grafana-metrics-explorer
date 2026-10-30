import labelKeys from './__fixtures__/label-keys.json';
import { isLowPriorityKey, isNoiseKey, sortLabelKeys } from './keys';

// `api/v1/labels` of synthetic streams, one per kind of producer.
function visible(stream: keyof typeof labelKeys): string[] {
  return sortLabelKeys(labelKeys[stream].filter((key) => !isNoiseKey(key, stream)));
}

describe('label keys of metric families', () => {
  it('OTel delta counters keep their dimensions, identity last', () => {
    expect(visible('http_server_requests_total')).toEqual([
      'environment',
      'error_type',
      'host',
      'method',
      'path',
      'service_name',
      'status_code',
      'instance_id',
    ]);
  });

  it('OTel histograms', () => {
    expect(visible('http_client_request_duration_count')).toEqual([
      'environment',
      'host',
      'method',
      'peer_service',
      'service_name',
      'status_code',
      'instance_id',
    ]);
  });

  it('OTel metrics with resource attributes', () => {
    expect(visible('queue_messages_processed')).toEqual([
      'environment',
      'queue',
      'result',
      'service_name',
      'deployment_environment',
      'service_instance_id',
      'service_version',
    ]);
  });

  it('collector and scraped metrics', () => {
    expect(visible('otelcol_process_memory_rss')).toEqual([
      'environment',
      'service_name',
      'server_port',
      'service_instance_id',
      'service_version',
      'url_scheme',
    ]);
    expect(visible('probe_success')).toEqual([
      'environment',
      'instance',
      'job',
      'service_name',
      'server_address',
      'server_port',
      'service_instance_id',
      'url_scheme',
    ]);
  });

  it('gauges', () => {
    expect(visible('worker_pool_active_workers')).toEqual(['cluster', 'pool']);
  });

  it('CloudWatch keeps every dimension and the account, hides the envelope', () => {
    expect(visible('amazonaws_com_aws_rds_cpuutilization')).toEqual([
      'dimensions_dbinstanceidentifier',
      'dimensions_enginename',
      'cloud_account_id',
    ]);
  });

  it('recording rules', () => {
    expect(visible('checkout_orders_5m')).toEqual(['environment', 'payment_method']);
  });
});

describe('isNoiseKey', () => {
  it.each([
    '__name__',
    'aggregation_temporality',
    'start_time',
    'exemplars',
    'flag',
    'is_monotonic',
    'le',
    'quantile',
    'aws_exporter_arn',
    'cloud_provider',
    'cloud_region',
    'telemetry_sdk_language',
    'instrumentation_library_name',
  ])('hides %s', (key) => {
    expect(isNoiseKey(key, 'http_server_requests_total')).toBe(true);
  });

  it.each(['environment', 'instance_id', 'cloud_account_id', 'dimensions_queuename', 'le_bucket', 'host', 'namespace'])(
    'shows %s',
    (key) => {
      expect(isNoiseKey(key, 'kube_pod_container_status_restarts_total')).toBe(false);
    }
  );

  it('hides the namespace and metric name only on CloudWatch streams', () => {
    expect(isNoiseKey('namespace', 'amazonaws_com_aws_rds_cpuutilization')).toBe(true);
    expect(isNoiseKey('metricname', 'amazonaws_com_aws_rds_cpuutilization')).toBe(true);
    expect(isNoiseKey('metricname', 'http_server_requests_total')).toBe(false);
  });

  it('ranks per-process identity low', () => {
    expect(isLowPriorityKey('instance_id')).toBe(true);
    expect(isLowPriorityKey('environment')).toBe(false);
  });
});
