/** Export or scrape intervals the detection snaps to, in seconds. */
export const CADENCES_SEC = [10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600];
/** Used when no interval can be detected; a multiple of every interval up to a minute. */
export const DEFAULT_CADENCE_SEC = 60;
/** CloudWatch metric streams deliver one value per minute, often minutes late, so they are not probed. */
export const CLOUDWATCH_CADENCE_SEC = 60;
/** Probe windows: the last 10 min, then the last 6 h for streams too slow or too sparse for the first. */
export const CADENCE_WINDOWS_SEC = [600, 6 * 3600];
/** Fewer samples per series than this say too little about the interval. */
const MIN_SAMPLES = 4;
/**
 * Sub-window of the peak probe. It holds 12, 8, 6 or 4 samples of a 10, 15, 20 or 30 s stream; with the one extra
 * sample a window edge can catch, no interval reaches the next one's count.
 */
const PEAK_WINDOW_SEC = 120;
/** Evaluation step of the peak probe: the shortest interval. */
const PEAK_STEP_SEC = 10;

/** OTel point labels: `start_time` changes with every point or every process start, the others describe one point. */
const POINT_LABELS = 'start_time, exemplars, flag';

/**
 * Samples per series of `stream` in the last `windowSec`. A series split by the point labels is merged back when its
 * parts hold one sample each; parts with more samples are separate producers and stay apart.
 */
function seriesCounts(stream: string, windowSec: number): string {
  const counts = `count_over_time({__name__="${stream}"}[${windowSec}s])`;
  return `max without (${POINT_LABELS}) (${counts}) > 1 or sum without (${POINT_LABELS}) (${counts})`;
}

/** Samples per series of `stream` in the window, for its two densest series. */
export function cadenceQuery(stream: string, windowSec: number): string {
  return `topk(2, ${seriesCounts(stream, windowSec)})`;
}

/** The most samples per series of `stream` in any 2 min of the window, for its two densest series. */
export function peakQuery(stream: string, windowSec: number): string {
  return `topk(2, max_over_time((${seriesCounts(stream, PEAK_WINDOW_SEC)})[${windowSec}s:${PEAK_STEP_SEC}s]))`;
}

/**
 * The interval from the sample counts of the densest series in a window, or undefined when they are too sparse to
 * tell. Delta counters only export when something was counted and recording rules only while their groups exist,
 * so most series are sparse and only the densest show the interval; the second-highest count is used so that one
 * duplicated series cannot halve it.
 */
export function cadenceFromCounts(counts: number[], windowSec: number, peaks: number[] = []): number | undefined {
  const samples = secondHighest(counts);
  if (samples === undefined || samples < MIN_SAMPLES) {
    return undefined;
  }
  // Missing samples only lower a count, and under a minute a step off the true interval aliases, so a sub-minute
  // interval comes from the peak probe: one series exported every time for 2 min, give or take one sample at the
  // edges. The whole window cannot hold more samples than that interval allows.
  const peak = secondHighest(peaks);
  const fast = CADENCES_SEC.find((sec) => {
    const expected = PEAK_WINDOW_SEC / sec;
    return sec < DEFAULT_CADENCE_SEC && (peak === expected || peak === expected + 1) && samples <= windowSec / sec + 1;
  });
  // The interval is at most window / (count - 1). The largest interval from a minute up that fits is taken; each is
  // a multiple of every interval under a minute.
  const slow = CADENCES_SEC.filter((sec) => sec >= DEFAULT_CADENCE_SEC && sec <= windowSec / (samples - 1)).pop();
  return fast ?? slow ?? DEFAULT_CADENCE_SEC;
}

function secondHighest(values: number[]): number | undefined {
  return [...values].sort((a, b) => b - a)[Math.min(1, values.length - 1)];
}
