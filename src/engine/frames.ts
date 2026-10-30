import { DataFrame, FieldType } from '@grafana/data';

import { Series } from '../model/types';
import { clean } from './series';

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
 * One Series per number field of the frames: labels without `__name__`, values moved back by `shiftSec` (the
 * bucket-start convention) onto the grid; points off the grid are dropped, missing points are null.
 */
export function framesToSeries(frames: DataFrame[], refLetter: string, times: number[], shiftSec: number): Series[] {
  if (times.length === 0) {
    return [];
  }
  const start = times[0];
  const step = times.length > 1 ? times[1] - times[0] : 1;
  const out: Series[] = [];
  for (const frame of frames) {
    const time = frame.fields.find((f) => f.type === FieldType.time);
    if (!time) {
      continue;
    }
    for (const field of frame.fields) {
      if (field.type !== FieldType.number) {
        continue;
      }
      const values: Array<number | null> = times.map(() => null);
      for (let i = 0; i < field.values.length; i++) {
        const t = Number(time.values[i]) - shiftSec * 1000;
        const k = Math.round((t - start) / step);
        if (k >= 0 && k < times.length) {
          values[k] = clean(field.values[i]);
        }
      }
      const { __name__, ...labels } = field.labels ?? {};
      out.push({ refLetter, labels, times, values, name: '' });
    }
  }
  return out;
}
