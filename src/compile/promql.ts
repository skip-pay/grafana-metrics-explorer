import { MetricInfo, ResolvedMetric, SpaceAgg } from '../model/types';
import { operand } from './functions';
import { cadenceSec } from './step';

export const DELTA_MATCHER = 'aggregation_temporality="AGGREGATION_TEMPORALITY_DELTA"';
export const CUMULATIVE_MATCHER = 'aggregation_temporality="AGGREGATION_TEMPORALITY_CUMULATIVE"';

/** Labels that make every delta point its own series; collapsed before avg/min/max across groups unless grouped by. */
const POINT_IDENTITY = ['instance_id', 'start_time', 'exemplars', 'flag'];

export type RollupAgg = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'last';

export interface TemplateInput {
  name: string;
  info: MetricInfo | ResolvedMetric | undefined;
  /** Matchers of the user's filters, one list per OR branch. */
  branches: string[][];
  spaceAgg: SpaceAgg;
  groupBy: string[];
  countMode: 'as_count' | 'as_rate';
  /** Explicit `rollup(agg, …)`; each kind has its own default. */
  rollupAgg?: RollupAgg;
  offsetSec: number;
  stepSec: number;
  /** Evaluate every selector at the end of the range (`@ end()`) or at a unix time in seconds, for ranking groups. */
  at?: 'end' | number;
}

export type TemplateResult = { expr: string; warnings: string[] } | { skip: string };

export function isResolved(info: MetricInfo | ResolvedMetric | undefined): info is ResolvedMetric {
  return info !== undefined && 'labelKeys' in info;
}

/** Groups a capped query keeps. */
export const GROUP_LIMIT = 200;

/**
 * The query restricted to the `limit` groups ranked highest by `rankExpr`, the same template evaluated once over
 * the whole range (`at`). OpenObserve rejects `@` on a subquery, so the ranking cannot wrap `expr` itself.
 */
export function capGroups(expr: string, rankExpr: string, limit = GROUP_LIMIT): string {
  return `(${expr}) and topk(${limit}, ${rankExpr})`;
}

const QUANTILES: Partial<Record<SpaceAgg, string>> = { p50: '0.5', p75: '0.75', p90: '0.9', p95: '0.95', p99: '0.99' };

/** The PromQL of one query before post functions, per metric kind. */
export function buildTemplate(input: TemplateInput): TemplateResult {
  const kind = input.info?.kind ?? 'gauge';
  if (QUANTILES[input.spaceAgg] && kind !== 'distribution') {
    return { skip: `${input.spaceAgg} is only available for distribution metrics` };
  }
  switch (kind) {
    case 'gauge':
      return gauge(input);
    case 'delta_counter':
      return deltaCounter(input);
    case 'cumulative_counter':
      return cumulativeCounter(input);
    case 'distribution':
      return distribution(input);
    case 'cloudwatch':
      return cloudwatch(input);
  }
}

class Builder {
  readonly warnings: string[] = [];
  constructor(readonly input: TemplateInput) {}

  /** A range selector; the timeshift offset goes into every selector of the query. */
  sel(stream: string, extra: string[], windowSec: number, filter: string[]): string {
    const matchers = [...extra, ...filter];
    const braces = matchers.length > 0 ? `{${matchers.join(',')}}` : '';
    const offset = this.input.offsetSec !== 0 ? ` offset ${this.input.offsetSec}s` : '';
    const at = this.input.at === undefined ? '' : ` @ ${this.input.at === 'end' ? 'end()' : this.input.at}`;
    return `${stream}${braces}[${windowSec}s]${offset}${at}`;
  }

  /**
   * `fn` over a range selector of `stream`; with several filter branches, the union of one per branch. `or` keeps
   * a series selected by two branches once.
   */
  read(fn: string, stream: string, extra: string[] = [], windowSec = this.input.stepSec): string {
    return this.input.branches.map((filter) => `${fn}(${this.sel(stream, extra, windowSec, filter)})`).join(' or ');
  }

  agg(op: string, inner: string, extraKeys: string[] = []): string {
    const keys = [...extraKeys, ...this.input.groupBy];
    return keys.length > 0 ? `${op} by (${keys.join(', ')}) (${inner})` : `${op}(${inner})`;
  }

  stream(key: 'base' | 'bucket' | 'count' | 'sum'): string {
    return this.input.info?.streams[key] ?? (key === 'base' ? this.input.name : `${this.input.name}_${key}`);
  }

  /** Kinds where `rollup(agg)` cannot change the time aggregation; only its interval applies. */
  intervalOnlyRollup(kindLabel: string): void {
    const agg = this.input.rollupAgg;
    if (agg && agg !== 'avg' && agg !== 'sum') {
      this.warnings.push(`rollup(${agg}): only the interval applies to ${kindLabel}`);
    }
  }

  done(expr: string): TemplateResult {
    return { expr, warnings: this.warnings };
  }
}

function gauge(input: TemplateInput): TemplateResult {
  const b = new Builder(input);
  if (input.spaceAgg === 'count') {
    return b.done(b.agg('count', b.read('last_over_time', b.stream('base'))));
  }
  return b.done(b.agg(input.spaceAgg, b.read(`${input.rollupAgg ?? 'avg'}_over_time`, b.stream('base'))));
}

function deltaCounter(input: TemplateInput): TemplateResult {
  const b = new Builder(input);
  const { info } = input;
  const temporality = !isResolved(info) || info.temporality.delta ? [DELTA_MATCHER] : [];
  const inner = b.read(`${input.rollupAgg ?? 'sum'}_over_time`, b.stream('base'), temporality);
  const pointLabels = POINT_IDENTITY.filter((key) => !input.groupBy.includes(key));
  const expr =
    input.spaceAgg === 'sum'
      ? b.agg('sum', inner)
      : b.agg(input.spaceAgg, `sum without (${pointLabels.join(', ')}) (${inner})`);
  // A count of series is not a number of events, so the count modifiers do not scale it.
  return b.done(
    input.countMode === 'as_rate' && input.spaceAgg !== 'count' ? `${operand(expr)} / ${input.stepSec}` : expr
  );
}

/** Window for rate() on cumulative streams: the step, but at least four export intervals. */
function rateWindowSec(input: TemplateInput): number {
  return Math.max(input.stepSec, 4 * cadenceSec(input.info));
}

function cumulativeCounter(input: TemplateInput): TemplateResult {
  const b = new Builder(input);
  const { info } = input;
  b.intervalOnlyRollup('cumulative counters');
  const temporality = isResolved(info) && info.temporality.cumulative ? [CUMULATIVE_MATCHER] : [];
  const expr = b.agg(input.spaceAgg, b.read('rate', b.stream('base'), temporality, rateWindowSec(input)));
  return b.done(input.countMode === 'as_rate' || input.spaceAgg === 'count' ? expr : `${expr} * ${input.stepSec}`);
}

function distribution(input: TemplateInput): TemplateResult {
  const b = new Builder(input);
  const { info, spaceAgg, stepSec } = input;
  b.intervalOnlyRollup('distributions');
  // Like a counter, a histogram without the OTel label was scraped, so it is cumulative.
  const cumulative =
    isResolved(info) &&
    !info.temporality.delta &&
    (info.temporality.cumulative || !info.labelKeys.includes('aggregation_temporality'));
  const quantile = QUANTILES[spaceAgg];

  if (cumulative) {
    const temporality = info.temporality.cumulative ? [CUMULATIVE_MATCHER] : [];
    const rate = (stream: string) => b.read('rate', stream, temporality, rateWindowSec(input));
    if (quantile) {
      return b.done(`histogram_quantile(${quantile}, ${b.agg('sum', rate(b.stream('bucket')), ['le'])})`);
    }
    switch (spaceAgg) {
      case 'avg':
        return b.done(`${b.agg('sum', rate(b.stream('sum')))} / (${b.agg('sum', rate(b.stream('count')))} > 0)`);
      case 'count':
      case 'sum': {
        const expr = b.agg('sum', rate(b.stream(spaceAgg)));
        return b.done(input.countMode === 'as_rate' ? expr : `${expr} * ${stepSec}`);
      }
      default:
        return { skip: `${spaceAgg} is not available for cumulative histograms` };
    }
  }

  const temporality = !isResolved(info) || info.temporality.delta ? [DELTA_MATCHER] : [];
  const sum = (stream: string) => b.read('sum_over_time', stream, temporality);
  const bucketQuantile = (q: string) => `histogram_quantile(${q}, ${b.agg('sum', sum(b.stream('bucket')), ['le'])})`;
  if (quantile) {
    return b.done(bucketQuantile(quantile));
  }
  switch (spaceAgg) {
    case 'avg':
      return b.done(`${b.agg('sum', sum(b.stream('sum')))} / (${b.agg('sum', sum(b.stream('count')))} > 0)`);
    case 'count':
    case 'sum': {
      const expr = b.agg('sum', sum(b.stream(spaceAgg)));
      return b.done(input.countMode === 'as_rate' ? `${expr} / ${stepSec}` : expr);
    }
    case 'min': {
      const min = info?.streams.min;
      return min
        ? b.done(b.agg('min', b.read('min_over_time', min, temporality)))
        : { skip: 'min is not available: the histogram has no _min stream' };
    }
    case 'max': {
      const max = info?.streams.max;
      return b.done(max ? b.agg('max', b.read('max_over_time', max, temporality)) : bucketQuantile('1'));
    }
  }
  return { skip: `${spaceAgg} is not available for distributions` };
}

function cloudwatch(input: TemplateInput): TemplateResult {
  const b = new Builder(input);
  b.intervalOnlyRollup('CloudWatch metrics');
  const sum = b.read('sum_over_time', b.stream('sum'));
  const count = b.read('sum_over_time', b.stream('count'));
  switch (input.spaceAgg) {
    case 'avg':
      // The average of each source's own average, as CloudWatch shows it.
      return b.done(b.agg('avg', `${operand(sum)} / ${operand(count)}`));
    case 'max':
      return b.done(b.agg('max', b.read('max_over_time', b.stream('base'), ['quantile="1"'])));
    case 'min':
      return b.done(b.agg('min', b.read('min_over_time', b.stream('base'), ['quantile="0"'])));
    case 'sum':
      return b.done(b.agg('sum', sum));
    case 'count':
      return b.done(b.agg('sum', count));
  }
  return { skip: `${input.spaceAgg} is not available for CloudWatch metrics` };
}
