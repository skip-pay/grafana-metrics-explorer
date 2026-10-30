import { Series } from '../model/types';
import { constantSeries, isValue, mapPoints, reduceValues, Values, withValues } from './series';

export interface ClientContext {
  stepSec: number;
  /** The shared grid, ms epoch. */
  times: number[];
  /** Group keys of the input series. */
  keys: string[];
  refLetter: string;
}

export type ClientFunction = (series: Series[], args: Array<number | string>, ctx: ClientContext) => Series[];

export const TOP_REDUCERS = ['mean', 'max', 'min', 'sum', 'last', 'l2norm', 'area'];
export const ROLLUP_AGGS = ['avg', 'sum', 'min', 'max', 'count', 'last', 'median'];

/** Functions whose result is one ungrouped series. */
const COLLAPSING_FUNCTIONS = new Set(['count_nonzero', 'count_not_null']);

function numArg(args: Array<number | string>, i: number, fallback: number): number {
  const v = args[i];
  const n = typeof v === 'number' ? v : v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function strArg(args: Array<number | string>, i: number, fallback: string): string {
  const v = args[i];
  return v === undefined || v === '' ? fallback : String(v);
}

/** Calls `fn(i, prev)` for each non-null point after the first, with the index of the previous non-null point. */
function pairwise(values: Values, fn: (i: number, prev: number) => number | null): Values {
  const out: Values = values.map(() => null);
  let prev = -1;
  values.forEach((v, i) => {
    if (!isValue(v)) {
      return;
    }
    if (prev >= 0) {
      out[i] = fn(i, prev);
    }
    prev = i;
  });
  return out;
}

/** Δvalue/Δt between non-null points; `monotonic` counts a drop as 0, as a counter reset. */
function rate(multiplier: number, monotonic: boolean): ClientFunction {
  return (series) =>
    series.map((s) =>
      withValues(
        s,
        pairwise(s.values, (i, prev) => {
          const dt = (s.times[i] - s.times[prev]) / 1000;
          const delta = s.values[i]! - s.values[prev]!;
          return ((monotonic ? Math.max(0, delta) : delta) / dt) * multiplier;
        })
      )
    );
}

/** Applies `fn` to the window of non-null values ending at each non-null point. */
function rollingByPoints(n: number, fn: (window: number[]) => number): ClientFunction {
  return (series) =>
    series.map((s) => {
      const window: number[] = [];
      return withValues(
        s,
        s.values.map((v) => {
          if (!isValue(v)) {
            return null;
          }
          window.push(v);
          if (window.length > n) {
            window.shift();
          }
          return fn(window);
        })
      );
    });
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function ewma(span: number): ClientFunction {
  const alpha = 2 / (span + 1);
  return (series) =>
    series.map((s) => {
      let acc: number | null = null;
      return withValues(
        s,
        s.values.map((v) => {
          if (!isValue(v)) {
            return null;
          }
          acc = acc === null ? v : alpha * v + (1 - alpha) * acc;
          return acc;
        })
      );
    });
}

/** Keeps the `n` series ranked first by `by`; series without data rank last. */
function rank(series: Series[], args: Array<number | string>, ctx: ClientContext, invert: boolean): Series[] {
  const n = Math.max(0, Math.floor(numArg(args, 0, 5)));
  const by = strArg(args, 1, 'mean');
  const asc = (strArg(args, 2, 'desc') === 'asc') !== invert;
  const scored = series.map((s) => ({ s, score: reduceValues(s.values, by, ctx.stepSec) }));
  scored.sort((a, b) => {
    if (a.score === null || b.score === null) {
      return a.score === null ? (b.score === null ? 0 : 1) : -1;
    }
    return asc ? a.score - b.score : b.score - a.score;
  });
  return scored.slice(0, n).map((x) => x.s);
}

/** Fills runs of nulls no longer than `limitSec` (never less than one step). */
const fill: ClientFunction = (series, args, ctx) => {
  const method = strArg(args, 0, 'null');
  if (method === 'null') {
    return series;
  }
  const maxRun = Math.max(1, Math.floor(numArg(args, 1, 300) / ctx.stepSec));
  return series.map((s) => {
    const out = [...s.values];
    let i = 0;
    while (i < out.length) {
      if (isValue(out[i])) {
        i++;
        continue;
      }
      let end = i;
      while (end < out.length && !isValue(out[end])) {
        end++;
      }
      const before = i > 0 ? (out[i - 1] as number) : null;
      const after = end < out.length ? (out[end] as number) : null;
      if (end - i <= maxRun) {
        for (let k = i; k < end; k++) {
          if (method === 'zero') {
            out[k] = 0;
          } else if (method === 'last' && before !== null) {
            out[k] = before;
          } else if (method === 'linear' && before !== null && after !== null) {
            out[k] = before + ((after - before) * (k - i + 1)) / (end - i + 1);
          }
        }
      }
      i = end;
    }
    return withValues(s, out);
  });
};

const defaultZero: ClientFunction = (series, _args, ctx) => {
  if (series.length === 0 && ctx.keys.length === 0) {
    return [constantSeries(ctx.refLetter, ctx.times, 0)];
  }
  return series.map((s) =>
    withValues(
      s,
      s.values.map((v) => (isValue(v) ? v : 0))
    )
  );
};

function countAcross(keep: (v: number) => boolean): ClientFunction {
  return (series, _args, ctx) => {
    if (series.length === 0) {
      return [];
    }
    const values = ctx.times.map((_, i) => series.filter((s) => isValue(s.values[i]) && keep(s.values[i]!)).length);
    return [{ ...constantSeries(ctx.refLetter, ctx.times, null), values }];
  };
}

/** Running total; nulls count as 0 once the series has started. */
function running(weight: (s: Series, i: number, ctx: ClientContext) => number): ClientFunction {
  return (series, _args, ctx) =>
    series.map((s) => {
      let acc: number | null = null;
      return withValues(
        s,
        s.values.map((v, i) => {
          if (isValue(v)) {
            acc = (acc ?? 0) + v * weight(s, i, ctx);
          }
          return acc;
        })
      );
    });
}

/** Ordinary least squares over the non-null points, drawn across the whole grid. */
const trendLine: ClientFunction = (series) =>
  series.map((s) => {
    // Seconds from the first grid point keep the sums small enough to stay exact.
    const x = (t: number) => (t - s.times[0]) / 1000;
    const xs: number[] = [];
    const ys: number[] = [];
    s.values.forEach((v, i) => {
      if (isValue(v)) {
        xs.push(x(s.times[i]));
        ys.push(v);
      }
    });
    if (xs.length === 0) {
      return withValues(
        s,
        s.values.map(() => null)
      );
    }
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let den = 0;
    xs.forEach((x, i) => {
      num += (x - mx) * (ys[i] - my);
      den += (x - mx) * (x - mx);
    });
    const slope = den === 0 ? 0 : num / den;
    return withValues(
      s,
      s.times.map((t) => my + slope * (x(t) - mx))
    );
  });

/** Aggregates the non-null values of the trailing `seconds` window at every non-null point. */
const movingRollup: ClientFunction = (series, args, ctx) => {
  const width = Math.max(1, Math.round(numArg(args, 0, 300) / ctx.stepSec));
  const agg = strArg(args, 1, 'avg');
  return series.map((s) =>
    withValues(
      s,
      s.values.map((v, i) => {
        if (!isValue(v)) {
          return null;
        }
        const window = s.values.slice(Math.max(0, i - width + 1), i + 1).filter(isValue);
        switch (agg) {
          case 'sum':
            return window.reduce((a, b) => a + b, 0);
          case 'min':
            return Math.min(...window);
          case 'max':
            return Math.max(...window);
          case 'count':
            return window.length;
          case 'last':
            return v;
          case 'median':
            return median(window);
          default:
            return mean(window);
        }
      })
    )
  );
};

const excludeNull: ClientFunction = (series, _args, ctx) => series.filter((s) => ctx.keys.every((k) => k in s.labels));

function pointwise(fn: (v: number, args: Array<number | string>) => number | null): ClientFunction {
  return (series, args) => mapPoints(series, (v) => fn(v, args));
}

function log(fn: (v: number) => number): ClientFunction {
  return pointwise((v) => (v > 0 ? fn(v) : null));
}

/** PromQL `round(x, 10^-d)`: nearest multiple, ties rounded up. */
function round(v: number, decimals: number): number {
  const inverse = Math.pow(10, decimals);
  return Math.floor(v * inverse + 0.5) / inverse;
}

/** Client implementations keyed by function name. */
export const CLIENT_FUNCTIONS: Record<string, ClientFunction> = {
  abs: pointwise(Math.abs),
  ceil: pointwise(Math.ceil),
  floor: pointwise(Math.floor),
  round: pointwise((v, args) => round(v, Math.trunc(numArg(args, 0, 0)))),
  log2: log(Math.log2),
  log10: log(Math.log10),
  cumsum: running(() => 1),
  integral: running((_s, _i, ctx) => ctx.stepSec),
  clamp_min: pointwise((v, args) => Math.max(v, numArg(args, 0, 0))),
  clamp_max: pointwise((v, args) => Math.min(v, numArg(args, 0, 0))),
  cutoff_min: pointwise((v, args) => (v >= numArg(args, 0, 0) ? v : null)),
  cutoff_max: pointwise((v, args) => (v <= numArg(args, 0, 0) ? v : null)),
  is_greater: pointwise((v, args) => (v > numArg(args, 0, 0) ? 1 : 0)),
  is_less: pointwise((v, args) => (v < numArg(args, 0, 0) ? 1 : 0)),
  is_between: pointwise((v, args) => (v >= numArg(args, 0, 0) && v <= numArg(args, 1, 1) ? 1 : 0)),
  exclude_null: excludeNull,
  count_nonzero: countAcross((v) => v !== 0),
  count_not_null: countAcross(() => true),
  fill,
  default_zero: defaultZero,
  top: (series, args, ctx) => rank(series, args, ctx, false),
  bottom: (series, args, ctx) => rank(series, args, ctx, true),
  per_second: rate(1, true),
  per_minute: rate(60, true),
  per_hour: rate(3600, true),
  derivative: rate(1, false),
  diff: (series) =>
    series.map((s) =>
      withValues(
        s,
        pairwise(s.values, (i, prev) => s.values[i]! - s.values[prev]!)
      )
    ),
  monotonic_diff: (series) =>
    series.map((s) =>
      withValues(
        s,
        pairwise(s.values, (i, prev) => Math.max(0, s.values[i]! - s.values[prev]!))
      )
    ),
  throughput: (series, _args, ctx) => mapPoints(series, (v) => v / ctx.stepSec),
  moving_rollup: movingRollup,
  trend_line: trendLine,
  ...Object.fromEntries([3, 5, 10, 20].map((n) => [`ewma_${n}`, ewma(n)])),
  ...Object.fromEntries([3, 5, 7, 9].map((n) => [`median_${n}`, rollingByPoints(n, median)])),
  ...Object.fromEntries([5, 13, 21, 29].map((n) => [`rollingavg_${n}`, rollingByPoints(n, mean)])),
};

/** Group keys of the result of `name` applied to series grouped by `keys`. */
export function keysAfter(name: string, keys: string[]): string[] {
  return COLLAPSING_FUNCTIONS.has(name) ? [] : keys;
}
