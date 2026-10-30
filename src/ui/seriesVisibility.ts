import {
  ByNamesMatcherMode,
  ConfigOverrideRule,
  DataFrame,
  FieldMatcherID,
  FieldType,
  getFieldDisplayName,
  SystemConfigOverrideRule,
} from '@grafana/data';
import { SeriesVisibilityChangeMode } from '@grafana/ui';

/** Display-name prefix of the engine's label-point helper fields. */
export const LABEL_FIELD_PREFIX = '__mx_label_';

/** Series names shown in the chart; `null` means all of them. */
export type VisibleSeries = string[] | null;

interface ChartSeries {
  /** Display names of the series (number fields that are not label helpers), in frame order. */
  names: string[];
  /** Label helper field names per series name. */
  helpers: Map<string, string[]>;
}

export function chartSeries(frames: DataFrame[]): ChartSeries {
  const names: string[] = [];
  const helpers = new Map<string, string[]>();
  for (const frame of frames) {
    const seriesNames: string[] = [];
    const helperNames: string[] = [];
    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      const name = getFieldDisplayName(field, frame, frames);
      (name.startsWith(LABEL_FIELD_PREFIX) ? helperNames : seriesNames).push(name);
    }
    for (const name of seriesNames) {
      if (!helpers.has(name)) {
        names.push(name);
        helpers.set(name, []);
      }
      helpers.get(name)!.push(...helperNames);
    }
  }
  return { names, helpers };
}

/**
 * The legend click behaviour of dashboard panels: a click isolates a series (a second click on the only
 * visible series shows all again), ctrl/cmd-click toggles one series, and a list sets the visible set.
 */
export function nextVisibleSeries(
  visible: VisibleSeries,
  label: string | string[] | null,
  mode: SeriesVisibilityChangeMode,
  allNames: string[]
): VisibleSeries {
  if (label === null) {
    return null;
  }
  if (Array.isArray(label)) {
    return label.length === allNames.length && allNames.every((n) => label.includes(n)) ? null : [...label];
  }
  if (mode === SeriesVisibilityChangeMode.AppendToSelection) {
    const current = visible ?? allNames;
    const next = current.includes(label) ? current.filter((n) => n !== label) : [...current, label];
    return allNames.every((n) => next.includes(n)) ? null : next;
  }
  if (mode === SeriesVisibilityChangeMode.SetExactly) {
    return [label];
  }
  return visible !== null && visible.length === 1 && visible[0] === label ? null : [label];
}

/**
 * Field overrides that hide every series outside `visible` from the chart and the tooltip but keep it
 * greyed out in the legend, as Grafana's own legend toggle does. Label helpers follow their series and
 * never show up in the legend.
 */
export function visibilityOverrides(visible: VisibleSeries, frames: DataFrame[]): ConfigOverrideRule[] {
  if (visible === null) {
    return [];
  }
  const { names, helpers } = chartSeries(frames);
  const shown = new Set(visible);
  const keep = [...visible, ...visible.flatMap((n) => helpers.get(n) ?? [])];
  const hiddenHelpers = names.filter((n) => !shown.has(n)).flatMap((n) => helpers.get(n) ?? []);
  const hide: SystemConfigOverrideRule = {
    __systemRef: 'hideSeriesFrom',
    matcher: {
      id: FieldMatcherID.byNames,
      options: { mode: ByNamesMatcherMode.exclude, names: keep, prefix: 'All except:', readOnly: true },
    },
    properties: [{ id: 'custom.hideFrom', value: { viz: true, legend: false, tooltip: true } }],
  };
  const rules: ConfigOverrideRule[] = [hide];
  if (hiddenHelpers.length > 0) {
    rules.push({
      matcher: {
        id: FieldMatcherID.byNames,
        options: { mode: ByNamesMatcherMode.include, names: hiddenHelpers, readOnly: true },
      },
      properties: [{ id: 'custom.hideFrom', value: { viz: true, legend: true, tooltip: true } }],
    });
  }
  return rules;
}
