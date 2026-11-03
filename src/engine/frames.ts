import { DataFrame, FieldType } from '@grafana/data';

import { Series } from '../model/types';
import { clean, labelKey } from './series';

/**
 * Bucket starts of a range query: the datasource aligns start and end down to the step (with a phase when it
 * aligns to the browser's UTC offset) and every value at `t` covers `(t − step, t]`, so the grid is the
 * queried timestamps moved one step back.
 */
export function buildGrid(fromMs: number, toMs: number, stepSec: number, frames: DataFrame[]): number[] {
  const step = stepSec * 1000;
  if (!(step > 0) || !(toMs >= fromMs)) {
    return [];
  }
  const sample = firstTimestamp(frames);
  const phase = sample === undefined ? 0 : ((sample % step) + step) % step;
  const start = Math.floor((fromMs - phase) / step) * step + phase - step;
  const end = Math.floor((toMs - phase) / step) * step + phase - step;
  const times: number[] = [];
  for (let t = start; t <= end; t += step) {
    times.push(t);
  }
  return times;
}

function firstTimestamp(frames: DataFrame[]): number | undefined {
  for (const frame of frames) {
    const time = frame.fields.find((f) => f.type === FieldType.time);
    const t = time?.values[0];
    if (typeof t === 'number') {
      return t;
    }
  }
  return undefined;
}

/**
 * One Series per label set of the frames' number fields: labels without `__name__`, values moved back by `shiftSec`
 * (the bucket-start convention) onto the grid; points off the grid are dropped, missing points are null. Fields with
 * the same labels, the slices of a range read in parts, fill one series.
 */
export function framesToSeries(frames: DataFrame[], refLetter: string, times: number[], shiftSec: number): Series[] {
  if (times.length === 0) {
    return [];
  }
  const start = times[0];
  const step = times.length > 1 ? times[1] - times[0] : 1;
  const out = new Map<string, Series>();
  for (const frame of frames) {
    const time = frame.fields.find((f) => f.type === FieldType.time);
    if (!time) {
      continue;
    }
    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      const all = field.labels ?? {};
      const key = labelKey(all, Object.keys(all).sort());
      let series = out.get(key);
      if (!series) {
        const { __name__, ...labels } = all;
        series = { refLetter, labels, times, values: times.map(() => null), name: '' };
        out.set(key, series);
      }
      for (let i = 0; i < field.values.length; i++) {
        const t = Number(time.values[i]) - shiftSec * 1000;
        const k = Math.round((t - start) / step);
        if (k >= 0 && k < times.length) {
          series.values[k] = clean(field.values[i]);
        }
      }
    }
  }
  return [...out.values()];
}
