import {
  buildHistogram,
  createTheme,
  DataFrame,
  FieldType,
  formattedValueToString,
  getDisplayProcessor,
  LoadingState,
  outerJoinDataFrames,
  PanelData,
} from '@grafana/data';

import { CompiledPlan } from '../compile';
import { DisplayOptions, ExplorerState, MetricInfo, SplitOptions } from '../model/types';
import { buildCharts, evaluate, PALETTES } from './index';
import { compiled, formula, panelData, plan, promFrame, query, state } from './testFixtures';

const theme = createTheme();
const metrics: Record<string, MetricInfo | undefined> = {
  cpu: { name: 'cpu', kind: 'gauge', streams: { base: 'cpu' }, unit: 'percent', unitLabel: 'Percent' },
  mem: { name: 'mem', kind: 'gauge', streams: { base: 'mem' }, unit: 'bytes', unitLabel: 'Bytes' },
};

const flat = (v: number) => Array.from({ length: 11 }, () => v);
const peak = [5, 6, 9, 7, 4, 3, 2, 1, 2, 3, 4];

function charts(s: ExplorerState, p: CompiledPlan, frames: DataFrame[]) {
  return buildCharts(s, p, evaluate(p, panelData(frames), s, metrics), theme, metrics);
}

/** One grouped query `a` by host with the given series. */
function grouped(hosts: Record<string, Array<number | null>>, overrides: Partial<ExplorerState> = {}) {
  const s = state({ queries: [query('a', { metric: 'cpu', groupBy: ['host'] })], ...overrides });
  const frames = Object.entries(hosts).map(([host, values]) => promFrame('a', { host }, values));
  return charts(s, plan([compiled('a', { textForm: 'avg:cpu{*} by {host}' })]), frames);
}

const valueField = (frame: DataFrame) => frame.fields[1];
const names = (data: PanelData) => data.series.map((f) => valueField(f).config.displayName);
const withDisplay = (display: Partial<DisplayOptions>) => ({ display: { ...state().display, ...display } });

describe('timeseries', () => {
  it('one frame per series: time field first, then the value field', () => {
    const [chart] = grouped({ a: flat(1), b: flat(2) });
    expect(chart.pluginId).toBe('timeseries');
    expect(chart.title).toBe('avg:m{*}');
    expect(chart.data.state).toBe(LoadingState.Done);
    expect(chart.data.timeRange).toBeDefined();
    const frame = chart.data.series[0];
    expect(frame.fields.map((f) => [f.name, f.type])).toEqual([
      ['Time', FieldType.time],
      ['Value', FieldType.number],
      ['__mx_label_0', FieldType.number],
    ]);
    expect(frame.fields[0].config.interval).toBe(60000);
    expect(frame.length).toBe(11);
    expect(frame.refId).toBe('a');
    expect(valueField(frame).labels).toEqual({ host: 'b' });
    expect(valueField(frame).config).toEqual({
      displayName: 'b',
      color: { mode: 'fixed', fixedColor: PALETTES.classic.colors[0] },
    });
  });

  it('field config and options for lines', () => {
    const [chart] = grouped({ a: flat(1) });
    expect(chart.fieldConfig).toEqual({
      defaults: {
        unit: 'percent',
        custom: {
          drawStyle: 'line',
          fillOpacity: 0,
          stacking: { mode: 'none', group: 'A' },
          lineWidth: 2,
          lineStyle: { fill: 'solid' },
          lineInterpolation: 'linear',
          showPoints: 'never',
          spanNulls: 300000,
          axisSoftMin: 0,
          axisLabel: 'Percent',
        },
      },
      overrides: [],
    });
    expect(chart.options).toEqual({
      legend: { showLegend: true, displayMode: 'list', placement: 'bottom', calcs: [] },
      tooltip: { mode: 'single', sort: 'none' },
    });
  });

  it('bars and areas stack; stroke and style set width and dashes', () => {
    const custom = (display: Partial<DisplayOptions>) =>
      grouped({ a: flat(1) }, withDisplay(display))[0].fieldConfig.defaults.custom;
    expect(custom({ display: 'bars' })).toMatchObject({
      drawStyle: 'bars',
      fillOpacity: 80,
      stacking: { mode: 'normal', group: 'A' },
      barAlignment: 1,
    });
    expect(custom({ display: 'areas' })).toMatchObject({
      drawStyle: 'line',
      fillOpacity: 60,
      stacking: { mode: 'normal' },
    });
    expect(custom({ display: 'areas' }).barAlignment).toBeUndefined();
    expect(custom({ stroke: 'thin' }).lineWidth).toBe(1);
    expect(custom({ stroke: 'thick' }).lineWidth).toBe(3);
    expect(custom({ lineStyle: 'dashed' }).lineStyle).toEqual({ fill: 'dash', dash: [10, 10] });
    expect(custom({ lineStyle: 'dotted' }).lineStyle).toEqual({ fill: 'dot', dash: [0, 5] });
  });

  it('orders by mean value and colours in that order', () => {
    const [chart] = grouped({ low: flat(1), high: flat(9), mid: flat(5) });
    expect(names(chart.data)).toEqual(['high', 'mid', 'low']);
    expect(chart.data.series.map((f) => valueField(f).config.color?.fixedColor)).toEqual(
      PALETTES.classic.colors.slice(0, 3)
    );
  });

  it('orders by tags and reverses', () => {
    const hosts = { 'web-10': flat(1), 'web-2': flat(9), 'web-1': flat(5) };
    expect(names(grouped(hosts, withDisplay({ orderBy: 'tags' }))[0].data)).toEqual(['web-1', 'web-2', 'web-10']);
    expect(names(grouped(hosts, withDisplay({ orderBy: 'tags', reverse: true }))[0].data)).toEqual([
      'web-10',
      'web-2',
      'web-1',
    ]);
  });

  it('consistent palette colours a series by its name', () => {
    const one = grouped({ a: flat(1), b: flat(2) }, withDisplay({ palette: 'consistent' }))[0];
    const other = grouped({ b: flat(2), c: flat(9), a: flat(1) }, withDisplay({ palette: 'consistent' }))[0];
    const colorOf = (data: PanelData, name: string) =>
      data.series.map(valueField).find((f) => f.config.displayName === name)?.config.color?.fixedColor;
    expect(colorOf(one.data, 'b')).toBe(colorOf(other.data, 'b'));
    expect(colorOf(one.data, 'a')).toBe(colorOf(other.data, 'a'));
  });

  it('prefixes grouped names when two visible rows share the chart, leaves hidden rows out', () => {
    const s = state({
      queries: [
        query('a', { metric: 'cpu', groupBy: ['host'] }),
        query('b', { metric: 'cpu', groupBy: ['host'] }),
        query('c', { metric: 'cpu', hidden: true }),
      ],
    });
    const p = plan([compiled('a'), compiled('b'), compiled('c')]);
    const frames = [
      promFrame('a', { host: 'x' }, flat(1)),
      promFrame('b', { host: 'x' }, flat(2)),
      promFrame('c', {}, flat(3)),
    ];
    expect(names(charts(s, p, frames)[0].data)).toEqual(['b · x', 'a · x']);
    const onlyA = [promFrame('a', { host: 'x' }, flat(1)), promFrame('c', {}, flat(3))];
    expect(names(charts(s, p, onlyA)[0].data)).toEqual(['x']);
  });

  it('gives fields of another unit their own unit and axis label', () => {
    const s = state({ queries: [query('a', { metric: 'cpu' }), query('b', { metric: 'mem' })] });
    const p = plan([compiled('a', { textForm: 'avg:cpu{*}' }), compiled('b', { textForm: 'avg:mem{*}' })]);
    const [chart] = charts(s, p, [promFrame('a', {}, flat(9)), promFrame('b', {}, flat(1))]);
    expect(chart.fieldConfig.defaults.unit).toBe('percent');
    expect(valueField(chart.data.series[0]).config.unit).toBeUndefined();
    expect(valueField(chart.data.series[1]).config).toMatchObject({ unit: 'bytes', custom: { axisLabel: 'Bytes' } });
    expect(chart.data.series[1].fields[2].config.unit).toBe('bytes');
    // The label helper sits on its series' axis: Grafana keys axes by unit and axis label.
    expect(chart.data.series[1].fields[2].config.custom).toMatchObject({ axisLabel: 'Bytes' });
  });

  it('no series: one chart without frames', () => {
    const [chart] = grouped({});
    expect(chart.data.series).toEqual([]);
    expect(chart.title).toBe('avg:m{*}');
  });
});

describe('colour overrides', () => {
  const colors = (data: PanelData) => data.series.map((f) => valueField(f).config.color?.fixedColor);

  it('a hex colour colours an ungrouped query; the palette continues over the other rows', () => {
    const s = state({
      queries: [query('a', { metric: 'cpu', color: '#ff0000' }), query('b', { metric: 'cpu' })],
    });
    const p = plan([compiled('a', { textForm: 'avg:cpu{*}' }), compiled('b', { textForm: 'max:cpu{*}' })]);
    const [chart] = charts(s, p, [promFrame('a', {}, flat(9)), promFrame('b', {}, flat(1))]);
    expect(names(chart.data)).toEqual(['avg:cpu{*}', 'max:cpu{*}']);
    expect(colors(chart.data)).toEqual(['#ff0000', '#3598ec']);
    expect(chart.data.series[0].fields[2].config.color?.fixedColor).toBe('#ff0000');
  });

  it('a palette colours the series of a grouped query; a hex colour does not apply to one', () => {
    const hosts = { low: flat(1), high: flat(9) };
    const blue = grouped(hosts, { queries: [query('a', { metric: 'cpu', groupBy: ['host'], color: 'blue' })] })[0];
    expect(colors(blue.data)).toEqual([PALETTES.blue.colors[0], PALETTES.blue.colors[7]]);
    const hex = grouped(hosts, { queries: [query('a', { metric: 'cpu', groupBy: ['host'], color: '#ff0000' })] })[0];
    expect(colors(hex.data)).toEqual(['#3598ec', '#5d4ebe']);
  });
});

describe('show labels', () => {
  const helper = (frame: DataFrame) => frame.fields[2];

  it('ungrouped, not aliased: global max and min', () => {
    const s = state({ queries: [query('a', { metric: 'cpu' })] });
    const [chart] = charts(s, plan([compiled('a')]), [promFrame('a', {}, peak)]);
    const field = helper(chart.data.series[0]);
    expect(field.name).toBe('__mx_label_0');
    expect(field.values).toEqual([null, null, 9, null, null, null, null, 1, null, null, null]);
    expect(field.config.mappings).toBeUndefined();
    expect(field.config.color).toEqual(valueField(chart.data.series[0]).config.color);
    expect(field.config.custom).toEqual({
      drawStyle: 'points',
      pointSize: 6,
      showValues: true,
      showPoints: 'always',
      hideFrom: { legend: true, tooltip: true, viz: false },
      stacking: { mode: 'none' },
    });
  });

  it('grouped: the last point, labelled with the series name', () => {
    const [chart] = grouped({ x: [1, 2, 3, null, null, null, null, null, null, null, null] });
    const field = helper(chart.data.series[0]);
    expect(field.values).toEqual([null, null, 3, null, null, null, null, null, null, null, null]);
    expect(field.config.mappings).toEqual([{ type: 'value', options: { '3': { text: 'x' } } }]);
  });

  it('aliased: the last point, labelled with the alias', () => {
    const s = state({ queries: [query('a', { metric: 'cpu', alias: 'CPU' })] });
    const [chart] = charts(s, plan([compiled('a')]), [promFrame('a', {}, peak)]);
    expect(helper(chart.data.series[0]).config.mappings).toEqual([
      { type: 'value', options: { '4': { text: 'CPU' } } },
    ]);
  });

  it('only for lines, only with show labels on, only up to six series', () => {
    const six = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((h, i) => [h, flat(i)]));
    const seven = { ...six, g: flat(7) };
    const fieldCounts = (data: PanelData) => data.series.map((f) => f.fields.length);
    expect(fieldCounts(grouped(six)[0].data)).toEqual(Array(6).fill(3));
    expect(fieldCounts(grouped(seven)[0].data)).toEqual(Array(7).fill(2));
    expect(fieldCounts(grouped(six, withDisplay({ display: 'bars' }))[0].data)).toEqual(Array(6).fill(2));
    expect(fieldCounts(grouped(six, withDisplay({ display: 'areas' }))[0].data)).toEqual(Array(6).fill(2));
    expect(fieldCounts(grouped(six, withDisplay({ showLabels: false }))[0].data)).toEqual(Array(6).fill(2));
  });
});

describe('split by', () => {
  const split = (limit: number, display: Partial<DisplayOptions> = {}, options: Partial<SplitOptions> = {}) => {
    const s = state({
      queries: [query('a', { metric: 'cpu', groupBy: ['host'] })],
      split: { key: 'env', limit, order: 'top', sortBy: 'avg', ...options },
      ...withDisplay(display),
    });
    const frames = [
      promFrame('a', { host: 'x', env: 'dev' }, flat(1)),
      promFrame('a', { host: 'y', env: 'dev' }, flat(2)),
      promFrame('a', { host: 'x', env: 'prod' }, flat(50)),
      promFrame('a', { host: 'x' }, flat(10)),
      promFrame('a', { host: 'x', env: 'qa' }, [-5, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]),
    ];
    return charts(s, plan([compiled('a')]), frames);
  };

  it('one chart per value, ranked by mean, titled by the value', () => {
    expect(split(12).map((c) => c.title)).toEqual(['prod', 'N/A', 'qa', 'dev']);
    expect(split(2).map((c) => c.title)).toEqual(['prod', 'N/A']);
  });

  it('ranks by the sort reducer, top or bottom', () => {
    expect(split(12, {}, { order: 'bottom' }).map((c) => c.title)).toEqual(['dev', 'qa', 'N/A', 'prod']);
    expect(split(2, {}, { order: 'bottom' }).map((c) => c.title)).toEqual(['dev', 'qa']);
    expect(split(12, {}, { sortBy: 'min' }).map((c) => c.title)).toEqual(['prod', 'N/A', 'dev', 'qa']);
    expect(split(12, {}, { sortBy: 'sum' }).map((c) => c.title)).toEqual(['prod', 'N/A', 'dev', 'qa']);
    expect(split(12, {}, { sortBy: 'max', order: 'bottom' }).map((c) => c.title)).toEqual(['dev', 'qa', 'N/A', 'prod']);
  });

  it('names leave out the split key; every tile starts the palette again', () => {
    const tiles = split(12);
    const dev = tiles.find((c) => c.title === 'dev')!;
    expect(names(dev.data)).toEqual(['y', 'x']);
    const qa = tiles.find((c) => c.title === 'qa')!;
    expect(names(qa.data)).toEqual(['x']);
    expect(valueField(qa.data.series[0]).config.color?.fixedColor).toBe('#3598ec');
  });

  it('uniform soft y bounds across the shown tiles', () => {
    for (const chart of split(12)) {
      expect(chart.fieldConfig.defaults.custom).toMatchObject({ axisSoftMin: -5, axisSoftMax: 50 });
    }
    for (const chart of split(2)) {
      expect(chart.fieldConfig.defaults.custom).toMatchObject({ axisSoftMin: 0, axisSoftMax: 50 });
    }
  });

  it('stacked displays use the stacked sums for the bounds', () => {
    const tiles = split(12, { display: 'bars' });
    expect(tiles[0].fieldConfig.defaults.custom).toMatchObject({ axisSoftMin: -5, axisSoftMax: 50 });
    const devOnly = split(12, { display: 'areas' }).find((c) => c.title === 'dev')!;
    expect(devOnly.fieldConfig.defaults.custom.axisSoftMax).toBe(50);
  });

  it('no series: a single empty chart', () => {
    const s = state({ split: { key: 'env', limit: 12, order: 'top', sortBy: 'avg' } });
    const result = charts(s, plan([compiled('a')]), []);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('avg:m{*}');
  });
});

describe('toplist', () => {
  const toplist = (overrides: Partial<ExplorerState> = {}) =>
    grouped(
      { a: flat(1), b: [10, 20, null, null, null, null, null, null, null, null, null], c: flat(5) },
      {
        viz: 'toplist',
        ...overrides,
      }
    )[0];

  it('one frame, one row per series reduced and sorted descending', () => {
    const chart = toplist();
    expect(chart.pluginId).toBe('bargauge');
    const [frame] = chart.data.series;
    expect(frame.fields.map((f) => [f.name, f.type])).toEqual([
      ['name', FieldType.string],
      ['value', FieldType.number],
    ]);
    expect(frame.fields[0].values).toEqual(['b', 'c', 'a']);
    expect(frame.fields[1].values).toEqual([15, 5, 1]);
  });

  it('reducer, reverse and limit', () => {
    expect(toplist({ reducer: 'max' }).data.series[0].fields[1].values).toEqual([20, 5, 1]);
    expect(toplist({ reducer: 'last' }).data.series[0].fields[1].values).toEqual([20, 5, 1]);
    expect(toplist({ reducer: 'sum' }).data.series[0].fields[1].values).toEqual([55, 30, 11]);
    expect(toplist({ ...withDisplay({ reverse: true }) }).data.series[0].fields[0].values).toEqual(['a', 'c', 'b']);
    expect(toplist({ toplistLimit: 2 } as Partial<ExplorerState>).data.series[0].fields[0].values).toEqual(['b', 'c']);
  });

  it('bar gauge options and a palette colour per row', () => {
    const chart = toplist();
    expect(chart.options).toEqual({
      orientation: 'horizontal',
      displayMode: 'basic',
      valueMode: 'text',
      namePlacement: 'left',
      showUnfilled: true,
      sizing: 'manual',
      minVizHeight: 16,
      maxVizHeight: 24,
      text: { titleSize: 12, valueSize: 12 },
      reduceOptions: { values: true, calcs: [], fields: '/^value$/', limit: 10 },
    });
    expect(chart.fieldConfig.defaults).toEqual({
      unit: 'percent',
      min: 0,
      color: { mode: 'fixed', fixedColor: PALETTES.classic.colors[0] },
    });
    expect(chart.fieldConfig.overrides[1]).toEqual({
      matcher: { id: 'byName', options: 'c' },
      properties: [{ id: 'color', value: { mode: 'fixed', fixedColor: PALETTES.classic.colors[1] } }],
    });
  });
});

describe('bar chart', () => {
  const bars = (overrides: Partial<ExplorerState> = {}) =>
    grouped(
      { a: flat(1), b: [10, 20, null, null, null, null, null, null, null, null, null], c: flat(5) },
      {
        viz: 'barchart',
        ...overrides,
      }
    )[0];

  it('one bar per series reduced and sorted, x is the name', () => {
    const chart = bars();
    expect(chart.pluginId).toBe('barchart');
    const [frame] = chart.data.series;
    expect(frame.fields.map((f) => [f.name, f.type, f.values])).toEqual([
      ['name', FieldType.string, ['b', 'c', 'a']],
      ['value', FieldType.number, [15, 5, 1]],
    ]);
    expect(bars({ reducer: 'max' }).data.series[0].fields[1].values).toEqual([20, 5, 1]);
    expect(chart.options).toMatchObject({
      orientation: 'vertical',
      xField: 'name',
      colorByField: 'name',
      stacking: 'none',
      legend: { showLegend: false },
      tooltip: { mode: 'single' },
    });
    expect(chart.fieldConfig.defaults).toMatchObject({ unit: 'percent', custom: { axisLabel: 'Percent' } });
  });

  it("colours each bar through the name field's value mappings", () => {
    const name = bars().data.series[0].fields[0];
    const display = getDisplayProcessor({ field: name, theme });
    expect(['b', 'c', 'a'].map((v) => [display(v).text, display(v).color])).toEqual([
      ['b', '#3598ec'],
      ['c', '#5d4ebe'],
      ['a', '#efc328'],
    ]);
    expect(name.config.custom).toEqual({ fillOpacity: 80 });
  });

  it('no series: no frames', () => {
    expect(grouped({}, { viz: 'barchart' })[0].data.series).toEqual([]);
  });
});

describe('pie chart', () => {
  it('one slice per series with a value, reduced, palette coloured; the legend shows percentages', () => {
    const [chart] = grouped(
      { a: flat(1), b: flat(3), none: Array(11).fill(null) },
      { viz: 'piechart', ...withDisplay({ palette: 'vivid' }) }
    );
    expect(chart.pluginId).toBe('piechart');
    const [frame] = chart.data.series;
    expect(frame.fields.map((f) => [f.name, f.values, f.config.color?.fixedColor])).toEqual([
      ['b', [3], PALETTES.vivid.colors[0]],
      ['a', [1], PALETTES.vivid.colors[1]],
    ]);
    expect(chart.options).toMatchObject({
      reduceOptions: { values: false, calcs: ['lastNotNull'] },
      pieType: 'donut',
      legend: { showLegend: true, values: ['percent'] },
      tooltip: { mode: 'single' },
    });
    expect(grouped({}, { viz: 'piechart' })[0].data.series).toEqual([]);
  });
});

describe('distribution', () => {
  it('a histogram over every point of the visible series', () => {
    const [chart] = grouped({ a: flat(1), b: [2, null, 3, 4, 5, 6, 7, 8, 9, 10, 11] }, { viz: 'distribution' });
    expect(chart.pluginId).toBe('histogram');
    const [frame] = chart.data.series;
    expect(frame.fields).toHaveLength(1);
    expect(frame.fields[0].values).toHaveLength(21);
    expect(frame.fields[0].config).toMatchObject({ unit: 'percent', color: { fixedColor: '#3598ec' } });
    expect(chart.options).toMatchObject({ combine: false, legend: { showLegend: false } });
    const histogram = buildHistogram(chart.data.series)!;
    expect(histogram.counts[0].values.reduce((a: number, b: number) => a + b, 0)).toBe(21);
    expect(grouped({}, { viz: 'distribution' })[0].data.series).toEqual([]);
  });
});

describe('query value', () => {
  it('stat panel over the first visible row with its sparkline', () => {
    const s = state({
      viz: 'queryvalue',
      reducer: 'last',
      queries: [query('a', { metric: 'cpu', hidden: true }), query('b', { metric: 'cpu' })],
    });
    const p = plan([compiled('a'), compiled('b', { textForm: 'avg:cpu{*}' })]);
    const [chart] = charts(s, p, [promFrame('a', {}, flat(1)), promFrame('b', {}, flat(2))]);
    expect(chart.pluginId).toBe('stat');
    expect(chart.data.series).toHaveLength(1);
    expect(chart.data.series[0].fields.map((f) => f.type)).toEqual([FieldType.time, FieldType.number]);
    expect(valueField(chart.data.series[0]).config.displayName).toBe('avg:cpu{*}');
    expect(chart.options).toEqual({
      reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' },
      graphMode: 'area',
      colorMode: 'none',
      textMode: 'value',
      justifyMode: 'auto',
      orientation: 'auto',
      wideLayout: true,
      showPercentChange: false,
    });
    expect(chart.fieldConfig.defaults.unit).toBe('percent');
  });

  it('maps every reducer to a Grafana calculation', () => {
    const calc = (reducer: ExplorerState['reducer']) =>
      (grouped({ a: flat(1) }, { viz: 'queryvalue', reducer })[0].options.reduceOptions as { calcs: string[] }).calcs;
    expect(calc('avg')).toEqual(['mean']);
    expect(calc('sum')).toEqual(['sum']);
    expect(calc('min')).toEqual(['min']);
    expect(calc('max')).toEqual(['max']);
  });
});

describe('table', () => {
  it('group keys as columns, one reduced column per visible row, joined on labels, sorted', () => {
    const s = state({
      viz: 'table',
      queries: [query('a', { metric: 'cpu', groupBy: ['host'] }), query('b', { metric: 'mem', groupBy: ['host'] })],
      formulas: [],
    });
    const p = plan(
      [compiled('a', { textForm: 'avg:cpu{*} by {host}' }), compiled('b', { textForm: 'avg:mem{*} by {host}' })],
      [formula(1, 'b / a', { alias: 'ratio' })]
    );
    const frames = [
      promFrame('a', { host: 'x' }, flat(1)),
      promFrame('a', { host: 'y' }, flat(4)),
      promFrame('b', { host: 'x' }, flat(10)),
      promFrame('b', {}, flat(7)),
    ];
    const [chart] = charts(s, p, frames);
    expect(chart.pluginId).toBe('table');
    const [frame] = chart.data.series;
    expect(frame.fields.map((f) => [f.name, f.type])).toEqual([
      ['host', FieldType.string],
      ['avg:cpu{*} by {host}', FieldType.number],
      ['avg:mem{*} by {host}', FieldType.number],
      ['ratio', FieldType.number],
    ]);
    expect(frame.fields.map((f) => f.values)).toEqual([
      ['y', 'x', 'N/A'],
      [4, 1, null],
      [null, 10, 7],
      [null, 10, null],
    ]);
    expect(frame.fields[2].config.unit).toBe('bytes');
    expect(chart.options).toEqual({
      showHeader: true,
      cellHeight: 'sm',
      sortBy: [{ displayName: 'avg:cpu{*} by {host}', desc: true }],
    });
  });

  it('disambiguates rows with the same name', () => {
    const s = state({ viz: 'table', queries: [query('a'), query('b')] });
    const p = plan([compiled('a'), compiled('b')]);
    const [chart] = charts(s, p, [promFrame('a', {}, flat(1)), promFrame('b', {}, flat(2))]);
    expect(chart.data.series[0].fields.map((f) => f.name)).toEqual(['avg:m{*} (a)', 'avg:m{*} (b)']);
  });
});

describe('heatmap', () => {
  it('all series of visible rows into a calculated heatmap', () => {
    const [chart] = grouped(
      { a: flat(1), b: flat(2), c: flat(3) },
      { viz: 'heatmap', ...withDisplay({ palette: 'warm' }) }
    );
    expect(chart.pluginId).toBe('heatmap');
    expect(chart.data.series).toHaveLength(3);
    expect(chart.data.series[0].fields.map((f) => f.type)).toEqual([FieldType.time, FieldType.number]);
    expect(chart.options).toMatchObject({
      calculate: true,
      yAxis: { axisPlacement: 'left', unit: 'percent' },
      color: { mode: 'scheme', scheme: 'YlOrRd' },
    });
    const vivid = grouped({ a: flat(1) }, { viz: 'heatmap', ...withDisplay({ palette: 'vivid' }) })[0];
    expect(vivid.options).toMatchObject({ color: { scheme: 'Turbo' } });
  });
});

describe('grafana compatibility', () => {
  it('timeseries frames outer-join on time as the panel does', () => {
    const [chart] = grouped({ x: flat(1), y: [2, 3, null, 5, 6, 7, 8, 9, 10, 11, 12] });
    const joined = outerJoinDataFrames({ frames: chart.data.series })!;
    expect(joined.length).toBe(11);
    expect(joined.fields[0].type).toBe(FieldType.time);
    expect(joined.fields.slice(1).map((f) => [f.type, f.config.displayName])).toEqual([
      [FieldType.number, 'y'],
      [FieldType.number, '__mx_label_0'],
      [FieldType.number, 'x'],
      [FieldType.number, '__mx_label_1'],
    ]);
  });

  it("Grafana's display processor draws the series name for a last-point label", () => {
    const [chart] = grouped({ x: [1, 2, 3.25, null, null, null, null, null, null, null, null] });
    const helper = chart.data.series[0].fields[2];
    const display = getDisplayProcessor({ field: helper, theme });
    expect(display(3.25).text).toBe('x');
  });

  it("Grafana's display processor formats a max/min label with the unit", () => {
    const s = state({ queries: [query('a', { metric: 'cpu' })] });
    const [chart] = charts(s, plan([compiled('a')]), [promFrame('a', {}, peak)]);
    const helper = chart.data.series[0].fields[2];
    const field = { ...helper, config: { ...helper.config, unit: chart.fieldConfig.defaults.unit } };
    expect(formattedValueToString(getDisplayProcessor({ field, theme })(9))).toBe('9%');
  });
});
