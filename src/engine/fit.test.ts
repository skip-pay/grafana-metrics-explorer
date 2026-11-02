import { createTheme, DataFrame } from '@grafana/data';

import { ExplorerState, MetricInfo } from '../model/types';
import { alignAxes, fitChart, fitTiles, legendFit } from './fit';
import { buildCharts, evaluate } from './index';
import { compiled, panelData, plan, promFrame, query, state } from './testFixtures';

const theme = createTheme();
const metrics: Record<string, MetricInfo | undefined> = {
  cpu: { name: 'cpu', kind: 'gauge', streams: { base: 'cpu' }, unit: 'percent', unitLabel: 'Percent' },
  mem: { name: 'mem', kind: 'gauge', streams: { base: 'mem' }, unit: 'bytes', unitLabel: 'Bytes' },
};

function chart(hosts: Record<string, Array<number | null>>, overrides: Partial<ExplorerState> = {}) {
  const grouped = Object.keys(hosts).some((h) => h !== '');
  const s = state({ queries: [query('a', { metric: 'cpu', groupBy: grouped ? ['host'] : [] })], ...overrides });
  const frames = Object.entries(hosts).map(([host, values]) => promFrame('a', host ? { host } : {}, values));
  const p = plan([compiled('a', { textForm: grouped ? 'avg:cpu{*} by {host}' : 'avg:cpu{*}' })]);
  return buildCharts(s, p, evaluate(p, panelData(frames), s, metrics), theme, metrics)[0];
}

/** Indices where each frame's label field has a point. */
const labelPoints = (frames: DataFrame[]) =>
  frames.map((f) => (f.fields[2].values as Array<number | null>).flatMap((v, i) => (v === null ? [] : [i])));

const flat = (v: number) => Array.from({ length: 11 }, () => v);

describe('fitChart', () => {
  it('leaves other panels alone', () => {
    const toplist = chart({ a: flat(1) }, { viz: 'toplist' });
    expect(fitChart(toplist, 800, 400)).toBe(toplist);
  });

  it('moves a name label left until its text fits inside the chart', () => {
    const wide = fitChart(chart({ 'a-rather-long-host-name': flat(5) }), 2000, 400);
    expect(labelPoints(wide.data.series)).toEqual([[10]]);
    const narrow = fitChart(chart({ 'a-rather-long-host-name': flat(5) }), 400, 400);
    const [[i]] = labelPoints(narrow.data.series);
    expect(i).toBeLessThan(10);
    expect(narrow.data.series[0].fields[2].config.mappings).toEqual([
      { type: 'value', options: { '5': { text: 'a-rather-long-host-name' } } },
    ]);
  });

  it('keeps labels of series with the same values apart, or drops them', () => {
    const fitted = fitChart(chart({ a: flat(5), b: flat(5), c: flat(5) }), 800, 400);
    const points = labelPoints(fitted.data.series).map((p) => p[0]);
    const shown = points.filter((p) => p !== undefined);
    expect(new Set(shown).size).toBe(shown.length);
    expect(shown.length).toBeGreaterThan(1);
  });

  it('raises the soft max so a label at the top stays inside the plot', () => {
    const fitted = fitChart(chart({ '': [3, 2, 9, 3, 1, 2, 2, 2, 2, 2, 2] }), 800, 300);
    for (const field of fitted.data.series[0].fields.slice(1)) {
      expect((field.config.custom as { axisSoftMax?: number }).axisSoftMax).toBeGreaterThan(9);
    }
    expect(labelPoints(fitted.data.series)).toEqual([[2, 4]]);
  });

  it('raises only the axis that needs it', () => {
    const s = state({ queries: [query('a', { metric: 'cpu' }), query('b', { metric: 'mem' })] });
    const p = plan([compiled('a', { textForm: 'avg:cpu{*}' }), compiled('b', { textForm: 'avg:mem{*}' })]);
    const frames = [promFrame('a', {}, [3, 2, 9, 3, 1, 2, 2, 2, 2, 2, 2]), promFrame('b', {}, flat(1))];
    const fitted = fitChart(buildCharts(s, p, evaluate(p, panelData(frames), s, metrics), theme, metrics)[0], 800, 300);
    const softMax = (frame: DataFrame) =>
      frame.fields.slice(1).map((f) => (f.config.custom as { axisSoftMax?: number } | undefined)?.axisSoftMax);
    expect(softMax(fitted.data.series[0]).every((max) => max! > 9)).toBe(true);
    expect(softMax(fitted.data.series[1])).toEqual([undefined, undefined]);
  });

  it('drops a value label that would cover the y axis', () => {
    const fitted = fitChart(chart({ '': [1, 2, 9, 3, 2, 2, 2, 2, 2, 2, 2] }), 800, 300);
    expect(labelPoints(fitted.data.series)).toEqual([[2]]);
  });

  it('limits the legend to two rows', () => {
    const hosts = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`host-number-${i}`, flat(i)]));
    const fitted = fitChart(chart(hosts), 600, 400);
    const legend = fitted.options.legend as { limit?: number };
    expect(legend.limit).toBeGreaterThan(0);
    expect(legend.limit).toBeLessThan(40);
    expect(fitChart(chart({ a: flat(1) }), 600, 400).options.legend).not.toHaveProperty('limit');
  });
});

describe('fitTiles', () => {
  it('keeps one y range: the highest raised soft max goes to every tile', () => {
    const s = state({
      queries: [query('a', { metric: 'cpu' })],
      split: { byQuery: false, key: 'env', limit: 24, order: 'top', sortBy: 'avg' },
    });
    const p = plan([compiled('a', { textForm: 'avg:cpu{*}' })]);
    const frames = [
      promFrame('a', { env: 'prod' }, [3, 2, 9, 3, 1, 2, 2, 2, 2, 2, 2]),
      promFrame('a', { env: 'dev' }, flat(1)),
    ];
    const tiles = fitTiles(buildCharts(s, p, evaluate(p, panelData(frames), s, metrics), theme, metrics), 400, 160);
    const maxima = tiles.map((t) => (t.data.series[0].fields[1].config.custom as { axisSoftMax?: number }).axisSoftMax);
    expect(maxima[0]).toBeGreaterThan(9);
    expect(maxima[1]).toBe(maxima[0]);
  });
});

describe('alignAxes', () => {
  it('gives stacked tiles one y axis width, the axis label drawn outside it', () => {
    const percent = chart({ '': flat(5) });
    const big = chart({ '': flat(1234567) });
    const custom = { ...big.fieldConfig.defaults.custom, axisLabel: undefined };
    const plain = { ...big, fieldConfig: { defaults: { custom }, overrides: [] } };
    const [a, b] = alignAxes([percent, plain]);
    // `1234567` and two characters of 6.5 px, after the tick.
    expect(b.fieldConfig.defaults.custom.axisWidth).toBe(Math.ceil(9 + 9 * 6.5));
    expect(a.fieldConfig.defaults.custom.axisWidth).toBe(Math.ceil(9 + 9 * 6.5) - 20);
    expect(a.fieldConfig.defaults.custom.axisLabel).toBe('Percent');
  });
});

describe('legendFit', () => {
  it('no limit when everything fits in two rows', () => {
    expect(legendFit(['a', 'b'], 500)).toEqual({ limit: 0, rows: 1 });
    expect(legendFit([], 500)).toEqual({ limit: 0, rows: 0 });
  });

  it('stops before the item that would need a third row, leaving room for "show all"', () => {
    const names = Array.from({ length: 20 }, () => 'x'.repeat(20));
    const fit = legendFit(names, 500);
    expect(fit.rows).toBe(2);
    // 164 px per item: 2 in the first row, 2 in the second next to the button.
    expect(fit.limit).toBe(4);
  });
});
