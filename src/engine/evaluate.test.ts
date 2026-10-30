import { dateTime } from '@grafana/data';

import { MetricInfo } from '../model/types';
import { evaluate, MAX_SERIES } from './evaluate';
import { compiled, emptyFrame, formula, FROM, panelData, plan, promFrame, query, state, T0, TO } from './testFixtures';

const metrics: Record<string, MetricInfo | undefined> = {
  cpu: { name: 'cpu', kind: 'gauge', streams: { base: 'cpu' }, unit: 'percent', unitLabel: 'Percent' },
  req: { name: 'req', kind: 'delta_counter', streams: { base: 'req' } },
};

const ramp = (from: number) => Array.from({ length: 11 }, (_, i) => from + i);

describe('evaluate', () => {
  it('turns range-query frames into named series on the shared grid', () => {
    const s = state({ queries: [query('a', { metric: 'cpu' })] });
    const p = plan([compiled('a', { textForm: 'avg:cpu{*}' })]);
    const result = evaluate(p, panelData([promFrame('a', {}, ramp(1))]), s, metrics);
    expect(result.seriesByRow.a).toHaveLength(1);
    expect(result.seriesByRow.a[0]).toMatchObject({
      refLetter: 'a',
      labels: {},
      name: 'avg:cpu{*}',
      unit: 'percent',
      values: ramp(1),
    });
    expect(result.seriesByRow.a[0].times).toBe(result.times);
    expect(result.rows[0]).toMatchObject({ ref: 'a', kind: 'query', keys: [], unitLabel: 'Percent', hidden: false });
    expect(result.stepSec).toBe(60);
    expect(result.rowErrors).toEqual({});
  });

  it('names grouped series by their tags, absent labels as N/A', () => {
    const s = state({ queries: [query('a', { groupBy: ['host'] })] });
    const frames = [promFrame('a', { host: 'web-1' }, ramp(1)), promFrame('a', {}, ramp(2))];
    const result = evaluate(plan([compiled('a')]), panelData(frames), s, metrics);
    expect(result.seriesByRow.a.map((x) => x.name)).toEqual(['web-1', 'N/A']);
    expect(result.rows[0].keys).toEqual(['host']);
  });

  it('uses the alias for ungrouped series', () => {
    const s = state({ queries: [query('a', { alias: 'CPU' })] });
    const result = evaluate(plan([compiled('a')]), panelData([promFrame('a', {}, ramp(1))]), s, metrics);
    expect(result.seriesByRow.a[0].name).toBe('CPU');
    expect(result.rows[0]).toMatchObject({ aliased: true, label: 'CPU', ungroupedName: 'CPU' });
  });

  it('adds the split key to the group keys of a split timeseries', () => {
    const s = state({
      queries: [query('a', { groupBy: ['host'] })],
      split: { key: 'env', limit: 12, order: 'top', sortBy: 'avg' },
    });
    const frames = [promFrame('a', { host: 'x', env: 'prod' }, ramp(1))];
    const result = evaluate(plan([compiled('a')]), panelData(frames), s, metrics);
    expect(result.rows[0].keys).toEqual(['host', 'env']);
    expect(result.seriesByRow.a[0].name).toBe('x, prod');
  });

  it('keeps labels the frames carry beyond the group-by', () => {
    const s = state({ queries: [query('a')] });
    const result = evaluate(plan([compiled('a')]), panelData([promFrame('a', { zone: 'b' }, ramp(1))]), s, metrics);
    expect(result.rows[0].keys).toEqual(['zone']);
    expect(result.seriesByRow.a[0].name).toBe('b');
  });

  it('runs the client chain in order, then fill', () => {
    const s = state({ queries: [query('a', { groupBy: ['host'] })] });
    const cq = compiled('a', {
      clientChain: [
        { id: '1', name: 'top', args: [1, 'mean', 'desc'] },
        { id: '2', name: 'cumsum', args: [] },
      ],
      fill: { method: 'zero', limitSec: 300 },
    });
    const frames = [
      promFrame('a', { host: 'small' }, ramp(0)),
      promFrame('a', { host: 'big' }, [null, null, 10, 10, 10, 10, 10, 10, 10, 10, 10]),
    ];
    const result = evaluate(plan([cq]), panelData(frames), s, metrics);
    expect(result.seriesByRow.a).toHaveLength(1);
    expect(result.seriesByRow.a[0].name).toBe('big');
    expect(result.seriesByRow.a[0].values).toEqual([0, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
  });

  it('default_zero gives an empty ungrouped query one zero series', () => {
    const s = state({ queries: [query('a')] });
    const cq = compiled('a', { clientChain: [{ id: '1', name: 'default_zero', args: [] }] });
    const result = evaluate(plan([cq]), panelData([emptyFrame('a')]), s, metrics);
    expect(result.seriesByRow.a).toHaveLength(1);
    expect(result.seriesByRow.a[0].values.every((v) => v === 0)).toBe(true);
    expect(result.seriesByRow.a[0].name).toBe('avg:m{*}');
  });

  it('count functions make a grouped query ungrouped', () => {
    const s = state({ queries: [query('a', { groupBy: ['host'] })] });
    const cq = compiled('a', { clientChain: [{ id: '1', name: 'count_not_null', args: [] }], textForm: 'c' });
    const frames = [promFrame('a', { host: 'x' }, ramp(0)), promFrame('a', { host: 'y' }, ramp(0))];
    const result = evaluate(plan([cq]), panelData(frames), s, metrics);
    expect(result.rows[0].keys).toEqual([]);
    expect(result.seriesByRow.a[0]).toMatchObject({ name: 'c', labels: {} });
    expect(result.seriesByRow.a[0].values[0]).toBe(2);
  });

  it('warns about a function without client implementation and skips it', () => {
    const s = state({ queries: [query('a')] });
    const cq = compiled('a', { clientChain: [{ id: '1', name: 'rollup', args: [] }] });
    const result = evaluate(plan([cq]), panelData([promFrame('a', {}, ramp(1))]), s, metrics);
    expect(result.warnings).toEqual(['Function `rollup` is not supported and was skipped']);
    expect(result.seriesByRow.a[0].values).toEqual(ramp(1));
  });

  it('skipped queries have no series', () => {
    const s = state({ queries: [query('a')] });
    const cq = compiled('a', { skip: 'Tag `x` does not exist on `m`', expr: '' });
    const result = evaluate(plan([cq]), panelData([promFrame('a', {}, ramp(1))]), s, metrics);
    expect(result.seriesByRow.a).toEqual([]);
  });

  it('maps datasource errors to their row', () => {
    const s = state({ queries: [query('a'), query('b')] });
    const data = panelData([], [{ refId: 'b', message: 'bad_data: parse error' }, { message: 'timeout' }]);
    const result = evaluate(plan([compiled('a'), compiled('b')]), data, s, metrics);
    expect(result.rowErrors).toEqual({ b: 'bad_data: parse error' });
    expect(result.warnings).toEqual(['timeout']);
  });

  it('refuses more than MAX_SERIES series in a row', () => {
    const s = state({ queries: [query('a', { groupBy: ['id'] })] });
    const frames = Array.from({ length: MAX_SERIES + 1 }, (_, i) => promFrame('a', { id: String(i) }, [1]));
    const result = evaluate(plan([compiled('a')]), panelData(frames), s, metrics);
    expect(result.seriesByRow.a).toEqual([]);
    expect(result.rowErrors.a).toBe(`Too many series (${MAX_SERIES + 1}). Add a filter or group by fewer tags.`);
  });

  it('evaluates formulas over hidden queries, in order', () => {
    const s = state({
      queries: [query('a', { hidden: true, metric: 'cpu' }), query('b', { hidden: true, metric: 'cpu' })],
    });
    const p = plan(
      [compiled('a', { textForm: 'avg:cpu{*}' }), compiled('b', { textForm: 'max:cpu{*}' })],
      [formula(1, 'a / b * 100'), formula(2, 'a + b', { alias: 'sum', hidden: true })]
    );
    const frames = [
      promFrame('a', {}, ramp(1)),
      promFrame(
        'b',
        {},
        ramp(1).map((v) => v * 2)
      ),
    ];
    const result = evaluate(p, panelData(frames), s, metrics);
    expect(result.seriesByRow.f1[0]).toMatchObject({
      refLetter: 'f1',
      name: 'avg:cpu{*} / max:cpu{*} * 100',
      unit: undefined,
    });
    expect(result.rows[2]).toMatchObject({ label: 'a / b * 100', ungroupedName: 'avg:cpu{*} / max:cpu{*} * 100' });
    expect(result.seriesByRow.f1[0].values.every((v) => v === 50)).toBe(true);
    expect(result.seriesByRow.f2[0]).toMatchObject({ name: 'sum', unit: 'percent' });
    expect(result.rows.map((r) => [r.ref, r.hidden])).toEqual([
      ['a', true],
      ['b', true],
      ['f1', false],
      ['f2', true],
    ]);
    expect(result.rows[3].unitLabel).toBe('Percent');
  });

  it('names grouped formula series by tags', () => {
    const s = state({ queries: [query('a', { groupBy: ['host'] })] });
    const p = plan([compiled('a')], [formula(1, 'a * 2')]);
    const result = evaluate(p, panelData([promFrame('a', { host: 'x' }, ramp(1))]), s, metrics);
    expect(result.seriesByRow.f1[0].name).toBe('x');
    expect(result.rows[1].keys).toEqual(['host']);
  });

  it("carries a query's colour override", () => {
    const s = state({ queries: [query('a', { color: '#ff0000' }), query('b')] });
    const result = evaluate(plan([compiled('a'), compiled('b')]), panelData([]), s, metrics);
    expect(result.rows.map((r) => r.color)).toEqual(['#ff0000', undefined]);
  });

  it('formula errors go to the formula row', () => {
    const s = state({ queries: [query('a')] });
    const p = plan([compiled('a')], [formula(1, 'a + q'), formula(2, 'a +'), formula(3, 'nope(a)')]);
    const result = evaluate(p, panelData([promFrame('a', {}, ramp(1))]), s, metrics);
    expect(result.rowErrors).toEqual({
      f1: 'Unknown query `q`',
      f2: 'Unexpected end of formula',
      f3: 'Unknown function `nope`',
    });
    expect(result.seriesByRow.f1).toEqual([]);
  });

  it('a letter without compiled query (no metric yet) is an empty operand, not an error', () => {
    const s = state({ queries: [query('a'), query('b', { metric: '' })] });
    const p = plan([compiled('a')], [formula(1, 'a + b')]);
    const result = evaluate(p, panelData([promFrame('a', {}, ramp(1))]), s, metrics);
    expect(result.rowErrors).toEqual({});
    expect(result.seriesByRow.f1).toEqual([]);
  });

  it('drops the leading bucket that ends before the range starts, after the client chain', () => {
    const data = { ...panelData([promFrame('a', {}, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])]) };
    data.timeRange = { from: dateTime(FROM), to: dateTime(TO), raw: { from: 'now-10m', to: 'now' } };
    const p = plan([compiled('a', { clientChain: [{ id: 'd', name: 'diff', args: [] }] })]);
    const result = evaluate(p, data, state(), metrics);
    // The bucket T0-60s..T0 is before FROM (T0+15s); its value still gives the first diff.
    expect(result.times[0]).toBe(T0);
    expect(result.times).toHaveLength(10);
    expect(result.seriesByRow.a[0].values).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(result.seriesByRow.a[0].times).toBe(result.times);
  });

  it('keeps nothing when every bucket ends before the range starts', () => {
    const hour = 3600_000;
    const start = Math.floor(T0 / hour) * hour;
    // A 15 min range from 20 min past the hour: the only value covers the hour before it.
    const frame = promFrame('a', {}, [42], { times: [start], step: 3600 });
    const data = { ...panelData([frame]) };
    data.timeRange = {
      from: dateTime(start + 20 * 60_000),
      to: dateTime(start + 35 * 60_000),
      raw: { from: 'now-15m', to: 'now' },
    };
    const p = { ...plan([compiled('a', { stepSec: 3600, windowSec: 3600 })]), stepSec: 3600 };
    const result = evaluate(p, data, state(), metrics);
    expect(result.times).toEqual([]);
    expect(result.seriesByRow.a).toHaveLength(1);
    expect(result.seriesByRow.a[0].values).toEqual([]);
  });

  it('no frames at all', () => {
    const result = evaluate(plan([compiled('a')]), panelData([]), state(), metrics);
    expect(result.seriesByRow.a).toEqual([]);
    expect(result.times).toHaveLength(11);
  });
});
