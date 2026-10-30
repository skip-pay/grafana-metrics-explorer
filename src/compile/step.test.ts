import { MetricInfo, ResolvedMetric } from '../model/types';
import { cadenceSec, chooseStep } from './step';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('chooseStep', () => {
  it.each([
    // range, cadence, lines, bars
    [15 * MIN, 20, 20, 20],
    [HOUR, 20, 20, 60],
    [4 * HOUR, 20, 60, 300],
    [24 * HOUR, 20, 300, 1200],
    [15 * MIN, 30, 30, 30],
    [HOUR, 30, 30, 60],
    [15 * MIN, 60, 60, 60],
    [HOUR, 60, 60, 60],
    [4 * HOUR, 60, 60, 300],
    [24 * HOUR, 60, 300, 1200],
    [15 * MIN, 10, 10, 10],
    [HOUR, 15, 15, 60],
    [HOUR, 300, 300, 300],
    [24 * HOUR, 900, 900, 900],
    [4 * HOUR, 3600, 3600, 3600],
  ])('range %d ms, cadence %d s: lines %d s, bars %d s', (range, cadence, lines, bars) => {
    expect(chooseStep(range, 'timeseries', 'lines', [cadence])).toBe(lines);
    expect(chooseStep(range, 'timeseries', 'areas', [cadence])).toBe(lines);
    expect(chooseStep(range, 'timeseries', 'bars', [cadence])).toBe(bars);
  });

  it.each([
    [20, [20, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400]],
    [30, [30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400]],
    [15, [15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400]],
    [10, [10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 14400]],
    [120, [120, 600, 1200, 1800, 3600, 7200, 14400]],
    [900, [900, 1800, 3600, 7200, 14400]],
    [3600, [3600, 7200, 14400]],
  ])('only takes multiples of a %d s cadence from four times its range', (cadence, ladder) => {
    const steps = new Set<number>();
    for (let range = 4 * cadence * 1000; range <= 60 * 24 * HOUR; range *= 1.1) {
      steps.add(chooseStep(range, 'timeseries', 'lines', [cadence]));
      steps.add(chooseStep(range, 'timeseries', 'bars', [cadence]));
    }
    expect([...steps].sort((a, b) => a - b)).toEqual(ladder);
  });

  it('takes multiples of every cadence of the plan', () => {
    expect(chooseStep(15 * MIN, 'timeseries', 'lines', [20, 30])).toBe(60);
    expect(chooseStep(15 * MIN, 'timeseries', 'lines', [20, 20, 60])).toBe(60);
    expect(chooseStep(15 * MIN, 'timeseries', 'lines', [15, 20])).toBe(60);
    expect(chooseStep(HOUR, 'timeseries', 'lines', [20, 300])).toBe(300);
    expect(chooseStep(HOUR, 'timeseries', 'lines', [600, 900])).toBe(1800);
    expect(chooseStep(24 * HOUR, 'timeseries', 'lines', [20, 30])).toBe(300);
    expect(chooseStep(24 * HOUR, 'timeseries', 'bars', [20, 900])).toBe(900);
  });

  it('leaves out cadences over a quarter of the range: each bucket holds at most one of their samples', () => {
    expect(chooseStep(HOUR, 'timeseries', 'lines', [3600])).toBe(60);
    expect(chooseStep(HOUR, 'timeseries', 'bars', [1800])).toBe(60);
    expect(chooseStep(15 * MIN, 'timeseries', 'lines', [20, 300])).toBe(20);
    expect(chooseStep(15 * MIN, 'timeseries', 'lines', [600, 900])).toBe(60);
    expect(chooseStep(HOUR, 'timeseries', 'lines', [15, 1800])).toBe(15);
  });

  it('uses 60 s without a cadence', () => {
    expect(chooseStep(15 * MIN, 'timeseries', 'lines', [])).toBe(60);
  });

  it('uses the lines rule for every visualisation but timeseries bars', () => {
    for (const viz of ['toplist', 'queryvalue', 'table', 'heatmap'] as const) {
      expect(chooseStep(HOUR, viz, 'bars', [20])).toBe(20);
    }
  });

  it('needs fewer than 300 points for lines and at most 100 for bars', () => {
    expect(chooseStep(6000_000, 'timeseries', 'lines', [20])).toBe(60); // 300 points at 20 s, 30 s is off the cadence
    expect(chooseStep(5980_000, 'timeseries', 'lines', [20])).toBe(20); // 299 points
    expect(chooseStep(9000_000, 'timeseries', 'lines', [30])).toBe(60); // 300 points at 30 s
    expect(chooseStep(2000_000, 'timeseries', 'bars', [20])).toBe(20); // 100 points
    expect(chooseStep(2020_000, 'timeseries', 'bars', [20])).toBe(60); // 101 points
  });

  it('caps at the top of the ladder', () => {
    expect(chooseStep(60 * 24 * HOUR, 'timeseries', 'lines', [20])).toBe(14400);
    expect(chooseStep(60 * 24 * HOUR, 'timeseries', 'lines', [900])).toBe(14400);
  });
});

describe('cadenceSec', () => {
  it('reads the resolved cadence, 60 s before resolution', () => {
    const info: MetricInfo = { name: 'm', kind: 'gauge', streams: { base: 'm' } };
    const resolved: ResolvedMetric = {
      ...info,
      temporality: { delta: false, cumulative: false },
      labelKeys: [],
      hasInstanceId: false,
      nativeIntervalSec: 20,
    };
    expect(cadenceSec(resolved)).toBe(20);
    expect(cadenceSec(info)).toBe(60);
    expect(cadenceSec(undefined)).toBe(60);
  });
});
