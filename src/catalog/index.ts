import { getDataSourceSrv } from '@grafana/runtime';

import { filtersToMatchers } from '../compile';
import { MetricInfo, MetricKind, ResolvedMetric, TagFilter } from '../model/types';
import { memo, runPool, TtlCache } from './cache';
import {
  CADENCE_WINDOWS_SEC,
  cadenceFromCounts,
  cadenceQuery,
  CLOUDWATCH_CADENCE_SEC,
  DEFAULT_CADENCE_SEC,
  peakQuery,
} from './cadence';
import { isNoiseKey, sortLabelKeys } from './keys';
import { buildMetrics, isCloudWatchName, labelStream } from './metrics';
import { Metadata, TagPair, TimeWindow } from './types';

export type { MetricMatch, TagMatch, TagPair, TimeWindow } from './types';
export { searchMetrics, searchTags } from './search';
export { isLowPriorityKey, isNoiseKey, sortLabelKeys } from './keys';
export { isCloudWatchName, labelStream } from './metrics';

const LIST_TTL_MS = 10 * 60_000;
const RESOLVE_TTL_MS = 5 * 60_000;
const CADENCE_TTL_MS = 10 * 60_000;
const VALUES_TTL_MS = 5 * 60_000;
const TAG_PAIRS_CONCURRENCY = 4;
const MAX_WINDOW_SEC = 24 * 3600;
const DEFAULT_WINDOW_SEC = 3600;
/** Label-value windows snap to 5 min, so a moving "now" keeps hitting the cache. */
const WINDOW_STEP_SEC = 300;
const SESSION_PREFIX = 'skippay-metricsexplorer:catalog:';
const DELTA = 'AGGREGATION_TEMPORALITY_DELTA';
const CUMULATIVE = 'AGGREGATION_TEMPORALITY_CUMULATIVE';

interface ResourceSource {
  getResource<T>(path: string, params?: Record<string, string | number>): Promise<T>;
}

interface PromResponse<T> {
  status: string;
  data: T;
  error?: string;
}

interface InstantVector {
  resultType: string;
  result: Array<{ value: [number, string] }>;
}

interface StoredCatalog {
  v: 1;
  t: number;
  names: string[];
  metadata: Metadata;
}

interface MetricIndex {
  metrics: MetricInfo[];
  byName: Map<string, MetricInfo>;
}

interface TagPairsJob {
  promise: Promise<TagPair[]>;
  pairs: TagPair[];
  done: boolean;
  listeners: Set<(pairs: TagPair[]) => void>;
}

export class Catalog {
  private source?: Promise<ResourceSource>;
  private list?: { promise: Promise<MetricIndex>; expires: number };
  private resolved = new TtlCache<Promise<ResolvedMetric>>(RESOLVE_TTL_MS);
  private cadences = new TtlCache<Promise<number>>(CADENCE_TTL_MS);
  private values = new TtlCache<Promise<string[]>>(VALUES_TTL_MS);
  private tagJobs = new TtlCache<TagPairsJob>(VALUES_TTL_MS);

  constructor(readonly datasourceUid: string) {}

  /** Logical metrics sorted by name; the same array while cached (10 min, also in sessionStorage). */
  async listMetrics(): Promise<MetricInfo[]> {
    return (await this.index()).metrics;
  }

  async getMetric(name: string): Promise<MetricInfo | undefined> {
    return (await this.index()).byName.get(name);
  }

  /** Label keys, temporality, export interval and the final kind of a metric; cached per metric for 5 min. */
  resolve(name: string, range: TimeWindow): Promise<ResolvedMetric> {
    return memo(this.resolved, name, async () => {
      const info = await this.getMetric(name);
      if (!info) {
        throw new Error(`Metric ${name} does not exist`);
      }
      const stream = labelStream(info);
      // The stream's schema: OpenObserve ignores matchers here, and a short window can hide a sparse stream.
      const keys = this.request<string[]>('api/v1/labels', { 'match[]': selector(stream, []) }).then((all) =>
        all.filter((key) => key !== '__name__').sort()
      );
      const temporalityOf = keys.then(async (labelKeys) => {
        const values = labelKeys.includes('aggregation_temporality')
          ? await this.fetchValues(stream, 'aggregation_temporality', [], range)
          : [];
        return { delta: values.includes(DELTA), cumulative: values.includes(CUMULATIVE) };
      });
      const cadence = this.cadence(info, range, temporalityOf);
      const [labelKeys, temporality] = await Promise.all([keys, temporalityOf]);
      return {
        ...info,
        kind: refineKind(info.kind, labelKeys, temporality),
        temporality,
        labelKeys,
        hasInstanceId: labelKeys.includes('instance_id'),
        nativeIntervalSec: await cadence,
      };
    });
  }

  /**
   * The export interval of a metric from its stream's sample counts at the end of the range; cached per metric for
   * 10 min, and a failed probe gives the default.
   */
  private cadence(
    info: MetricInfo,
    range: TimeWindow,
    temporality: Promise<ResolvedMetric['temporality']>
  ): Promise<number> {
    if (info.kind === 'cloudwatch' || isCloudWatchName(info.name)) {
      return Promise.resolve(CLOUDWATCH_CADENCE_SEC);
    }
    const stream = labelStream(info);
    const time = Math.floor((Number.isFinite(range.to) ? Math.min(range.to, Date.now()) : Date.now()) / 1000);
    const counts = async (query: string) => {
      const vector = await this.request<InstantVector>('api/v1/query', { query, time });
      return vector.result.map((sample) => Number(sample.value[1]));
    };
    return memo(this.cadences, info.name, async () => {
      const [short, long] = CADENCE_WINDOWS_SEC;
      const [samples, peaks] = await Promise.all([
        counts(cadenceQuery(stream, short)),
        counts(peakQuery(stream, short)),
      ]);
      const cadence = cadenceFromCounts(samples, short, peaks);
      if (cadence !== undefined) {
        return cadence;
      }
      // A sparse delta sum counts rare events rather than being slow, so it gets no longer probe.
      if ((await temporality).delta) {
        return DEFAULT_CADENCE_SEC;
      }
      return cadenceFromCounts(await counts(cadenceQuery(stream, long)), long) ?? DEFAULT_CADENCE_SEC;
    }).catch(() => DEFAULT_CADENCE_SEC);
  }

  /** Values of `key` in the window under the "from" filters (capped at 1000 by OpenObserve). */
  async labelValues(metric: ResolvedMetric, key: string, filters: TagFilter[], range: TimeWindow): Promise<string[]> {
    return this.fetchValues(labelStream(metric), key, filtersToMatchers(filters), range);
  }

  /**
   * `key:value` pairs of every non-noise key under the filters, four keys at a time. `onProgress` gets
   * the pairs found so far whenever a key's values arrive; concurrent identical calls share the work.
   */
  tagPairs(
    metric: ResolvedMetric,
    filters: TagFilter[],
    range: TimeWindow,
    onProgress?: (pairs: TagPair[]) => void
  ): Promise<TagPair[]> {
    const { start, end } = labelWindow(range);
    const cacheKey = JSON.stringify([metric.name, filters.map((f) => [f.key, f.op, f.values]), start, end]);
    let job = this.tagJobs.get(cacheKey);
    if (!job) {
      const created = this.startTagPairs(metric, filters, range);
      this.tagJobs.set(cacheKey, created);
      created.promise.catch(() => this.tagJobs.deleteIf(cacheKey, created));
      job = created;
    }
    if (onProgress) {
      if (job.pairs.length > 0) {
        onProgress(job.pairs);
      }
      if (!job.done) {
        job.listeners.add(onProgress);
      }
    }
    return job.promise;
  }

  private startTagPairs(metric: ResolvedMetric, filters: TagFilter[], range: TimeWindow): TagPairsJob {
    const keys = sortLabelKeys(metric.labelKeys.filter((key) => !isNoiseKey(key, metric.name)));
    const found = new Map<string, string[]>();
    const job: TagPairsJob = { promise: Promise.resolve([]), pairs: [], done: false, listeners: new Set() };
    const work = runPool(keys, TAG_PAIRS_CONCURRENCY, async (key) => {
      // A key's own chips are left out, so its suggestions still offer the alternatives.
      const values = await this.labelValues(
        metric,
        key,
        filters.filter((f) => f.key !== key),
        range
      );
      if (values.length > 0) {
        found.set(key, values);
        job.pairs = keys.flatMap((k) => (found.get(k) ?? []).map((value) => ({ key: k, value })));
        job.listeners.forEach((listener) => listener(job.pairs));
      }
    });
    job.promise = work
      .then(() => job.pairs)
      .finally(() => {
        job.done = true;
        job.listeners.clear();
      });
    return job;
  }

  private fetchValues(stream: string, key: string, matchers: string[], range: TimeWindow): Promise<string[]> {
    const { start, end } = labelWindow(range);
    const match = selector(stream, matchers);
    return memo(this.values, JSON.stringify([key, match, start, end]), () =>
      this.request<string[]>(`api/v1/label/${key}/values`, { 'match[]': match, start, end })
    );
  }

  private index(): Promise<MetricIndex> {
    const now = Date.now();
    if (this.list && this.list.expires > now) {
      return this.list.promise;
    }
    const stored = readSession(this.datasourceUid, now);
    const promise = stored ? Promise.resolve(toIndex(stored)) : this.fetchIndex();
    const entry = { promise, expires: (stored?.t ?? now) + LIST_TTL_MS };
    this.list = entry;
    promise.catch(() => {
      if (this.list === entry) {
        this.list = undefined;
      }
    });
    return promise;
  }

  private async fetchIndex(): Promise<MetricIndex> {
    const [names, metadata] = await Promise.all([
      this.request<string[]>('api/v1/label/__name__/values', {}),
      this.request<Metadata>('api/v1/metadata', {}),
    ]);
    writeSession(this.datasourceUid, { v: 1, t: Date.now(), names, metadata });
    return toIndex({ names, metadata });
  }

  private async request<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const source = await this.datasource();
    let body: PromResponse<T> | undefined;
    try {
      body = await source.getResource<PromResponse<T> | undefined>(path, params);
    } catch (e) {
      throw new Error(`Metric catalogue request ${path} failed: ${describeError(e)}`);
    }
    if (body?.status !== 'success') {
      throw new Error(`Metric catalogue request ${path} failed: ${body?.error ?? 'unexpected response'}`);
    }
    return body.data;
  }

  private datasource(): Promise<ResourceSource> {
    if (!this.source) {
      const source = this.loadSource();
      this.source = source;
      source.catch(() => {
        if (this.source === source) {
          this.source = undefined;
        }
      });
    }
    return this.source;
  }

  private async loadSource(): Promise<ResourceSource> {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the replacement exists only in @grafana/runtime/unstable
    const ds: unknown = await getDataSourceSrv().get({ uid: this.datasourceUid });
    if (typeof (ds as Partial<ResourceSource> | undefined)?.getResource !== 'function') {
      throw new Error(`Data source ${this.datasourceUid} does not serve resource calls`);
    }
    return ds as ResourceSource;
  }
}

const catalogs = new Map<string, Catalog>();

/** One catalogue per datasource, shared by every explorer on the page. */
export function getCatalog(datasourceUid: string): Catalog {
  let catalog = catalogs.get(datasourceUid);
  if (!catalog) {
    catalog = new Catalog(datasourceUid);
    catalogs.set(datasourceUid, catalog);
  }
  return catalog;
}

function selector(stream: string, matchers: string[]): string {
  return `{__name__="${stream}"${matchers.map((m) => `,${m}`).join('')}}`;
}

/** Window in seconds for label calls (OpenObserve answers 500 without one): ≤ 24 h, now-1h when empty. */
function labelWindow(range: TimeWindow): { start: number; end: number } {
  let from = range.from / 1000;
  let to = range.to / 1000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    to = Date.now() / 1000;
    from = to - DEFAULT_WINDOW_SEC;
  }
  const end = Math.ceil(to / WINDOW_STEP_SEC) * WINDOW_STEP_SEC;
  const start = Math.max(Math.floor(from / WINDOW_STEP_SEC) * WINDOW_STEP_SEC, end - MAX_WINDOW_SEC);
  return { start, end };
}

/** Counters follow their OTel temporality; one without the label was scraped, so it is cumulative. */
function refineKind(kind: MetricKind, labelKeys: string[], temporality: ResolvedMetric['temporality']): MetricKind {
  if (kind !== 'delta_counter' && kind !== 'cumulative_counter') {
    return kind;
  }
  if (temporality.delta) {
    return 'delta_counter';
  }
  if (temporality.cumulative) {
    return 'cumulative_counter';
  }
  return labelKeys.includes('aggregation_temporality') ? kind : 'cumulative_counter';
}

function toIndex({ names, metadata }: Pick<StoredCatalog, 'names' | 'metadata'>): MetricIndex {
  const metrics = buildMetrics(names, metadata);
  return { metrics, byName: new Map(metrics.map((metric) => [metric.name, metric])) };
}

function describeError(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  // Grafana's FetchError carries the HTTP status and the response body.
  const { status, data } = (e ?? {}) as { status?: number; data?: { error?: unknown; message?: unknown } | string };
  const detail =
    typeof data === 'string'
      ? data
      : typeof data?.error === 'string'
        ? data.error
        : typeof data?.message === 'string'
          ? data.message
          : '';
  return [status, detail].filter(Boolean).join(' ') || String(e);
}

function readSession(uid: string, now: number): StoredCatalog | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_PREFIX + uid) ?? 'null') as Partial<StoredCatalog> | null;
    if (
      stored?.v === 1 &&
      typeof stored.t === 'number' &&
      now - stored.t < LIST_TTL_MS &&
      Array.isArray(stored.names) &&
      typeof stored.metadata === 'object' &&
      stored.metadata !== null
    ) {
      return stored as StoredCatalog;
    }
  } catch {
    // Blocked storage or a damaged entry: fetch again.
  }
  return undefined;
}

function writeSession(uid: string, stored: StoredCatalog): void {
  try {
    sessionStorage.setItem(SESSION_PREFIX + uid, JSON.stringify(stored));
  } catch {
    // Full or blocked storage only costs a refetch on the next page load.
  }
}
