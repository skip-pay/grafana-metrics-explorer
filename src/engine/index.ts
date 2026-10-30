import { GrafanaTheme2 } from '@grafana/data';

import type { CompiledPlan } from '../compile';
import { ExplorerState, MetricInfo } from '../model/types';
import { EvaluateResult } from './evaluate';
import { formulaError } from './formula';
import {
  barChart,
  ChartModel,
  distributionChart,
  heatmapChart,
  partition,
  pieChart,
  queryValueChart,
  tableChart,
  timeseriesChart,
  toplistChart,
  uniformRange,
  VizContext,
  VizRow,
} from './viz';

export { CLIENT_FUNCTIONS } from './clientFunctions';
export { evaluate, MAX_SERIES } from './evaluate';
export type { EvaluateResult, RowResult } from './evaluate';
export { fitChart, fitTiles } from './fit';
export { labelFieldName } from './labels';
export { isPaletteId, PALETTES, seriesColor } from './palette';
export type { Palette } from './palette';
export type { ChartModel } from './viz';

/**
 * One chart model per chart: a single chart, or one timeseries tile per split value (titled by the value, with
 * shared soft y bounds). Hidden rows are left out.
 */
export function buildCharts(
  state: ExplorerState,
  plan: CompiledPlan,
  result: EvaluateResult,
  _theme: GrafanaTheme2,
  _metrics: Record<string, MetricInfo | undefined>
): ChartModel[] {
  const rows: VizRow[] = result.rows
    .filter((r) => !r.hidden)
    .map((r) => ({ ...r, series: result.seriesByRow[r.ref] ?? [] }));
  const ctx: VizContext = { title: plan.title, timeRange: result.timeRange, stepSec: result.stepSec };
  switch (state.viz) {
    case 'toplist':
      return [toplistChart(rows, state, ctx)];
    case 'queryvalue':
      return [queryValueChart(rows, state, ctx)];
    case 'table':
      return [tableChart(rows, state, ctx)];
    case 'heatmap':
      return [heatmapChart(rows, state, ctx)];
    case 'distribution':
      return [distributionChart(rows, state, ctx)];
    case 'barchart':
      return [barChart(rows, state, ctx)];
    case 'piechart':
      return [pieChart(rows, state, ctx)];
  }
  const key = state.split.key;
  const parts = key ? partition(rows, { ...state.split, key }, result.stepSec) : [];
  if (!key || parts.length === 0) {
    return [timeseriesChart(rows, state, ctx)];
  }
  const softRange = uniformRange(parts, state.display.display !== 'lines');
  return parts.map((part) => timeseriesChart(part.rows, state, ctx, { title: part.value, softRange, exclude: key }));
}

/** The error message for an invalid formula, or null when it parses and only uses known letters. */
export function validateFormula(expression: string, letters: string[]): string | null {
  return formulaError(expression, letters);
}
