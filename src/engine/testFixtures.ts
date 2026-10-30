import { DataFrame, dateTime, FieldType, LoadingState, PanelData, toDataFrame } from '@grafana/data';

import type { CompiledFormula, CompiledPlan, CompiledQuery } from '../compile';
import { defaultState } from '../model/defaults';
import { ExplorerState, MetricQuery, Series } from '../model/types';

// Test-only helpers; nothing in the bundle imports this file.

export const STEP = 60;
/** A minute boundary; ranges start 15 s after it like a real "now-10m". */
export const T0 = 1793352000000;
export const FROM = T0 + 15000;
export const TO = FROM + 10 * 60000;

/** Timestamps the datasource returns for FROM..TO at STEP: start and end aligned down to the step. */
export function promTimes(from = FROM, to = TO, step = STEP): number[] {
  const out: number[] = [];
  for (let t = Math.floor(from / (step * 1000)) * step * 1000; t <= to; t += step * 1000) {
    out.push(t);
  }
  return out;
}

/**
 * A range-query frame as the Prometheus datasource returns it: `Time` with the step as interval, `Value` with
 * the series labels; ungrouped results carry the expression as `displayNameFromDS`. Null points are left out,
 * as the datasource never returns them.
 */
export function promFrame(
  refId: string,
  labels: Record<string, string>,
  values: Array<number | null>,
  opts: { times?: number[]; expr?: string; step?: number } = {}
): DataFrame {
  const step = opts.step ?? STEP;
  const times = opts.times ?? promTimes(FROM, TO, step);
  const points = values.map((v, i) => [times[i], v] as const).filter(([, v]) => v !== null);
  const expr = opts.expr ?? 'sum(sum_over_time(m[60s]))';
  return toDataFrame({
    refId,
    meta: {
      type: 'timeseries-multi',
      typeVersion: [0, 1],
      custom: { resultType: 'matrix', calculatedMinStep: step * 1000 },
      executedQueryString: `Expr: ${expr}\nStep: ${step}s`,
    },
    fields: [
      { name: 'Time', type: FieldType.time, config: { interval: step * 1000 }, values: points.map(([t]) => t) },
      {
        name: 'Value',
        type: FieldType.number,
        labels,
        config: Object.keys(labels).length ? {} : { displayNameFromDS: expr },
        values: points.map(([, v]) => v),
      },
    ],
  });
}

/** The frame of a query that matched nothing. */
export function emptyFrame(refId: string): DataFrame {
  return toDataFrame({
    refId,
    meta: { custom: { calculatedMinStep: STEP * 1000 }, typeVersion: [0, 0] },
    fields: [],
  });
}

/**
 * Panel data for frames at `promTimes()`. Its range starts one step before FROM: the first bucket of a range
 * ends before the range starts and is dropped, so every point of those frames stays visible.
 */
export function panelData(series: DataFrame[], errors: PanelData['errors'] = []): PanelData {
  return {
    state: LoadingState.Done,
    series,
    errors,
    timeRange: { from: dateTime(FROM - STEP * 1000), to: dateTime(TO), raw: { from: 'now-11m', to: 'now' } },
  };
}

export function query(letter: string, overrides: Partial<MetricQuery> = {}): MetricQuery {
  return {
    kind: 'query',
    id: `id-${letter}`,
    letter,
    hidden: false,
    metric: 'm',
    filters: [],
    spaceAgg: 'avg',
    groupBy: [],
    functions: [],
    ...overrides,
  };
}

export function state(overrides: Partial<ExplorerState> = {}): ExplorerState {
  return { ...defaultState(), queries: [query('a')], ...overrides };
}

export function compiled(letter: string, overrides: Partial<CompiledQuery> = {}): CompiledQuery {
  return {
    letter,
    refId: letter,
    expr: 'avg(avg_over_time(m[60s]))',
    stepSec: STEP,
    windowSec: STEP,
    clientChain: [],
    textForm: `avg:m{*}`,
    warnings: [],
    groupBy: [],
    ...overrides,
  };
}

export function formula(n: number, expression: string, overrides: Partial<CompiledFormula> = {}): CompiledFormula {
  return { id: `f-${n}`, refLetter: `f${n}`, expression, hidden: false, ...overrides };
}

export function plan(queries: CompiledQuery[], formulas: CompiledFormula[] = []): CompiledPlan {
  return { stepSec: STEP, queries, formulas, title: 'avg:m{*}', errors: [] };
}

/** A series on a grid of `values.length` minute points. */
export function series(
  values: Array<number | null>,
  labels: Record<string, string> = {},
  overrides: Partial<Series> = {}
): Series {
  return {
    refLetter: 'a',
    labels,
    times: values.map((_, i) => T0 + i * STEP * 1000),
    values,
    name: '',
    ...overrides,
  };
}
