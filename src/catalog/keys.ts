import { isCloudWatchName } from './metrics';

// Storage identity, OTel bookkeeping and CloudWatch envelope labels; each has 0–1 values or one per row.
const NOISE_KEYS = new Set([
  '__name__',
  'aggregation_temporality',
  'aws_exporter_arn',
  'cloud_provider',
  'cloud_region',
  'exemplars',
  'flag',
  'is_monotonic',
  'le',
  'quantile',
  'start_time',
]);
const NOISE_PREFIXES = ['instrumentation_library_', 'telemetry_sdk_'];
// A CloudWatch metric stream repeats the namespace and metric name its stream name already holds.
const CLOUDWATCH_NOISE_KEYS = new Set(['metricname', 'namespace']);

// Per-process identity or duplicates of another key: offered, but after the useful dimensions.
const LOW_PRIORITY_KEYS = new Set([
  'cloud_account_id',
  'deployment_environment',
  'ecs_cluster',
  'instance_id',
  'network_protocol_version',
  'server_address',
  'server_port',
  'service_instance_id',
  'service_version',
  'url_scheme',
]);

/** Label keys of `metric` hidden from tag and group-by suggestions unless "show all" is on. */
export function isNoiseKey(key: string, metric: string): boolean {
  return isBookkeepingKey(key) || (isCloudWatchName(metric) && CLOUDWATCH_NOISE_KEYS.has(key));
}

function isBookkeepingKey(key: string): boolean {
  return NOISE_KEYS.has(key) || NOISE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/** Keys listed after the useful dimensions in suggestions. */
export function isLowPriorityKey(key: string): boolean {
  return LOW_PRIORITY_KEYS.has(key);
}

/** 0 useful, 1 low priority, 2 noise. */
export function keyRank(key: string): number {
  return isBookkeepingKey(key) ? 2 : isLowPriorityKey(key) ? 1 : 0;
}

/** Useful keys first, then low-priority keys, then noise; alphabetical within each group. */
export function sortLabelKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => keyRank(a) - keyRank(b) || (a < b ? -1 : a > b ? 1 : 0));
}
