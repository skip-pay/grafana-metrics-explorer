import {
  createDataFrame,
  DataFrame,
  Field,
  FieldColorModeId,
  FieldConfig,
  FieldConfigSource,
  FieldType,
  LoadingState,
  MappingType,
  PanelData,
  TimeRange,
  VizOrientation,
} from '@grafana/data';
import type { GraphFieldConfig, LineStyle } from '@grafana/schema';
// Runtime enums come from @grafana/ui (a Grafana-provided external), so @grafana/schema stays out of the bundle.
import {
  AxisPlacement,
  BarAlignment,
  BarGaugeDisplayMode,
  BarValueVisibility,
  BigValueColorMode,
  BigValueGraphMode,
  BigValueJustifyMode,
  BigValueTextMode,
  DrawStyle,
  GraphGradientMode,
  LegendDisplayMode,
  LineInterpolation,
  PointVisibility,
  StackingMode,
  TooltipDisplayMode,
} from '@grafana/ui';

import { DisplayOptions, ExplorerState, PaletteId, Reducer, Series, SplitOptions } from '../model/types';
import { extremeIndices, labelField, lastIndex, MAX_LABELLED_SERIES } from './labels';
import { isGrouped, RowNaming, seriesName } from './names';
import { assignColors, isHexColor, naturalCompare, orderSeries, seriesColor } from './palette';
import { isValue, labelKey, reduceValues, ReducerName, tagValue, unionKeys } from './series';

/** Props for one `PanelRenderer` (one chart, or one tile of a split). */
export interface ChartModel {
  title: string;
  pluginId: string;
  data: PanelData;
  options: Record<string, unknown>;
  fieldConfig: FieldConfigSource;
}

/** A row as the builders see it. */
export interface VizRow extends RowNaming {
  ref: string;
  series: Series[];
  unit?: string;
  unitLabel?: string;
  /** The query's colour override: a hex colour (ungrouped rows) or a palette id. */
  color?: string;
}

export interface VizContext {
  title: string;
  timeRange: TimeRange;
  stepSec: number;
}

/** A series placed in a chart, with its legend name. */
export interface ChartItem {
  series: Series;
  row: VizRow;
  name: string;
}

const LINE_WIDTH = { thin: 1, normal: 2, thick: 3 };
const FILL_OPACITY = { lines: 0, bars: 80, areas: 60 };
const LINE_STYLE: Record<DisplayOptions['lineStyle'], LineStyle> = {
  solid: { fill: 'solid' },
  dashed: { fill: 'dash', dash: [10, 10] },
  // Dense enough to read as a line at the thin stroke.
  dotted: { fill: 'dot', dash: [0, 5] },
};
/** Grafana reducer ids (for the stat panel) and the engine's reducers. */
const REDUCER_CALC: Record<Reducer, string> = { avg: 'mean', sum: 'sum', min: 'min', max: 'max', last: 'lastNotNull' };
const REDUCE: Record<Reducer, ReducerName> = { avg: 'mean', sum: 'sum', min: 'min', max: 'max', last: 'last' };
const HEATMAP_SCHEME: Record<PaletteId, string> = {
  consistent: 'Spectral',
  classic: 'Blues',
  cool: 'GnBu',
  warm: 'YlOrRd',
  purple: 'Purples',
  orange: 'Oranges',
  gray: 'Greys',
  red: 'Reds',
  green: 'Greens',
  blue: 'Blues',
  vivid: 'Turbo',
};
const LEGEND_HIDDEN = { showLegend: false, displayMode: LegendDisplayMode.List, placement: 'bottom', calcs: [] };
const TOOLTIP_SINGLE = { mode: TooltipDisplayMode.Single, sort: 'none' };

function fixedColor(color: string) {
  return { mode: FieldColorModeId.Fixed, fixedColor: color };
}

function panelData(series: DataFrame[], timeRange: TimeRange): PanelData {
  return { state: LoadingState.Done, series, timeRange };
}

/** Series of the rows in one chart with their legend names; grouped names get a row prefix when rows share it. */
function chartItems(rows: VizRow[], exclude?: string): ChartItem[] {
  const prefix = rows.filter((r) => r.series.length > 0).length > 1;
  return rows.flatMap((row) =>
    row.series.map((series) => ({ series, row, name: seriesName(row, series.labels, { prefix, exclude }) }))
  );
}

/** A row's colour override as it applies: a hex colour only while the row's series are not grouped. */
function rowOverride(row: VizRow, exclude?: string): string | undefined {
  return row.color && !(isHexColor(row.color) && isGrouped(row, exclude)) ? row.color : undefined;
}

/** Colours of ordered chart items: row overrides first, the chart palette over the rest. */
function itemColors(items: ChartItem[], palette: PaletteId, exclude?: string): string[] {
  return assignColors(
    items.map((item) => ({ name: item.name, row: item.row.ref, override: rowOverride(item.row, exclude) })),
    palette
  );
}

/** Items with their value reduced by the state's reducer, highest first (`reverse`: lowest first), nulls last. */
function rankItems(items: ChartItem[], state: ExplorerState, ctx: VizContext) {
  return items
    .map((item) => ({ item, value: reduceValues(item.series.values, REDUCE[state.reducer], ctx.stepSec) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === null ? (b.value === null ? 0 : 1) : -1;
      }
      return state.display.reverse ? a.value - b.value : b.value - a.value;
    });
}

function timeField(times: number[], stepSec: number): Field {
  return { name: 'Time', type: FieldType.time, values: times, config: { interval: stepSec * 1000 } };
}

/** Unit and axis label of a field when they differ from the chart defaults. */
function unitConfig(item: ChartItem, defaults: { unit?: string; axisLabel?: string }): FieldConfig {
  if ((item.row.unit ?? '') === (defaults.unit ?? '')) {
    return {};
  }
  return { unit: item.row.unit ?? 'short', custom: { axisLabel: item.row.unitLabel ?? '' } };
}

export interface TimeseriesOptions {
  /** Tile title instead of the plan title. */
  title?: string;
  /** Shared soft y range of split tiles. */
  softRange?: { min: number; max: number };
  /** Split key left out of names (it is in the tile title). */
  exclude?: string;
}

export function timeseriesChart(
  rows: VizRow[],
  state: ExplorerState,
  ctx: VizContext,
  opts: TimeseriesOptions = {}
): ChartModel {
  const items = chartItems(rows, opts.exclude);
  const display = state.display;
  const ordered = orderSeries(items, display, (item) => item);
  const colors = itemColors(ordered, display.palette, opts.exclude);
  const unit = ordered[0]?.row.unit;
  const axisLabel = ordered[0]?.row.unitLabel;
  const showLabels = display.showLabels && display.display === 'lines' && ordered.length <= MAX_LABELLED_SERIES;

  const frames = ordered.map((item, i) => {
    const color = colors[i];
    const extra = unitConfig(item, { unit, axisLabel });
    const fields: Field[] = [
      timeField(item.series.times, ctx.stepSec),
      {
        name: 'Value',
        type: FieldType.number,
        values: item.series.values,
        labels: item.series.labels,
        config: { displayName: item.name, color: fixedColor(color), ...extra },
      },
    ];
    if (showLabels) {
      const named = isGrouped(item.row, opts.exclude) || item.row.aliased;
      const indices = named ? lastIndex(item.series.values) : extremeIndices(item.series.values);
      fields.push(
        labelField(i, item.series.values, indices, color, {
          unit: extra.unit,
          axisLabel: (extra.custom as { axisLabel?: string } | undefined)?.axisLabel,
          text: named ? item.name : undefined,
        })
      );
    }
    return createDataFrame({ name: item.name, refId: item.series.refLetter, fields });
  });

  const lines = display.display === 'lines';
  const custom: GraphFieldConfig = {
    drawStyle: display.display === 'bars' ? DrawStyle.Bars : DrawStyle.Line,
    fillOpacity: FILL_OPACITY[display.display],
    stacking: { mode: lines ? StackingMode.None : StackingMode.Normal, group: 'A' },
    lineWidth: LINE_WIDTH[display.stroke],
    lineStyle: LINE_STYLE[display.lineStyle],
    lineInterpolation: LineInterpolation.Linear,
    showPoints: PointVisibility.Never,
    spanNulls: 300000,
    axisSoftMin: opts.softRange ? Math.min(0, opts.softRange.min) : 0,
    ...(opts.softRange ? { axisSoftMax: opts.softRange.max } : {}),
    ...(axisLabel ? { axisLabel } : {}),
    // Points are bucket starts, so a bar covers the step after its timestamp.
    ...(display.display === 'bars' ? { barAlignment: BarAlignment.After } : {}),
  };

  return {
    title: opts.title ?? ctx.title,
    pluginId: 'timeseries',
    data: panelData(frames, ctx.timeRange),
    options: {
      // A split tile with one series is named by its title already.
      legend: {
        showLegend: opts.title === undefined || ordered.length > 1,
        displayMode: LegendDisplayMode.List,
        placement: 'bottom',
        calcs: [],
      },
      // The nearest series only.
      tooltip: TOOLTIP_SINGLE,
    },
    fieldConfig: { defaults: { ...(unit ? { unit } : {}), custom }, overrides: [] },
  };
}

export function toplistChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const ranked = rankItems(chartItems(rows), state, ctx).slice(0, state.toplistLimit);
  const unit = ranked[0]?.item.row.unit;
  const colors = itemColors(
    ranked.map((r) => r.item),
    state.display.palette
  );
  const values = ranked.map((r) => r.value);
  const frame = createDataFrame({
    refId: 'toplist',
    fields: [
      { name: 'name', type: FieldType.string, values: ranked.map((r) => r.item.name), config: {} },
      { name: 'value', type: FieldType.number, values, config: {} },
    ],
  });
  const allPositive = values.every((v) => v === null || v >= 0);
  return {
    title: ctx.title,
    pluginId: 'bargauge',
    data: panelData([frame], ctx.timeRange),
    options: {
      orientation: VizOrientation.Horizontal,
      displayMode: BarGaugeDisplayMode.Basic,
      valueMode: 'text',
      namePlacement: 'left',
      showUnfilled: true,
      // Compact rows with fixed text instead of bars and fonts that grow with the panel; at 24 px rows the panel
      // sizes the name column for 12 px text.
      sizing: 'manual',
      minVizHeight: 16,
      maxVizHeight: 24,
      text: { titleSize: 12, valueSize: 12 },
      reduceOptions: { values: true, calcs: [], fields: '/^value$/', limit: state.toplistLimit },
    },
    fieldConfig: {
      defaults: {
        ...(unit ? { unit } : {}),
        ...(allPositive ? { min: 0 } : {}),
        color: fixedColor(colors[0] ?? seriesColor(state.display.palette, 0, 1, ctx.title)),
      },
      // Bar gauge rows take their colour from a `byName` colour override matching the row name.
      overrides: ranked.map((r, i) => ({
        matcher: { id: 'byName', options: r.item.name },
        properties: [{ id: 'color', value: fixedColor(colors[i]) }],
      })),
    },
  };
}

/** Vertical bars, one per series, reduced by the state's reducer; each bar takes its colour from the name field. */
export function barChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const ranked = rankItems(chartItems(rows), state, ctx);
  const unit = ranked[0]?.item.row.unit;
  const axisLabel = ranked[0]?.item.row.unitLabel;
  const colors = itemColors(
    ranked.map((r) => r.item),
    state.display.palette
  );
  const names = ranked.map((r) => r.item.name);
  const frames =
    ranked.length === 0
      ? []
      : [
          createDataFrame({
            refId: 'barchart',
            fields: [
              {
                name: 'name',
                type: FieldType.string,
                values: names,
                config: {
                  mappings: [
                    {
                      type: MappingType.ValueToText,
                      options: Object.fromEntries(names.map((name, i) => [name, { color: colors[i], index: i }])),
                    },
                  ],
                  // The panel reads the fill opacity of the colour field.
                  custom: { fillOpacity: 80 },
                },
              },
              {
                name: 'value',
                type: FieldType.number,
                values: ranked.map((r) => r.value),
                config: { displayName: state.reducer },
              },
            ],
          }),
        ];
  return {
    title: ctx.title,
    pluginId: 'barchart',
    data: panelData(frames, ctx.timeRange),
    options: {
      orientation: VizOrientation.Vertical,
      xField: 'name',
      colorByField: 'name',
      showValue: BarValueVisibility.Auto,
      text: { valueSize: 12 },
      stacking: StackingMode.None,
      groupWidth: 0.7,
      barWidth: 0.97,
      barRadius: 0,
      fullHighlight: false,
      xTickLabelRotation: 0,
      xTickLabelSpacing: 0,
      legend: LEGEND_HIDDEN,
      tooltip: TOOLTIP_SINGLE,
    },
    fieldConfig: {
      defaults: {
        ...(unit ? { unit } : {}),
        custom: {
          fillOpacity: 80,
          gradientMode: GraphGradientMode.None,
          lineWidth: 1,
          ...(axisLabel ? { axisLabel } : {}),
        },
      },
      overrides: [],
    },
  };
}

/** One slice per series, reduced by the state's reducer; the legend shows the share of each. */
export function pieChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const ranked = rankItems(chartItems(rows), state, ctx).filter((r) => r.value !== null);
  const unit = ranked[0]?.item.row.unit;
  const colors = itemColors(
    ranked.map((r) => r.item),
    state.display.palette
  );
  const frames = ranked.length
    ? [
        createDataFrame({
          refId: 'piechart',
          fields: ranked.map((r, i) => ({
            name: r.item.name,
            type: FieldType.number,
            values: [r.value],
            config: { displayName: r.item.name, color: fixedColor(colors[i]) },
          })),
        }),
      ]
    : [];
  return {
    title: ctx.title,
    pluginId: 'piechart',
    data: panelData(frames, ctx.timeRange),
    options: {
      reduceOptions: { values: false, calcs: ['lastNotNull'], fields: '' },
      pieType: 'donut',
      displayLabels: [],
      sort: 'desc',
      legend: {
        showLegend: true,
        displayMode: LegendDisplayMode.List,
        placement: 'right',
        values: ['percent'],
        calcs: [],
      },
      tooltip: TOOLTIP_SINGLE,
    },
    fieldConfig: { defaults: { ...(unit ? { unit } : {}) }, overrides: [] },
  };
}

/** A histogram over every point of the visible series. */
export function distributionChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const items = chartItems(rows);
  const values = items.flatMap((item) => item.series.values.filter(isValue));
  const unit = items[0]?.row.unit;
  const color = itemColors(items.slice(0, 1), state.display.palette)[0] ?? seriesColor(state.display.palette, 0, 1, '');
  const frames = values.length
    ? [
        createDataFrame({
          refId: 'distribution',
          fields: [
            {
              name: 'Value',
              type: FieldType.number,
              values,
              config: { displayName: ctx.title, color: fixedColor(color), ...(unit ? { unit } : {}) },
            },
          ],
        }),
      ]
    : [];
  return {
    title: ctx.title,
    pluginId: 'histogram',
    data: panelData(frames, ctx.timeRange),
    options: { combine: false, legend: LEGEND_HIDDEN, tooltip: TOOLTIP_SINGLE },
    fieldConfig: {
      defaults: {
        ...(unit ? { unit } : {}),
        custom: { fillOpacity: 80, gradientMode: GraphGradientMode.None, lineWidth: 1 },
      },
      overrides: [],
    },
  };
}

export function queryValueChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const row = rows.find((r) => r.series.length > 0);
  const series = row?.series[0];
  const item = row && series ? { row, series, name: seriesName(row, series.labels) } : undefined;
  const color = item ? itemColors([item], state.display.palette)[0] : seriesColor(state.display.palette, 0, 1, '');
  const frames = item ? [valueFrame(item.series, item.name, color, ctx)] : [];
  return {
    title: ctx.title,
    pluginId: 'stat',
    data: panelData(frames, ctx.timeRange),
    options: {
      reduceOptions: { values: false, calcs: [REDUCER_CALC[state.reducer]], fields: '' },
      graphMode: BigValueGraphMode.Area,
      colorMode: BigValueColorMode.None,
      textMode: BigValueTextMode.Value,
      justifyMode: BigValueJustifyMode.Auto,
      orientation: VizOrientation.Auto,
      wideLayout: true,
      showPercentChange: false,
    },
    fieldConfig: { defaults: { ...(row?.unit ? { unit: row.unit } : {}), color: fixedColor(color) }, overrides: [] },
  };
}

function valueFrame(series: Series, name: string, color: string, ctx: VizContext): DataFrame {
  return createDataFrame({
    name,
    refId: series.refLetter,
    fields: [
      timeField(series.times, ctx.stepSec),
      {
        name: 'Value',
        type: FieldType.number,
        values: series.values,
        labels: series.labels,
        config: { displayName: name, color: fixedColor(color) },
      },
    ],
  });
}

/** Column title of a row in the table: alias, else the query text form or the formula expression. */
function columnNames(rows: VizRow[]): string[] {
  const names = rows.map((r) => r.ungroupedName);
  return names.map((n, i) => (names.indexOf(n) !== i || names.lastIndexOf(n) !== i ? `${n} (${rows[i].ref})` : n));
}

export function tableChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const keys = rows.reduce<string[]>((acc, r) => unionKeys(acc, r.keys), []);
  const columns = columnNames(rows);
  const joined = new Map<string, { labels: Record<string, string>; values: Array<number | null> }>();
  rows.forEach((row, col) => {
    for (const s of row.series) {
      const id = labelKey(s.labels, keys);
      if (!joined.has(id)) {
        joined.set(id, { labels: s.labels, values: rows.map(() => null) });
      }
      joined.get(id)!.values[col] = reduceValues(s.values, REDUCE[state.reducer], ctx.stepSec);
    }
  });
  const tableRows = [...joined.values()].sort((a, b) => {
    const x = a.values[0];
    const y = b.values[0];
    return isValue(x) && isValue(y) ? y - x : isValue(x) ? -1 : isValue(y) ? 1 : 0;
  });
  const colors = assignColors(
    rows.map((row, col) => ({ name: columns[col], row: row.ref, override: rowOverride(row) })),
    state.display.palette
  );
  const frame = createDataFrame({
    refId: 'table',
    fields: [
      ...keys.map((k) => ({
        name: k,
        type: FieldType.string,
        values: tableRows.map((r) => tagValue(r.labels, k)),
        config: {},
      })),
      ...rows.map((row, col) => ({
        name: columns[col],
        type: FieldType.number,
        values: tableRows.map((r) => r.values[col]),
        config: {
          displayName: columns[col],
          color: fixedColor(colors[col]),
          ...(row.unit ? { unit: row.unit } : {}),
        },
      })),
    ],
  });
  return {
    title: ctx.title,
    pluginId: 'table',
    data: panelData([frame], ctx.timeRange),
    options: {
      showHeader: true,
      cellHeight: 'sm',
      ...(columns.length ? { sortBy: [{ displayName: columns[0], desc: true }] } : {}),
    },
    fieldConfig: { defaults: {}, overrides: [] },
  };
}

export function heatmapChart(rows: VizRow[], state: ExplorerState, ctx: VizContext): ChartModel {
  const items = chartItems(rows);
  const color = seriesColor(state.display.palette, 0, 1, ctx.title);
  const unit = items[0]?.row.unit;
  return {
    title: ctx.title,
    pluginId: 'heatmap',
    data: panelData(
      items.map((item) => valueFrame(item.series, item.name, color, ctx)),
      ctx.timeRange
    ),
    options: {
      calculate: true,
      yAxis: { axisPlacement: AxisPlacement.Left, ...(unit ? { unit } : {}) },
      color: {
        mode: 'scheme',
        scheme: HEATMAP_SCHEME[state.display.palette] ?? 'Blues',
        fill: color,
        scale: 'exponential',
        exponent: 0.5,
        steps: 64,
        reverse: false,
      },
      cellGap: 1,
      legend: { show: true },
      tooltip: { mode: TooltipDisplayMode.Single, yHistogram: false, showColorScale: false },
    },
    fieldConfig: { defaults: { ...(unit ? { unit } : {}) }, overrides: [] },
  };
}

export interface Partition {
  value: string;
  rows: VizRow[];
}

/**
 * Partitions the rows' series by the split label and keeps the `limit` partitions ranked highest (`top`) or
 * lowest (`bottom`) by the `sortBy` reducer over all their points; partitions without points come last.
 */
export function partition(
  rows: VizRow[],
  split: Pick<SplitOptions, 'limit' | 'order' | 'sortBy'> & { key: string },
  stepSec: number
): Partition[] {
  const byValue = new Map<string, Map<string, Series[]>>();
  for (const row of rows) {
    for (const s of row.series) {
      const value = tagValue(s.labels, split.key);
      const partRows = byValue.get(value) ?? new Map<string, Series[]>();
      partRows.set(row.ref, [...(partRows.get(row.ref) ?? []), s]);
      byValue.set(value, partRows);
    }
  }
  const sign = split.order === 'bottom' ? -1 : 1;
  return [...byValue.entries()]
    .map(([value, partRows]) => ({
      value,
      score: reduceValues(pooled([...partRows.values()].flat()), REDUCE[split.sortBy], stepSec),
      rows: rows.map((r) => ({ ...r, series: partRows.get(r.ref) ?? [] })),
    }))
    .sort((a, b) => {
      if (a.score === null || b.score === null) {
        return a.score === b.score ? naturalCompare(a.value, b.value) : a.score === null ? 1 : -1;
      }
      return sign * (b.score - a.score) || naturalCompare(a.value, b.value);
    })
    .slice(0, split.limit)
    .map(({ value, rows: partRows }) => ({ value, rows: partRows }));
}

/** The points of several series on one grid in time order, so `last` reduces to a point of the latest time. */
function pooled(series: Series[]): Array<number | null> {
  const length = Math.max(0, ...series.map((s) => s.values.length));
  const out: Array<number | null> = [];
  for (let i = 0; i < length; i++) {
    for (const s of series) {
      out.push(s.values[i] ?? null);
    }
  }
  return out;
}

/** Y range of the partitions as drawn: point values for lines, stacked sums for bars and areas. */
export function uniformRange(parts: Partition[], stacked: boolean): { min: number; max: number } | undefined {
  let min = Infinity;
  let max = -Infinity;
  for (const part of parts) {
    const series = part.rows.flatMap((r) => r.series);
    const length = series[0]?.values.length ?? 0;
    for (let i = 0; i < length; i++) {
      let up = 0;
      let down = 0;
      for (const s of series) {
        const v = s.values[i];
        if (!isValue(v)) {
          continue;
        }
        if (stacked) {
          up += Math.max(v, 0);
          down += Math.min(v, 0);
        } else {
          min = Math.min(min, v);
          max = Math.max(max, v);
        }
      }
      if (stacked) {
        min = Math.min(min, down);
        max = Math.max(max, up);
      }
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : undefined;
}
