import { cadenceFromCounts, cadenceQuery, peakQuery } from './cadence';

const SHORT = 600;
const LONG = 6 * 3600;

describe('cadenceQuery', () => {
  it('counts samples per producer of the stream and keeps the two densest series', () => {
    expect(cadenceQuery('http_server_requests_total', SHORT)).toBe(
      'topk(2, max without (start_time, exemplars, flag) ' +
        '(count_over_time({__name__="http_server_requests_total"}[600s])) > 1 ' +
        'or sum without (start_time, exemplars, flag) (count_over_time({__name__="http_server_requests_total"}[600s])))'
    );
  });
});

describe('peakQuery', () => {
  it('takes the most samples per producer in 2 min, every 10 s of the window', () => {
    expect(peakQuery('http_server_requests_total', SHORT)).toBe(
      'topk(2, max_over_time((max without (start_time, exemplars, flag) ' +
        '(count_over_time({__name__="http_server_requests_total"}[120s])) > 1 ' +
        'or sum without (start_time, exemplars, flag) (count_over_time({__name__="http_server_requests_total"}[120s])))' +
        '[600s:10s]))'
    );
  });
});

describe('cadenceFromCounts', () => {
  it.each([
    [[60, 60], [12, 12], 10],
    [[40, 40], [8, 8], 15],
    [[30, 30], [6, 6], 20],
    [[20, 20], [4, 4], 30],
    [[10, 10], [2, 2], 60],
    [[5, 5], [1, 1], 120],
  ])('reads %j samples in 10 min, %j in 2 min, as %i s', (counts, peaks, seconds) => {
    expect(cadenceFromCounts(counts, SHORT, peaks)).toBe(seconds);
  });

  it.each([
    [[72, 72], 300],
    [[36, 36], 600],
    [[24, 24], 900],
    [[12, 12], 1800],
    [[6, 6], 3600],
    [[360, 360], 60],
  ])('reads %j samples in 6 h as %i s', (counts, seconds) => {
    expect(cadenceFromCounts(counts, LONG)).toBe(seconds);
  });

  it('allows one sample more or less at the window edges', () => {
    expect(cadenceFromCounts([31, 29], SHORT, [7, 7])).toBe(20);
    expect(cadenceFromCounts([61, 61], SHORT, [13, 13])).toBe(10);
    expect(cadenceFromCounts([41, 40], SHORT, [9, 9])).toBe(15);
    expect(cadenceFromCounts([21, 21], SHORT, [5, 5])).toBe(30);
    expect(cadenceFromCounts([11, 11], SHORT)).toBe(60);
    expect(cadenceFromCounts([9, 9], SHORT)).toBe(60);
    expect(cadenceFromCounts([7, 7], LONG)).toBe(3600);
    expect(cadenceFromCounts([5, 5], LONG)).toBe(3600);
    expect(cadenceFromCounts([73, 71], LONG)).toBe(300);
  });

  it('uses the second-highest count, so one duplicated series cannot halve the interval', () => {
    expect(cadenceFromCounts([60, 30, 30, 2], SHORT, [12, 6, 6])).toBe(20);
    expect(cadenceFromCounts([30], SHORT, [6])).toBe(20);
  });

  it('reads a sparse sub-minute stream from the 2 min it was complete', () => {
    // A delta counter exporting every 20 s that sent 20 of its 30 exports, or whose producers restarted.
    expect(cadenceFromCounts([20, 19], SHORT, [6, 6])).toBe(20);
    expect(cadenceFromCounts([24, 22], SHORT, [7, 6])).toBe(20);
    expect(cadenceFromCounts([27, 27], SHORT, [8, 8])).toBe(15);
  });

  it('falls back to 60 s for a sub-minute stream the peaks do not pin down', () => {
    // Never complete for 2 min: 30 s would alias a 20 s stream.
    expect(cadenceFromCounts([20, 19], SHORT, [3, 3])).toBe(60);
    expect(cadenceFromCounts([20, 19], SHORT)).toBe(60);
    // More samples in 10 min than 30 s allows.
    expect(cadenceFromCounts([24, 24], SHORT, [5, 4])).toBe(60);
    // Between the 10 s and 15 s peaks, or faster than 10 s.
    expect(cadenceFromCounts([50, 50], SHORT, [10, 10])).toBe(60);
    expect(cadenceFromCounts([120, 120], SHORT, [24, 24])).toBe(60);
    // The 6 h probe has no peaks: a stream that was quiet for the last 10 min could be anything under a minute.
    expect(cadenceFromCounts([720, 716], LONG)).toBe(60);
    expect(cadenceFromCounts([1080, 1080], LONG)).toBe(60);
  });

  it('takes the largest interval from a minute up that sparse series allow', () => {
    // Recording-rule groups that exist only part of the time: at most one sample per 5 min.
    expect(cadenceFromCounts([64, 60], LONG)).toBe(300);
    expect(cadenceFromCounts([49, 40], LONG)).toBe(300);
    expect(cadenceFromCounts([7, 7], SHORT, [2, 2])).toBe(60);
    expect(cadenceFromCounts([4, 4], SHORT, [1, 1])).toBe(120);
  });

  it('cannot tell from fewer than four samples per series', () => {
    expect(cadenceFromCounts([], SHORT)).toBeUndefined();
    expect(cadenceFromCounts([3, 3], SHORT, [3, 3])).toBeUndefined();
    expect(cadenceFromCounts([30, 2], SHORT, [6, 2])).toBeUndefined();
    expect(cadenceFromCounts([2], LONG)).toBeUndefined();
  });
});
