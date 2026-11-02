import { ExplorerState, FormulaQuery, FunctionCall, MetricKind, MetricQuery, SpaceAgg } from './types';

export const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** Queries are lettered a…z, so there can be at most 26 of them. */
export const MAX_QUERIES = LETTERS.length;
export const SPLIT_LIMITS = [6, 12, 24, 48];
export const TOPLIST_LIMITS = [10, 25, 50, 100];

/** Short random id for React keys; unique enough within one explorer state. */
export function newId(): string {
  return Math.random().toString(36).slice(2, 10).padEnd(8, '0');
}

/**
 * The letter after the highest one in use (a, c → d), so letters are never reused while rows exist; undefined
 * once `z` is taken.
 */
export function nextLetter(queries: Array<Pick<MetricQuery, 'letter'>>): string | undefined {
  const highest = Math.max(-1, ...queries.map((q) => LETTERS.indexOf(q.letter)));
  return LETTERS[highest + 1];
}

export function canAddQuery(state: ExplorerState): boolean {
  return nextLetter(state.queries) !== undefined;
}

export function newQuery(state: Pick<ExplorerState, 'queries'>): MetricQuery {
  const letter = nextLetter(state.queries);
  if (!letter) {
    throw new Error(`At most ${MAX_QUERIES} queries`);
  }
  return {
    kind: 'query',
    id: newId(),
    letter,
    hidden: false,
    metric: '',
    filters: [],
    spaceAgg: 'avg',
    groupBy: [],
    functions: [],
  };
}

export function newFormula(state: Pick<ExplorerState, 'formulas'>): FormulaQuery {
  const ids = new Set(state.formulas.map((f) => f.id));
  let id = newId();
  while (ids.has(id)) {
    id = newId();
  }
  return { kind: 'formula', id, expression: '', hidden: false };
}

export function defaultState(): ExplorerState {
  return {
    v: 1,
    viz: 'timeseries',
    queries: [newQuery({ queries: [] })],
    formulas: [],
    display: {
      display: 'lines',
      showLabels: true,
      lineStyle: 'solid',
      stroke: 'normal',
      palette: 'classic',
      orderBy: 'values',
      reverse: false,
    },
    split: { byQuery: false, key: null, limit: 24, order: 'top', sortBy: 'avg' },
    reducer: 'avg',
    toplistLimit: 10,
  };
}

const AGGREGATORS: Record<MetricKind, SpaceAgg[]> = {
  gauge: ['avg', 'max', 'min', 'sum'],
  delta_counter: ['sum', 'avg', 'max', 'min'],
  cumulative_counter: ['sum', 'avg', 'max', 'min'],
  distribution: ['avg', 'max', 'min', 'sum', 'count', 'p50', 'p75', 'p90', 'p95', 'p99'],
  cloudwatch: ['avg', 'max', 'min', 'sum', 'count'],
};

/** Space aggregators offered for a metric kind, in menu order. */
export function aggregatorsForKind(kind: MetricKind): SpaceAgg[] {
  return AGGREGATORS[kind];
}

export interface KindDefaults {
  spaceAgg: SpaceAgg;
  /** Counters are shown as counts per interval unless the query already says as_count or as_rate. */
  countModifier?: 'as_count';
}

export function defaultsForKind(kind: MetricKind): KindDefaults {
  return isCounter(kind) ? { spaceAgg: 'sum', countModifier: 'as_count' } : { spaceAgg: 'avg' };
}

/**
 * The query with a newly picked metric: the first pick applies the kind's default aggregator, a later
 * change keeps the aggregator while the new kind offers it; counters get as_count() unless a count
 * modifier is already there.
 */
export function withMetric(query: MetricQuery, metric: string, kind: MetricKind): MetricQuery {
  const defaults = defaultsForKind(kind);
  const keepAgg = query.metric !== '' && aggregatorsForKind(kind).includes(query.spaceAgg);
  const hasCountModifier = query.functions.some((f) => f.name === 'as_count' || f.name === 'as_rate');
  const functions: FunctionCall[] =
    defaults.countModifier && !hasCountModifier
      ? [...query.functions, { id: newId(), name: defaults.countModifier, args: [] }]
      : query.functions;
  return { ...query, metric, spaceAgg: keepAgg ? query.spaceAgg : defaults.spaceAgg, functions };
}

function isCounter(kind: MetricKind): boolean {
  return kind === 'delta_counter' || kind === 'cumulative_counter';
}
