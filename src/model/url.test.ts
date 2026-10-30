import { locationService } from '@grafana/runtime';

import { defaultState } from './defaults';
import { ExplorerState } from './types';
import {
  decodeState,
  encodeState,
  readInitialState,
  readLinkParams,
  readUrlState,
  STORAGE_KEY,
  URL_PARAM,
  writeState,
} from './url';

jest.mock('@grafana/runtime', () => ({
  locationService: { getSearchObject: jest.fn(), partial: jest.fn() },
}));

const location = locationService as jest.Mocked<typeof locationService>;

const sample = (): ExplorerState => ({
  v: 1,
  viz: 'toplist',
  queries: [
    {
      kind: 'query',
      id: 'q1',
      letter: 'a',
      hidden: true,
      metric: 'http_requests_total',
      filters: [
        { key: 'env', op: 'eq', values: ['prod'] },
        { key: 'path', op: 'not_in', values: ['/health', '/ready'] },
      ],
      spaceAgg: 'sum',
      groupBy: ['path'],
      functions: [
        { id: 'f1', name: 'as_count', args: [] },
        { id: 'f2', name: 'top', args: [10, 'mean', 'desc'] },
      ],
      alias: 'requests',
      color: 'warm',
    },
    {
      kind: 'query',
      id: 'q2',
      letter: 'c',
      hidden: false,
      metric: 'cpu',
      filters: [],
      spaceAgg: 'avg',
      groupBy: [],
      functions: [],
      color: '#3598ec',
    },
  ],
  formulas: [{ kind: 'formula', id: 'x1', expression: 'a / c * 100', hidden: false, alias: 'ratio' }],
  display: {
    display: 'bars',
    showLabels: false,
    lineStyle: 'dashed',
    stroke: 'thick',
    palette: 'warm',
    orderBy: 'tags',
    reverse: true,
  },
  split: { key: 'env', limit: 6, order: 'bottom', sortBy: 'max' },
  reducer: 'max',
  toplistLimit: 25,
});

const decodeError = (text: string) => {
  const result = decodeState(text);
  if (result.ok) {
    throw new Error('expected an error');
  }
  return result.error;
};

describe('encodeState / decodeState', () => {
  it('round-trips a full state', () => {
    const state = sample();
    expect(decodeState(encodeState(state))).toEqual({ ok: true, state });
  });

  it('round-trips the default state', () => {
    const state = defaultState();
    expect(decodeState(encodeState(state))).toEqual({ ok: true, state });
  });

  it('fills missing fields with defaults', () => {
    const result = decodeState(JSON.stringify({ v: 1, queries: [{ metric: 'cpu' }, { letter: 'a' }] }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const { state } = result;
    const defaults = defaultState();
    expect(state.queries.map((q) => [q.letter, q.metric])).toEqual([
      ['b', 'cpu'],
      ['a', ''],
    ]);
    expect(state.queries[0].id).not.toBe(state.queries[1].id);
    expect(state.queries[0]).toMatchObject({ hidden: false, spaceAgg: 'avg', filters: [], groupBy: [], functions: [] });
    expect(state.display).toEqual(defaults.display);
    expect(state.split).toEqual(defaults.split);
    expect(state).toMatchObject({ viz: 'timeseries', formulas: [], reducer: 'avg', toplistLimit: 10 });
  });

  it('accepts every visualization and palette', () => {
    for (const viz of ['distribution', 'barchart', 'piechart']) {
      expect(decodeState(JSON.stringify({ v: 1, viz })).ok).toBe(true);
    }
    expect(decodeState('{"v":1,"display":{"palette":"vivid"}}').ok).toBe(true);
  });

  it('fills a partial split with defaults', () => {
    const result = decodeState('{"v":1,"split":{"key":"env","limit":12}}');
    expect(result.ok && result.state.split).toEqual({ key: 'env', limit: 12, order: 'top', sortBy: 'avg' });
  });

  it('gives a query without a letter a free one when z is taken', () => {
    const result = decodeState('{"v":1,"queries":[{"letter":"z"},{}]}');
    expect(result.ok && result.state.queries.map((q) => q.letter)).toEqual(['z', 'a']);
  });

  it('defaults to one query when queries are missing', () => {
    const result = decodeState('{"v":1}');
    expect(result.ok && result.state.queries.map((q) => q.letter)).toEqual(['a']);
  });

  it('replaces duplicate ids', () => {
    const result = decodeState(
      JSON.stringify({
        v: 1,
        queries: [
          { id: 'same', letter: 'a' },
          { id: 'same', letter: 'b' },
        ],
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.queries[0].id).toBe('same');
      expect(result.state.queries[1].id).not.toBe('same');
    }
  });

  it('drops unknown fields', () => {
    const result = decodeState(JSON.stringify({ ...sample(), extra: 1 }));
    expect(result.ok && 'extra' in result.state).toBe(false);
  });

  it.each([
    ['not json', 'not valid JSON'],
    ['[]', 'state: expected an object'],
    ['{"v":2}', 'unsupported version 2'],
    ['{"queries":[]}', 'unsupported version undefined'],
    ['{"v":1,"queries":[]}', 'queries: at least one query is required'],
    ['{"v":1,"viz":"pie"}', 'viz: "pie" is not one of'],
    ['{"v":1,"queries":[{"letter":"a"},{"letter":"a"}]}', 'queries[1].letter: invalid or duplicate letter "a"'],
    ['{"v":1,"queries":[{"letter":"A"}]}', 'queries[0].letter: invalid or duplicate letter "A"'],
    ['{"v":1,"queries":[{"spaceAgg":"median"}]}', 'queries[0].spaceAgg'],
    ['{"v":1,"queries":[{"metric":3}]}', 'queries[0].metric: expected a string'],
    ['{"v":1,"queries":[{"kind":"formula"}]}', 'queries[0].kind'],
    ['{"v":1,"queries":[{"filters":[{"key":"k","op":"eq","values":["a","b"]}]}]}', 'eq/neq take exactly one value'],
    ['{"v":1,"queries":[{"filters":[{"key":"k","op":"in","values":[]}]}]}', 'in/not_in take at least one value'],
    ['{"v":1,"queries":[{"filters":[{"key":"k","op":"like","values":["a"]}]}]}', 'queries[0].filters[0].op'],
    ['{"v":1,"queries":[{"functions":[{"name":"top","args":[null]}]}]}', 'functions[0].args[0]'],
    ['{"v":1,"formulas":[{"expression":1}]}', 'formulas[0].expression: expected a string'],
    ['{"v":1,"display":{"palette":"pink"}}', 'display.palette'],
    ['{"v":1,"display":{"reverse":"yes"}}', 'display.reverse: expected true or false'],
    ['{"v":1,"split":{"limit":7}}', 'split.limit'],
    ['{"v":1,"split":{"order":"desc"}}', 'split.order'],
    ['{"v":1,"split":{"sortBy":"mean"}}', 'split.sortBy'],
    ['{"v":1,"queries":[{"color":"blue-ish"}]}', 'queries[0].color: "blue-ish" is neither'],
    ['{"v":1,"queries":[{"color":3}]}', 'queries[0].color: expected a string'],
    ['{"v":1,"toplistLimit":11}', 'toplistLimit'],
  ])('rejects %s', (text, error) => {
    expect(decodeError(text)).toContain(error);
  });

  it('rejects more than 26 queries', () => {
    const queries = Array.from({ length: 27 }, () => ({}));
    expect(decodeError(JSON.stringify({ v: 1, queries }))).toBe('queries: too many queries');
  });
});

describe('URL and storage', () => {
  beforeEach(() => {
    location.getSearchObject.mockReturnValue({});
    location.partial.mockClear();
    localStorage.clear();
  });

  it('has no URL state without the parameter', () => {
    expect(readUrlState()).toBeNull();
    expect(readLinkParams()).toBeNull();
  });

  it('reads the readable link parameters as lists of text', () => {
    location.getSearchObject.mockReturnValue({ q: ['avg:cpu{*}', 'max:cpu{*}'], f: 100, viz: 'table', from: 'now-1h' });
    expect(readLinkParams()).toEqual({ q: ['avg:cpu{*}', 'max:cpu{*}'], f: ['100'], viz: ['table'] });
  });

  it('prefers the state to the readable link parameters', () => {
    const state = sample();
    location.getSearchObject.mockReturnValue({ [URL_PARAM]: encodeState(state), q: 'avg:cpu{*}', viz: 'table' });
    expect(readInitialState()).toEqual({ state });
  });

  it('leaves readable link parameters to be built later, before the stored state', () => {
    location.getSearchObject.mockReturnValue({ q: 'avg:cpu{*}', split: 'host' });
    localStorage.setItem(STORAGE_KEY, encodeState(sample()));
    const { state, link, warning } = readInitialState();
    expect(link).toEqual({ q: ['avg:cpu{*}'], split: ['host'] });
    expect(state.queries.map((q) => q.metric)).toEqual(['']);
    expect(warning).toBeUndefined();
  });

  it('reads the state from the URL first', () => {
    const state = sample();
    location.getSearchObject.mockReturnValue({ [URL_PARAM]: encodeState(state) });
    localStorage.setItem(STORAGE_KEY, encodeState(defaultState()));
    expect(readInitialState()).toEqual({ state });
  });

  it('falls back to the default state with a warning for an invalid URL state', () => {
    location.getSearchObject.mockReturnValue({ [URL_PARAM]: '{"v":9}' });
    localStorage.setItem(STORAGE_KEY, encodeState(sample()));
    const { state, warning } = readInitialState();
    expect(state.viz).toBe('timeseries');
    expect(state.queries).toHaveLength(1);
    expect(warning).toContain('unsupported version 9');
  });

  it('uses the last stored state when the URL has none', () => {
    const state = sample();
    localStorage.setItem(STORAGE_KEY, encodeState(state));
    expect(readInitialState()).toEqual({ state });
  });

  it('ignores an invalid stored state', () => {
    localStorage.setItem(STORAGE_KEY, 'garbage');
    const { state, warning } = readInitialState();
    expect(state.queries.map((q) => q.letter)).toEqual(['a']);
    expect(warning).toBeUndefined();
  });

  it('starts from the default state when storage is unavailable', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(readInitialState().state.queries).toHaveLength(1);
    spy.mockRestore();
  });

  it('writes the URL with replace and the storage', () => {
    const state = sample();
    writeState(state);
    expect(location.partial).toHaveBeenCalledWith({ [URL_PARAM]: encodeState(state) }, true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(encodeState(state));
  });

  it('replaces the readable link parameters with the state', () => {
    const state = sample();
    location.getSearchObject.mockReturnValue({
      q: ['avg:cpu{*}'],
      f: 'a*2',
      viz: 'table',
      display: 'bars',
      from: 'now-1h',
    });
    writeState(state);
    expect(location.partial).toHaveBeenCalledWith(
      { [URL_PARAM]: encodeState(state), q: null, f: null, viz: null, display: null },
      true
    );
  });

  it('drops readable link parameters next to an unchanged state', () => {
    const state = sample();
    location.getSearchObject.mockReturnValue({ [URL_PARAM]: encodeState(state), split: 'host' });
    writeState(state);
    expect(location.partial).toHaveBeenCalledWith({ [URL_PARAM]: encodeState(state), split: null }, true);
  });

  it('skips the URL write when the value is unchanged', () => {
    const state = sample();
    location.getSearchObject.mockReturnValue({ [URL_PARAM]: encodeState(state) });
    writeState(state);
    expect(location.partial).not.toHaveBeenCalled();
  });

  it('still writes the URL when storage throws', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    writeState(sample());
    expect(location.partial).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
