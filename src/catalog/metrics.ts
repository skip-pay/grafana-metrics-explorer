import { MetricInfo, MetricKind, MetricStreams } from '../model/types';
import { Metadata, MetadataEntry } from './types';
import { cloudWatchUnit, UnitInfo, unitFromMetadata, unitFromName } from './units';

const HISTOGRAM_PARTS = ['count', 'sum', 'min', 'max'] as const;

/** CloudWatch metric-stream names, including custom namespaces (`amazonaws_com_<namespace>_…`). */
export function isCloudWatchName(name: string): boolean {
  return name.startsWith('amazonaws_com_');
}

/**
 * Collapses raw stream names into logical metrics: `X_bucket` families into one distribution,
 * CloudWatch `X` + `X_sum` + `X_count` into one cloudwatch metric, every other name stays itself.
 */
export function buildMetrics(names: string[], metadata: Metadata): MetricInfo[] {
  const all = new Set(names);
  const sorted = [...all].sort();
  const used = new Set<string>();
  const metrics: MetricInfo[] = [];
  const add = (name: string, kind: MetricKind, streams: MetricStreams) => {
    Object.values(streams).forEach((stream) => used.add(stream));
    metrics.push(describe(name, kind, streams, metadata[name]?.[0]));
  };

  for (const name of sorted) {
    if (name.endsWith('_bucket')) {
      const family = name.slice(0, -'_bucket'.length);
      const streams: MetricStreams = { bucket: name };
      if (all.has(family)) {
        streams.base = family;
      }
      for (const part of HISTOGRAM_PARTS) {
        if (all.has(`${family}_${part}`)) {
          streams[part] = `${family}_${part}`;
        }
      }
      add(family, 'distribution', streams);
    }
  }
  for (const name of sorted) {
    const sum = `${name}_sum`;
    const count = `${name}_count`;
    if (
      isCloudWatchName(name) &&
      !used.has(name) &&
      all.has(sum) &&
      all.has(count) &&
      !used.has(sum) &&
      !used.has(count)
    ) {
      add(name, 'cloudwatch', { base: name, sum, count });
    }
  }
  for (const name of sorted) {
    if (!used.has(name)) {
      add(name, initialKind(name, metadata[name]?.[0]), { base: name });
    }
  }
  return metrics.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Counters stay provisional (`delta_counter`) until `resolve()` reads their temporality. */
function initialKind(name: string, meta?: MetadataEntry): MetricKind {
  if (meta?.type === 'histogram') {
    return 'distribution';
  }
  return meta?.type === 'counter' || name.endsWith('_total') ? 'delta_counter' : 'gauge';
}

function describe(name: string, kind: MetricKind, streams: MetricStreams, meta?: MetadataEntry): MetricInfo {
  const unit: UnitInfo | undefined =
    kind === 'cloudwatch' ? cloudWatchUnit(name) : (unitFromMetadata(meta?.unit ?? '') ?? unitFromName(name));
  return {
    name,
    kind,
    streams,
    ...unit,
    ...(meta?.help ? { help: meta.help } : {}),
    ...(meta?.type ? { metadataType: meta.type } : {}),
  };
}

/**
 * The stream whose labels describe the metric: a histogram's bare stream holds no samples, so
 * distributions use `_count`; others use the bare stream.
 */
export function labelStream(metric: Pick<MetricInfo, 'name' | 'kind' | 'streams'>): string {
  const s = metric.streams;
  const stream =
    metric.kind === 'distribution' ? (s.count ?? s.bucket ?? s.base) : (s.base ?? s.count ?? s.sum ?? s.bucket);
  return stream ?? metric.name;
}
