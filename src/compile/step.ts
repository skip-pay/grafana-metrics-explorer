import { DisplayType, MetricInfo, ResolvedMetric, Visualization } from '../model/types';

export const STEP_LADDER = [10, 15, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400];

/** The interval assumed for a metric that is not resolved yet, and for a plan without metrics. */
const DEFAULT_CADENCE_SEC = 60;

/** The export or scrape interval of a metric, 60 s until it is resolved. */
export function cadenceSec(info: MetricInfo | ResolvedMetric | undefined): number {
  return info && 'nativeIntervalSec' in info ? info.nativeIntervalSec : DEFAULT_CADENCE_SEC;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Step in seconds for the range, visualisation and display type: the smallest ladder value (or the cadences' least
 * common multiple) that is a multiple of every cadence and gives fewer than 300 points, or at most 100 points for
 * bars. A step off the cadence makes buckets alternate between holding one export and two. Cadences over a quarter
 * of the range are left out: a step that long leaves a bucket or two, the first one starting before the range, while
 * a shorter step holds at most one of their samples per bucket.
 */
export function chooseStep(rangeMs: number, viz: Visualization, display: DisplayType, cadencesSec: number[]): number {
  const rangeSec = Math.max(rangeMs, 0) / 1000;
  const bars = viz === 'timeseries' && display === 'bars';
  const fits = (step: number) => {
    const points = Math.ceil(rangeSec / step);
    return bars ? points <= 100 : points < 300;
  };
  const binding = cadencesSec.filter((sec) => sec <= rangeSec / 4);
  const lcm = binding.reduce((a, b) => (a * b) / gcd(a, b), binding[0] ?? DEFAULT_CADENCE_SEC);
  const steps = [lcm, ...STEP_LADDER.filter((s) => s > lcm && s % lcm === 0)];
  return steps.find(fits) ?? Math.ceil(STEP_LADDER[STEP_LADDER.length - 1] / lcm) * lcm;
}

/** A range longer than this is read one slice after another, so that no request reads more of a stream. */
export const MAX_SLICE_SEC = 24 * 3600;

/** Length of the slices a long range is read in: the longest multiple of the step within MAX_SLICE_SEC. */
export function sliceSec(stepSec: number): number {
  return Math.max(1, Math.floor(MAX_SLICE_SEC / stepSec)) * stepSec;
}
