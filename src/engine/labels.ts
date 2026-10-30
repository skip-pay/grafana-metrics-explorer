import { Field, FieldColorModeId, FieldType, MappingType } from '@grafana/data';
import { DrawStyle, PointVisibility, StackingMode } from '@grafana/ui';

import { isValue, Values } from './series';

/** Charts with more series than this get no value labels. */
export const MAX_LABELLED_SERIES = 6;

export const LABEL_PREFIX = '__mx_label_';

export function labelFieldName(i: number): string {
  return `${LABEL_PREFIX}${i}`;
}

/** Index of the global maximum and, unless equal to it or next to it, of the global minimum. */
export function extremeIndices(values: Values): number[] {
  let maxIdx = -1;
  let minIdx = -1;
  values.forEach((v, i) => {
    if (!isValue(v)) {
      return;
    }
    if (maxIdx < 0 || v > values[maxIdx]!) {
      maxIdx = i;
    }
    if (minIdx < 0 || v < values[minIdx]!) {
      minIdx = i;
    }
  });
  if (maxIdx < 0) {
    return [];
  }
  if (values[minIdx] === values[maxIdx] || Math.abs(minIdx - maxIdx) <= 1) {
    return [maxIdx];
  }
  return [maxIdx, minIdx];
}

export function lastIndex(values: Values): number[] {
  for (let i = values.length - 1; i >= 0; i--) {
    if (isValue(values[i])) {
      return [i];
    }
  }
  return [];
}

/**
 * Helper field that draws value labels: null except at the chosen points, shown as points with values and
 * hidden from legend and tooltip. With `text`, the label shows that text instead of the value.
 */
export function labelField(
  i: number,
  values: Values,
  indices: number[],
  color: string,
  opts: { unit?: string; axisLabel?: string; text?: string }
): Field {
  const labelValues = values.map((v, k) => (indices.includes(k) ? v : null));
  const text = opts.text;
  const mappings =
    text !== undefined
      ? [
          {
            type: MappingType.ValueToText as const,
            options: Object.fromEntries(indices.map((k) => [String(values[k]), { text }])),
          },
        ]
      : undefined;
  return {
    name: labelFieldName(i),
    type: FieldType.number,
    values: labelValues,
    config: {
      displayName: labelFieldName(i),
      color: { mode: FieldColorModeId.Fixed, fixedColor: color },
      ...(opts.unit ? { unit: opts.unit } : {}),
      ...(mappings ? { mappings } : {}),
      custom: {
        drawStyle: DrawStyle.Points,
        pointSize: 6,
        showValues: true,
        showPoints: PointVisibility.Always,
        hideFrom: { legend: true, tooltip: true, viz: false },
        stacking: { mode: StackingMode.None },
        // Grafana keys a y axis by unit and axis label, so the helper shares its series' axis only with both.
        ...(opts.axisLabel !== undefined ? { axisLabel: opts.axisLabel } : {}),
      },
    },
  };
}
