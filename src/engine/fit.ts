import { DataFrame, Field, FieldType, MappingType, ValueMapping } from '@grafana/data';

import { LABEL_PREFIX } from './labels';
import { isValue } from './series';
import type { ChartModel } from './viz';

// Approximate geometry of Grafana's timeseries panel, in px.
const CHAR_PX = 6.5;
const TEXT_PAD_PX = 6;
/** Value text is drawn this far above its point and is this tall. */
const LABEL_LIFT_PX = 8;
const LABEL_HEIGHT_PX = 14;
const Y_AXIS_PX = 56;
const X_AXIS_PX = 28;
const EDGE_PX = 10;
const LEGEND_ROW_PX = 22;
const LEGEND_ITEM_PX = 34;
/** Room for the legend's "...show all N items" button. */
const LEGEND_MORE_PX = 130;
export const LEGEND_ROWS = 2;
/** Candidate positions tried, right to left, for a name label that collides. */
const NAME_TRIES = 8;

interface Box {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

interface Scale {
  min: number;
  max: number;
  /** The highest label point that needs room above it. */
  top?: number;
}

/**
 * Fits a timeseries chart to its size: the legend gets at most two rows (the rest behind Grafana's "show all"),
 * name labels move left until they fit inside the plot and clear the labels placed before them, value labels that
 * would collide are dropped, and the y axis gets headroom so labels at the top are not cut off.
 */
export function fitChart(chart: ChartModel, width: number, height: number): ChartModel {
  if (chart.pluginId !== 'timeseries' || width <= 0 || height <= 0) {
    return chart;
  }
  const legend = chart.options.legend as { showLegend?: boolean } | undefined;
  const names = chart.data.series.map((frame) => valueField(frame)?.config.displayName ?? '');
  const fit = legend?.showLegend ? legendFit(names, width) : { limit: 0, rows: 0 };
  const options = fit.limit > 0 ? { ...chart.options, legend: { ...legend, limit: fit.limit } } : chart.options;
  if (!chart.data.series.some((frame) => labelField(frame))) {
    return options === chart.options ? chart : { ...chart, options };
  }

  const defaults = chart.fieldConfig.defaults;
  const custom = (defaults.custom ?? {}) as { axisSoftMin?: number; axisSoftMax?: number };
  const unitOf = (field: Field) => field.config.unit ?? defaults.unit ?? '';
  const scales = new Map<string, Scale>();
  for (const frame of chart.data.series) {
    const field = valueField(frame);
    if (!field) {
      continue;
    }
    const scale = scales.get(unitOf(field)) ?? {
      min: custom.axisSoftMin ?? Infinity,
      max: custom.axisSoftMax ?? -Infinity,
    };
    for (const v of field.values as Array<number | null>) {
      if (isValue(v)) {
        scale.min = Math.min(scale.min, v);
        scale.max = Math.max(scale.max, v);
      }
    }
    scales.set(unitOf(field), scale);
  }

  const from = chart.data.timeRange.from.valueOf();
  const to = chart.data.timeRange.to.valueOf();
  const left = Y_AXIS_PX;
  const right = width - (scales.size > 1 ? Y_AXIS_PX : EDGE_PX);
  const top = EDGE_PX;
  const bottom = height - X_AXIS_PX - fit.rows * LEGEND_ROW_PX;
  if (right - left < 40 || bottom - top < 40 || to <= from) {
    return { ...chart, options };
  }
  const xOf = (t: number) => left + ((t - from) / (to - from)) * (right - left);
  const yOf = (v: number, s: Scale) =>
    s.max > s.min ? bottom - ((v - s.min) / (s.max - s.min)) * (bottom - top) : (top + bottom) / 2;

  const placed: Box[] = [];
  const frames = chart.data.series.map((frame) => {
    const value = valueField(frame);
    const label = labelField(frame);
    const time = frame.fields.find((f) => f.type === FieldType.time);
    const scale = value && scales.get(unitOf(value));
    if (!value || !label || !time || !scale) {
      return frame;
    }
    const times = time.values as number[];
    const values = value.values as Array<number | null>;
    const text = mappedText(label);
    const wanted = (label.values as Array<number | null>).flatMap((v, i) => (isValue(v) ? [i] : []));
    const box = (i: number, chars: number): Box => {
      const x = xOf(times[i]);
      const y = yOf(values[i]!, scale);
      const half = (chars * CHAR_PX + TEXT_PAD_PX) / 2;
      return { x1: x - half, x2: x + half, y1: y - LABEL_LIFT_PX - LABEL_HEIGHT_PX, y2: y - LABEL_LIFT_PX };
    };
    const free = (b: Box) => b.x1 >= left - 4 && b.x2 <= width - 2 && !placed.some((p) => overlaps(p, b));

    const chosen: number[] = [];
    if (text !== undefined) {
      for (const i of nameCandidates(wanted[0], values, times, xOf, (text.length * CHAR_PX + TEXT_PAD_PX) / 2, width)) {
        if (free(box(i, text.length))) {
          chosen.push(i);
          break;
        }
      }
    } else {
      for (const i of wanted) {
        if (free(box(i, valueChars(values[i]!, value.config.unit)))) {
          chosen.push(i);
        }
      }
    }
    for (const i of chosen) {
      const b = box(i, text?.length ?? valueChars(values[i]!, value.config.unit));
      placed.push(b);
      if (b.y1 < top) {
        scale.top = Math.max(scale.top ?? -Infinity, values[i]!);
      }
    }
    return withLabelPoints(frame, label, values, chosen, text);
  });

  const series = withHeadroom(frames, scales, unitOf, bottom - top);
  return { ...chart, options, data: { ...chart.data, series } };
}

/** Fits split tiles of one size; a soft max raised for one tile's labels is applied to all, keeping one y range. */
export function fitTiles(charts: ChartModel[], width: number, height: number): ChartModel[] {
  const fitted = charts.map((chart) => fitChart(chart, width, height));
  const maxima = new Map<string, number>();
  for (const chart of fitted) {
    for (const field of numberFields(chart)) {
      const max = (field.config.custom as { axisSoftMax?: number } | undefined)?.axisSoftMax;
      const unit = field.config.unit ?? chart.fieldConfig.defaults.unit ?? '';
      if (max !== undefined && max > (maxima.get(unit) ?? -Infinity)) {
        maxima.set(unit, max);
      }
    }
  }
  if (maxima.size === 0) {
    return fitted;
  }
  return fitted.map((chart) => {
    const unitOf = (field: Field) => field.config.unit ?? chart.fieldConfig.defaults.unit ?? '';
    return { ...chart, data: { ...chart.data, series: withSoftMax(chart.data.series, maxima, unitOf) } };
  });
}

function numberFields(chart: ChartModel): Field[] {
  return chart.data.series.flatMap((frame) => frame.fields).filter((f) => f.type === FieldType.number);
}

/** How many legend items fit in `LEGEND_ROWS` rows of the given width, and the rows the legend takes. */
export function legendFit(names: string[], width: number): { limit: number; rows: number } {
  const usable = Math.max(1, width - 16);
  let row = 1;
  let x = 0;
  for (let i = 0; i < names.length; i++) {
    const w = names[i].length * CHAR_PX + LEGEND_ITEM_PX;
    if (x > 0 && x + w > usable) {
      row++;
      x = 0;
    }
    const last = row === LEGEND_ROWS;
    if (row > LEGEND_ROWS || (last && i < names.length - 1 && x + w + LEGEND_MORE_PX > usable && x > 0)) {
      return { limit: Math.max(1, i), rows: LEGEND_ROWS };
    }
    x += w;
  }
  return { limit: 0, rows: names.length ? row : 0 };
}

function valueField(frame: DataFrame): Field | undefined {
  return frame.fields.find((f) => f.type === FieldType.number && !f.name.startsWith(LABEL_PREFIX));
}

function labelField(frame: DataFrame): Field | undefined {
  return frame.fields.find((f) => f.name.startsWith(LABEL_PREFIX));
}

/** The text of a name label (from its value mapping); undefined for a value label. */
function mappedText(field: Field): string | undefined {
  for (const mapping of field.config.mappings ?? []) {
    if (mapping.type === MappingType.ValueToText) {
      const text = Object.values(mapping.options)[0]?.text;
      if (text !== undefined) {
        return text;
      }
    }
  }
  return undefined;
}

/** Rough length of a formatted value: about three significant digits plus a unit suffix. */
function valueChars(v: number, unit?: string): number {
  const digits = Math.abs(v) >= 1000 ? String(Math.round(Math.abs(v))).length : 4;
  return digits + (v < 0 ? 1 : 0) + (unit ? 3 : 0);
}

/**
 * Indices for a name label, right to left: the last point whose label fits inside the chart, then points
 * one label width further left each time; only points with a value.
 */
function nameCandidates(
  last: number | undefined,
  values: Array<number | null>,
  times: number[],
  xOf: (t: number) => number,
  half: number,
  width: number
): number[] {
  const out: number[] = [];
  let limitX = width - 2 - half;
  for (let i = last ?? -1; i >= 0 && out.length < NAME_TRIES; i--) {
    if (isValue(values[i]) && xOf(times[i]) <= limitX) {
      out.push(i);
      limitX = xOf(times[i]) - 2 * half - 8;
    }
  }
  return out;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x1 < b.x2 + 4 && b.x1 < a.x2 + 4 && a.y1 < b.y2 && b.y1 < a.y2;
}

function withLabelPoints(
  frame: DataFrame,
  label: Field,
  values: Array<number | null>,
  chosen: number[],
  text: string | undefined
): DataFrame {
  const mappings: ValueMapping[] | undefined =
    text === undefined
      ? label.config.mappings
      : [
          {
            type: MappingType.ValueToText,
            options: Object.fromEntries(chosen.map((i) => [String(values[i]), { text }])),
          },
        ];
  const field: Field = {
    ...label,
    values: values.map((v, i) => (chosen.includes(i) ? v : null)),
    config: { ...label.config, ...(mappings ? { mappings } : {}) },
  };
  return { ...frame, fields: frame.fields.map((f) => (f === label ? field : f)) };
}

/**
 * Raises the soft max of every scale with a label at its top, so the label's text stays inside the plot. It is
 * set on each field of that unit: on the defaults it would also stretch the axes of other units.
 */
function withHeadroom(
  frames: DataFrame[],
  scales: Map<string, Scale>,
  unitOf: (field: Field) => string,
  plotHeight: number
): DataFrame[] {
  const room = (LABEL_LIFT_PX + LABEL_HEIGHT_PX + 4) / plotHeight;
  const maxima = new Map<string, number>();
  for (const [unit, scale] of scales) {
    if (scale.top !== undefined && room < 0.5) {
      const min = Math.min(scale.min, 0);
      maxima.set(unit, (scale.top - room * min) / (1 - room));
    }
  }
  return maxima.size === 0 ? frames : withSoftMax(frames, maxima, unitOf);
}

function withSoftMax(frames: DataFrame[], maxima: Map<string, number>, unitOf: (field: Field) => string): DataFrame[] {
  const raise = (field: Field): Field => {
    const max = field.type === FieldType.number ? maxima.get(unitOf(field)) : undefined;
    return max === undefined
      ? field
      : { ...field, config: { ...field.config, custom: { ...field.config.custom, axisSoftMax: max } } };
  };
  return frames.map((frame) => ({ ...frame, fields: frame.fields.map(raise) }));
}
