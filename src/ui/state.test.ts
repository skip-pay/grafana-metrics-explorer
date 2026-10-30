import { act, renderHook } from '@testing-library/react';
import { Subject } from 'rxjs';
import { UrlQueryMap } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import { defaultState } from '../model/defaults';
import { ExplorerState, MetricInfo, MetricKind, MetricQuery } from '../model/types';
import { encodeState, STORAGE_KEY, URL_PARAM } from '../model/url';
import {
  addFormula,
  addQuery,
  formulaLetters,
  removeFormula,
  removeQuery,
  setDisplay,
  setSplit,
  setViz,
  updateFormula,
  updateQuery,
  useExplorerState,
} from './state';

const mockLocation = { search: {} as UrlQueryMap, changes: new Subject<void>() };

jest.mock('@grafana/runtime', () => ({
  locationService: {
    getSearchObject: jest.fn(() => mockLocation.search),
    partial: jest.fn((query: UrlQueryMap) => {
      const search = { ...mockLocation.search, ...query };
      mockLocation.search = Object.fromEntries(Object.entries(search).filter(([, v]) => v !== null));
      mockLocation.changes.next();
    }),
    getLocationObservable: jest.fn(() => mockLocation.changes.asObservable()),
  },
}));

const partial = locationService.partial as jest.Mock;

const query = (letter: string, patch: Partial<MetricQuery> = {}): MetricQuery => ({
  kind: 'query',
  id: `id-${letter}`,
  letter,
  hidden: false,
  metric: '',
  filters: [],
  spaceAgg: 'avg',
  groupBy: [],
  functions: [],
  ...patch,
});

const withQueries = (...queries: MetricQuery[]): ExplorerState => ({ ...defaultState(), queries });

const kinds: Record<string, MetricKind> = {
  requests_total: 'delta_counter',
  cpu: 'gauge',
  latency: 'distribution',
};
const kindOf = (metric: string) => kinds[metric];

describe('state transitions', () => {
  it('adds queries under the letter after the highest one', () => {
    const state = addQuery(withQueries(query('a'), query('c')));
    expect(state.queries.map((q) => q.letter)).toEqual(['a', 'c', 'd']);
  });

  it('a new query copies the last one, visible and with new ids', () => {
    const last = query('a', {
      metric: 'cpu',
      hidden: true,
      groupBy: ['host'],
      alias: 'load',
      functions: [{ id: 'f1', name: 'abs', args: [] }],
    });
    const added = addQuery(withQueries(last)).queries[1];
    expect(added).toMatchObject({ letter: 'b', hidden: false, metric: 'cpu', groupBy: ['host'], alias: 'load' });
    expect(added.id).not.toBe(last.id);
    expect(added.functions).toEqual([{ id: expect.any(String), name: 'abs', args: [] }]);
    expect(added.functions[0].id).not.toBe('f1');
  });

  it('does not add a 27th query', () => {
    const state = withQueries(...[...'abcdefghijklmnopqrstuvwxyz'].map((l) => query(l)));
    expect(addQuery(state)).toBe(state);
  });

  it('finds the query letters a formula references', () => {
    expect(formulaLetters('a / b * 100')).toEqual(['a', 'b']);
    expect(formulaLetters('top(a, 10, \'mean\', "desc") + c')).toEqual(['a', 'c']);
    expect(formulaLetters('abs(a) + time()')).toEqual(['a']);
    // Half-typed expressions still count.
    expect(formulaLetters('a * (b')).toEqual(['a', 'b']);
    expect(formulaLetters('2*x1 + log2(3)')).toEqual([]);
  });

  it('never removes the last query', () => {
    const one = withQueries(query('a'));
    expect(removeQuery(one, 'id-a')).toBe(one);
    expect(removeQuery(withQueries(query('a'), query('b')), 'id-a').queries.map((q) => q.letter)).toEqual(['b']);
  });

  it('patches a query but never its id, letter or kind', () => {
    const state = updateQuery(withQueries(query('a')), 'id-a', {
      hidden: true,
      ...({ id: 'x', letter: 'z', kind: 'formula' } as object),
    });
    expect(state.queries[0]).toMatchObject({ id: 'id-a', letter: 'a', kind: 'query', hidden: true });
  });

  it('applies the defaults of the new metric kind', () => {
    const state = updateQuery(withQueries(query('a')), 'id-a', { metric: 'requests_total' }, kindOf);
    expect(state.queries[0].spaceAgg).toBe('sum');
    expect(state.queries[0].functions.map((f) => f.name)).toEqual(['as_count']);
  });

  it('keeps an aggregator the new kind offers and resets one it does not', () => {
    const p95 = updateQuery(
      withQueries(query('a', { metric: 'latency', spaceAgg: 'p95' })),
      'id-a',
      { metric: 'cpu' },
      kindOf
    );
    expect(p95.queries[0].spaceAgg).toBe('avg');
    const max = updateQuery(
      withQueries(query('a', { metric: 'latency', spaceAgg: 'max' })),
      'id-a',
      { metric: 'cpu' },
      kindOf
    );
    expect(max.queries[0].spaceAgg).toBe('max');
  });

  it('sets a metric of unknown kind as is', () => {
    const state = updateQuery(withQueries(query('a')), 'id-a', { metric: 'unknown_metric', spaceAgg: 'max' }, kindOf);
    expect(state.queries[0]).toMatchObject({ metric: 'unknown_metric', spaceAgg: 'max', functions: [] });
  });

  it('does not re-apply defaults when the metric stays the same', () => {
    const start = query('a', { metric: 'requests_total', spaceAgg: 'max' });
    const state = updateQuery(withQueries(start), 'id-a', { metric: 'requests_total', groupBy: ['path'] }, kindOf);
    expect(state.queries[0]).toMatchObject({ spaceAgg: 'max', functions: [], groupBy: ['path'] });
  });

  it('adds, patches and removes formulas', () => {
    let state = addFormula(addFormula(withQueries(query('a'))));
    expect(state.formulas).toHaveLength(2);
    const [first, second] = state.formulas;
    expect(first.id).not.toBe(second.id);
    state = updateFormula(state, first.id, { expression: 'a * 2', alias: 'double' });
    expect(state.formulas[0]).toMatchObject({ id: first.id, kind: 'formula', expression: 'a * 2', alias: 'double' });
    state = removeFormula(state, first.id);
    expect(state.formulas.map((f) => f.id)).toEqual([second.id]);
  });

  it('merges display and split patches', () => {
    const state = setSplit(setDisplay(defaultState(), { palette: 'warm', reverse: true }), { key: 'env' });
    expect(state.display).toMatchObject({ palette: 'warm', reverse: true, display: 'lines' });
    expect(state.split).toEqual({ ...defaultState().split, key: 'env' });
  });

  it('returns the same state when the visualization does not change', () => {
    const state = defaultState();
    expect(setViz(state, 'timeseries')).toBe(state);
    expect(setViz(state, 'toplist').viz).toBe('toplist');
  });
});

describe('useExplorerState URL sync', () => {
  const sample = (): ExplorerState => withQueries(query('a', { metric: 'cpu', groupBy: ['host'] }));

  beforeEach(() => {
    mockLocation.search = {};
    partial.mockClear();
    localStorage.clear();
  });

  const navigate = (search: UrlQueryMap) =>
    act(() => {
      mockLocation.search = search;
      mockLocation.changes.next();
    });

  it('starts from the URL and does not rewrite an identical value', () => {
    mockLocation.search = { [URL_PARAM]: encodeState(sample()) };
    const { result } = renderHook(() => useExplorerState());
    expect(result.current.state).toEqual(sample());
    expect(result.current.warning).toBeUndefined();
    expect(partial).not.toHaveBeenCalled();
  });

  it('writes the initial state and every change to the URL and local storage', () => {
    const { result } = renderHook(() => useExplorerState(() => ({ state: sample() })));
    expect(partial).toHaveBeenLastCalledWith({ [URL_PARAM]: encodeState(sample()) }, true);

    act(() => result.current.addQuery());
    const written = mockLocation.search[URL_PARAM] as string;
    expect(JSON.parse(written).queries.map((q: MetricQuery) => q.letter)).toEqual(['a', 'b']);
    expect(partial).toHaveBeenLastCalledWith({ [URL_PARAM]: written }, true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(written);
  });

  it('ignores location events caused by its own writes', () => {
    const { result } = renderHook(() => useExplorerState(() => ({ state: sample() })));
    act(() => result.current.setViz('toplist'));
    const state = result.current.state;
    navigate({ ...mockLocation.search });
    expect(result.current.state).toBe(state);
  });

  it('replaces the state when the URL changes from outside (back/forward, pasted link)', () => {
    const { result } = renderHook(() => useExplorerState(() => ({ state: sample() })));
    const other: ExplorerState = { ...withQueries(query('a', { metric: 'mem' }), query('b')), viz: 'table' };
    partial.mockClear();
    navigate({ [URL_PARAM]: encodeState(other) });
    expect(result.current.state).toEqual(other);
    // The URL already holds the new state, so nothing is written back.
    expect(partial).not.toHaveBeenCalled();
  });

  it('keeps the state and warns when the URL holds an invalid state', () => {
    const { result } = renderHook(() => useExplorerState(() => ({ state: sample() })));
    navigate({ [URL_PARAM]: '{"v":2}' });
    expect(result.current.state).toEqual(sample());
    expect(result.current.warning).toMatch(/invalid/);
    act(() => result.current.dismissWarning());
    expect(result.current.warning).toBeUndefined();
  });

  it('ignores location changes without the parameter', () => {
    const { result } = renderHook(() => useExplorerState(() => ({ state: sample() })));
    const state = result.current.state;
    navigate({ from: 'now-6h' });
    expect(result.current.state).toBe(state);
  });

  it('reports the warning of an invalid initial link', () => {
    mockLocation.search = { [URL_PARAM]: 'not json' };
    const { result } = renderHook(() => useExplorerState());
    expect(result.current.state.queries).toHaveLength(1);
    expect(result.current.warning).toMatch(/invalid/);
  });

  it('applies kind defaults through the latest lookup', () => {
    const empty = () => ({ state: withQueries(query('a')) });
    const { result, rerender } = renderHook(({ lookup }) => useExplorerState(empty, { kindOf: lookup }), {
      initialProps: { lookup: (() => undefined) as (m: string) => MetricKind | undefined },
    });
    rerender({ lookup: kindOf });
    act(() => result.current.updateQuery('id-a', { metric: 'requests_total' }));
    expect(result.current.state.queries[0]).toMatchObject({ metric: 'requests_total', spaceAgg: 'sum' });
    expect(result.current.state.queries[0].functions.map((f) => f.name)).toEqual(['as_count']);
  });

  describe('readable links', () => {
    const metrics: MetricInfo[] = [
      { name: 'cpu', kind: 'gauge', streams: { base: 'cpu' } },
      { name: 'requests_total', kind: 'delta_counter', streams: { base: 'requests_total' } },
    ];
    const renderWithCatalogue = () =>
      renderHook(({ list }) => useExplorerState(undefined, { metrics: list }), {
        initialProps: { list: undefined as MetricInfo[] | undefined },
      });

    it('waits for the catalogue, then builds the state and rewrites the URL to mx in place', () => {
      mockLocation.search = { q: ['avg:cpu{*} by {host}', 'requests.total{*}'], f: 'a/b*100', from: 'now-6h' };
      localStorage.setItem(STORAGE_KEY, encodeState(sample()));
      const { result, rerender } = renderWithCatalogue();
      expect(result.current.pending).toBe(true);
      expect(partial).not.toHaveBeenCalled();

      rerender({ list: metrics });
      expect(result.current.pending).toBe(false);
      expect(result.current.warning).toBeUndefined();
      const { queries, formulas } = result.current.state;
      expect(queries.map((q) => [q.letter, q.metric, q.spaceAgg, q.hidden])).toEqual([
        ['a', 'cpu', 'avg', true],
        ['b', 'requests_total', 'sum', true],
      ]);
      expect(formulas.map((f) => f.expression)).toEqual(['a/b*100']);
      expect(partial).toHaveBeenCalledTimes(1);
      expect(partial).toHaveBeenCalledWith({ [URL_PARAM]: encodeState(result.current.state), q: null, f: null }, true);
      expect(mockLocation.search).toEqual({ [URL_PARAM]: encodeState(result.current.state), from: 'now-6h' });
    });

    it('warns about the parameters it could not read', () => {
      mockLocation.search = { q: ['avg:cpu{*}', 'avg:cpu{'], viz: 'pie' };
      const { result, rerender } = renderWithCatalogue();
      rerender({ list: metrics });
      expect(result.current.state.queries.map((q) => q.metric)).toEqual(['cpu']);
      expect(result.current.warning).toContain('q=avg:cpu{ (');
      expect(result.current.warning).toContain('viz=pie (');
      expect(mockLocation.search).toEqual({ [URL_PARAM]: encodeState(result.current.state) });
    });

    it('builds a readable link navigated to while open', () => {
      const { result } = renderHook(() => useExplorerState(() => ({ state: sample() }), { metrics }));
      navigate({ q: 'max:cpu{*}', viz: 'table' });
      expect(result.current.state.queries.map((q) => [q.metric, q.spaceAgg])).toEqual([['cpu', 'max']]);
      expect(result.current.state.viz).toBe('table');
      expect(mockLocation.search).toEqual({ [URL_PARAM]: encodeState(result.current.state) });
    });
  });

  it('stops listening on unmount', () => {
    const { result, unmount } = renderHook(() => useExplorerState(() => ({ state: sample() })));
    const state = result.current.state;
    unmount();
    navigate({ [URL_PARAM]: encodeState(withQueries(query('a', { metric: 'mem' }))) });
    expect(result.current.state).toBe(state);
  });
});
