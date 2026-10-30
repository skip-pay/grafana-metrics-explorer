import { Series } from '../model/types';

/** Series of one row plus the group keys they are split by (in naming order). */
export interface SeriesSet {
  series: Series[];
  keys: string[];
  unit?: string;
}

export type Values = Array<number | null>;

/** Reducers used by top/bottom, ordering, split ranking and the toplist/table/stat builders. */
export type ReducerName = 'mean' | 'avg' | 'max' | 'min' | 'sum' | 'last' | 'l2norm' | 'area';

export function isValue(v: number | null | undefined): v is number {
  return v !== null && v !== undefined && Number.isFinite(v);
}

/** NaN, ±Inf and missing values become null. */
export function clean(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function withValues(s: Series, values: Values): Series {
  return { ...s, values };
}

export function mapPoints(series: Series[], fn: (v: number) => number | null): Series[] {
  return series.map((s) =>
    withValues(
      s,
      s.values.map((v) => (isValue(v) ? clean(fn(v)) : null))
    )
  );
}

/** Reduces the non-null values; null when there are none. `area` is Σ value × step seconds. */
export function reduceValues(values: Values, by: string, stepSec: number): number | null {
  let count = 0;
  let sum = 0;
  let squares = 0;
  let min = Infinity;
  let max = -Infinity;
  let last: number | null = null;
  for (const v of values) {
    if (!isValue(v)) {
      continue;
    }
    count++;
    sum += v;
    squares += v * v;
    min = Math.min(min, v);
    max = Math.max(max, v);
    last = v;
  }
  if (count === 0) {
    return null;
  }
  switch (by) {
    case 'sum':
      return sum;
    case 'min':
      return min;
    case 'max':
      return max;
    case 'last':
      return last;
    case 'l2norm':
      return Math.sqrt(squares);
    case 'area':
      return sum * stepSec;
    default:
      return sum / count;
  }
}

/** Mean of the non-null values, -Infinity when there are none (sorts last in descending order). */
export function meanOrLowest(values: Values): number {
  return reduceValues(values, 'mean', 1) ?? -Infinity;
}

/** Canonical identity of a label set over `keys`; an absent label differs from an explicit empty one. */
export function labelKey(labels: Record<string, string>, keys: string[]): string {
  return keys.map((k) => (k in labels ? `${k}=${JSON.stringify(labels[k])}` : `${k}!`)).join(',');
}

/** `v1, v2`: the values of `keys`; an absent label shows as `N/A`, an explicit empty one as `""`. */
export function tagValues(labels: Record<string, string>, keys: string[]): string {
  return keys.map((k) => tagValue(labels, k)).join(', ');
}

export function tagValue(labels: Record<string, string>, key: string): string {
  if (!(key in labels)) {
    return 'N/A';
  }
  return labels[key] === '' ? '""' : labels[key];
}

export function unionKeys(a: string[], b: string[]): string[] {
  return [...a, ...b.filter((k) => !a.includes(k))];
}

export function constantSeries(refLetter: string, times: number[], value: number | null): Series {
  return { refLetter, labels: {}, times, values: times.map(() => value), name: '' };
}
