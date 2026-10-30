import {
  aggregatorsForKind,
  canAddQuery,
  defaultState,
  defaultsForKind,
  MAX_QUERIES,
  newFormula,
  newQuery,
  nextLetter,
  withMetric,
} from './defaults';
import { MetricQuery } from './types';

const query = (patch: Partial<MetricQuery> = {}): MetricQuery => ({ ...newQuery({ queries: [] }), ...patch });

describe('defaultState', () => {
  it('starts with one empty query a and the default display', () => {
    const state = defaultState();
    expect(state.v).toBe(1);
    expect(state.viz).toBe('timeseries');
    expect(state.queries).toHaveLength(1);
    expect(state.queries[0]).toMatchObject({
      kind: 'query',
      letter: 'a',
      hidden: false,
      metric: '',
      filters: [],
      spaceAgg: 'avg',
      groupBy: [],
      functions: [],
    });
    expect(state.formulas).toEqual([]);
    expect(state.display).toEqual({
      display: 'lines',
      showLabels: true,
      lineStyle: 'solid',
      stroke: 'normal',
      palette: 'classic',
      orderBy: 'values',
      reverse: false,
    });
    expect(state.split).toEqual({ key: null, limit: 24, order: 'top', sortBy: 'avg' });
    expect(state.reducer).toBe('avg');
    expect(state.toplistLimit).toBe(10);
  });

  it('returns a fresh object every time', () => {
    const a = defaultState();
    const b = defaultState();
    expect(a).not.toBe(b);
    expect(a.queries[0].id).not.toBe(b.queries[0].id);
  });
});

describe('letters', () => {
  it('takes the letter after the highest one, never a freed one', () => {
    expect(nextLetter([])).toBe('a');
    expect(nextLetter([{ letter: 'a' }, { letter: 'c' }])).toBe('d');
    expect(nextLetter([{ letter: 'c' }, { letter: 'a' }])).toBe('d');
    expect(nextLetter([{ letter: 'b' }])).toBe('c');
  });

  it('runs out after z', () => {
    expect(nextLetter([{ letter: 'a' }, { letter: 'z' }])).toBeUndefined();
    const queries = [...'abcdefghijklmnopqrstuvwxyz'].map((letter) => query({ letter }));
    expect(nextLetter(queries)).toBeUndefined();
    expect(canAddQuery({ ...defaultState(), queries })).toBe(false);
    expect(() => newQuery({ queries })).toThrow(`At most ${MAX_QUERIES} queries`);
  });

  it('gives a new query the next letter and a unique id', () => {
    const state = defaultState();
    const b = newQuery(state);
    expect(b.letter).toBe('b');
    expect(b.id).not.toBe(state.queries[0].id);
    expect(canAddQuery(state)).toBe(true);
  });
});

describe('newFormula', () => {
  it('creates an empty visible formula with an id not used by other formulas', () => {
    const state = defaultState();
    const f1 = newFormula(state);
    const f2 = newFormula({ formulas: [f1] });
    expect(f1).toMatchObject({ kind: 'formula', expression: '', hidden: false });
    expect(f2.id).not.toBe(f1.id);
  });
});

describe('aggregators and kind defaults', () => {
  it('offers aggregators per kind', () => {
    expect(aggregatorsForKind('gauge')).toEqual(['avg', 'max', 'min', 'sum']);
    expect(aggregatorsForKind('delta_counter')).toEqual(['sum', 'avg', 'max', 'min']);
    expect(aggregatorsForKind('cumulative_counter')).toEqual(['sum', 'avg', 'max', 'min']);
    expect(aggregatorsForKind('distribution')).toEqual([
      'avg',
      'max',
      'min',
      'sum',
      'count',
      'p50',
      'p75',
      'p90',
      'p95',
      'p99',
    ]);
    expect(aggregatorsForKind('cloudwatch')).toEqual(['avg', 'max', 'min', 'sum', 'count']);
  });

  it('defaults counters to sum with as_count and the rest to avg', () => {
    expect(defaultsForKind('gauge')).toEqual({ spaceAgg: 'avg' });
    expect(defaultsForKind('distribution')).toEqual({ spaceAgg: 'avg' });
    expect(defaultsForKind('cloudwatch')).toEqual({ spaceAgg: 'avg' });
    expect(defaultsForKind('delta_counter')).toEqual({ spaceAgg: 'sum', countModifier: 'as_count' });
    expect(defaultsForKind('cumulative_counter')).toEqual({ spaceAgg: 'sum', countModifier: 'as_count' });
  });
});

describe('withMetric', () => {
  it('applies the kind defaults on the first pick', () => {
    const q = withMetric(query(), 'http_requests_total', 'delta_counter');
    expect(q.metric).toBe('http_requests_total');
    expect(q.spaceAgg).toBe('sum');
    expect(q.functions.map((f) => f.name)).toEqual(['as_count']);
  });

  it('does not add as_count next to an existing count modifier', () => {
    const q = withMetric(query({ functions: [{ id: 'x', name: 'as_rate', args: [] }] }), 'm', 'cumulative_counter');
    expect(q.functions.map((f) => f.name)).toEqual(['as_rate']);
  });

  it('keeps the aggregator on a change while the new kind offers it', () => {
    const q = withMetric(query({ metric: 'old', spaceAgg: 'max' }), 'new', 'delta_counter');
    expect(q.spaceAgg).toBe('max');
  });

  it('resets the aggregator when the new kind does not offer it', () => {
    const q = withMetric(query({ metric: 'old', spaceAgg: 'p95' }), 'cpu', 'gauge');
    expect(q.spaceAgg).toBe('avg');
    expect(q.functions).toEqual([]);
  });
});
