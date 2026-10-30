import { PanelData, TimeRange } from '@grafana/data';

import type { CompiledPlan, CompiledQuery } from '../compile';
import { ExplorerState, MetricInfo, MetricQuery, Series } from '../model/types';
import { ClientContext, CLIENT_FUNCTIONS, keysAfter } from './clientFunctions';
import { evaluateFormula, expandLetters, FormulaError } from './formula';
import { buildGrid, framesToSeries } from './frames';
import { RowNaming, seriesName } from './names';
import { SeriesSet, unionKeys } from './series';

/** More series than this in one row are refused instead of drawn. */
export const MAX_SERIES = 1000;

/** A query or formula row after evaluation. */
export interface RowResult extends RowNaming {
  /** Query letter, or `f1`, `f2`… for formulas. */
  ref: string;
  kind: 'query' | 'formula';
  hidden: boolean;
  unit?: string;
  unitLabel?: string;
  /** The query's colour override (a hex colour or a palette id). */
  color?: string;
}

export interface EvaluateResult {
  /** Keyed by query letter or formula ref (`f1`, `f2`…). */
  seriesByRow: Record<string, Series[]>;
  rowErrors: Record<string, string>;
  warnings: string[];
  /** Plan order: queries, then formulas. */
  rows: RowResult[];
  /** The shared grid (bucket starts, ms epoch). */
  times: number[];
  timeRange: TimeRange;
  stepSec: number;
}

/** Group keys a query's series carry: its group-by plus the split key of a split timeseries. */
function groupKeys(query: MetricQuery | undefined, state: ExplorerState): string[] {
  if (!query || state.viz === 'queryvalue') {
    return [];
  }
  const split = state.viz === 'timeseries' ? state.split.key : null;
  return split ? unionKeys(query.groupBy, [split]) : [...query.groupBy];
}

/** Values at `t` cover the window before `t`; buckets are labelled by their start one step earlier. */
function shiftSec(cq: CompiledQuery, stepSec: number): number {
  return cq.windowSec > 0 ? Math.min(cq.windowSec, stepSec) : stepSec;
}

function tooMany(count: number): string {
  return `Too many series (${count}). Add a filter or group by fewer tags.`;
}

/**
 * Frames → Series on the shared grid → each query's client chain → fill; then the formulas in order (they
 * may use any query letter, hidden or not). Series are named for a chart showing their row alone.
 */
export function evaluate(
  plan: CompiledPlan,
  data: PanelData,
  state: ExplorerState,
  metrics: Record<string, MetricInfo | undefined>
): EvaluateResult {
  const stepSec = plan.stepSec;
  const frames = data.series ?? [];
  const times = buildGrid(data.timeRange.from.valueOf(), data.timeRange.to.valueOf(), stepSec, frames);
  const result: EvaluateResult = {
    seriesByRow: {},
    rowErrors: {},
    warnings: [],
    rows: [],
    times,
    timeRange: data.timeRange,
    stepSec,
  };
  const queries = new Map(state.queries.map((q) => [q.letter, q]));
  const sets: Record<string, SeriesSet> = {};
  for (const q of state.queries) {
    sets[q.letter] = { series: [], keys: groupKeys(q, state) };
  }

  const letterOf = new Map(plan.queries.map((cq) => [cq.refId, cq.letter]));
  for (const error of data.errors ?? []) {
    const letter = error.refId ? letterOf.get(error.refId) : undefined;
    const message = error.message ?? 'Query failed';
    if (letter) {
      result.rowErrors[letter] = message;
    } else {
      result.warnings.push(message);
    }
  }

  const addRow = (row: RowResult, set: SeriesSet) => {
    const series = set.series.map((s) => ({
      ...s,
      refLetter: row.ref,
      name: seriesName(row, s.labels),
      unit: row.unit,
    }));
    sets[row.ref] = { ...set, series };
    result.seriesByRow[row.ref] = series;
    result.rows.push(row);
  };

  for (const cq of plan.queries) {
    const query = queries.get(cq.letter);
    const metric = query?.metric ? metrics[query.metric] : undefined;
    const queryFrames = cq.skip ? [] : frames.filter((f) => f.refId === cq.refId);
    let series = framesToSeries(queryFrames, cq.letter, times, shiftSec(cq, stepSec));
    const seen = [...new Set(series.flatMap((s) => Object.keys(s.labels)))].sort();
    let keys = unionKeys(groupKeys(query, state), seen);
    const calls = [
      ...cq.clientChain,
      ...(cq.fill ? [{ id: 'fill', name: 'fill', args: [cq.fill.method, cq.fill.limitSec] }] : []),
    ];
    for (const call of calls) {
      const fn = CLIENT_FUNCTIONS[call.name];
      if (!fn) {
        result.warnings.push(`Function \`${call.name}\` is not supported and was skipped`);
        continue;
      }
      const ctx: ClientContext = { stepSec, times, keys, refLetter: cq.letter };
      series = fn(series, call.args, ctx);
      keys = keysAfter(call.name, keys);
    }
    if (series.length > MAX_SERIES) {
      result.rowErrors[cq.letter] = tooMany(series.length);
      series = [];
    }
    addRow(
      {
        ref: cq.letter,
        kind: 'query',
        hidden: query?.hidden ?? false,
        keys,
        aliased: Boolean(query?.alias),
        label: query?.alias || cq.letter,
        ungroupedName: query?.alias || cq.textForm,
        unit: metric?.unit,
        unitLabel: metric?.unitLabel,
        ...(query?.color ? { color: query.color } : {}),
      },
      { series, keys, unit: metric?.unit }
    );
  }

  const texts = new Map(plan.queries.map((cq) => [cq.letter, cq.textForm]));
  for (const formula of plan.formulas) {
    let set: SeriesSet = { series: [], keys: [] };
    try {
      set = evaluateFormula(formula.expression, {
        refLetter: formula.refLetter,
        stepSec,
        times,
        rows: sets,
        maxSeries: MAX_SERIES,
      });
    } catch (e) {
      if (!(e instanceof FormulaError)) {
        throw e;
      }
      result.rowErrors[formula.refLetter] = e.message;
    }
    if (set.series.length > MAX_SERIES) {
      result.rowErrors[formula.refLetter] = tooMany(set.series.length);
      set = { ...set, series: [] };
    }
    addRow(
      {
        ref: formula.refLetter,
        kind: 'formula',
        hidden: formula.hidden,
        keys: set.keys,
        aliased: Boolean(formula.alias),
        label: formula.alias || formula.expression,
        // The legend spells out the queries a formula uses.
        ungroupedName: formula.alias || expandLetters(formula.expression, texts),
        unit: set.unit,
        unitLabel: set.unit ? result.rows.find((r) => r.unit === set.unit)?.unitLabel : undefined,
      },
      set
    );
  }
  return visibleOnly(result, data.timeRange.from.valueOf());
}

/**
 * Drops the leading buckets that end before the range starts. They come with the query and warm up rates and
 * smoothing, but the chart never shows them, so reducers (table, top list, query value) must not count them.
 */
function visibleOnly(result: EvaluateResult, fromMs: number): EvaluateResult {
  const step = result.stepSec * 1000;
  const index = result.times.findIndex((t) => t + step > fromMs);
  // Without a bucket that ends inside the range, nothing is visible.
  const first = index === -1 ? result.times.length : index;
  if (first === 0) {
    return result;
  }
  const times = result.times.slice(first);
  const seriesByRow: Record<string, Series[]> = {};
  for (const [ref, list] of Object.entries(result.seriesByRow)) {
    seriesByRow[ref] = list.map((s) => ({ ...s, times, values: s.values.slice(first) }));
  }
  return { ...result, times, seriesByRow };
}
