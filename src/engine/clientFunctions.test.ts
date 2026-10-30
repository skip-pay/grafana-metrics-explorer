import { ClientContext, CLIENT_FUNCTIONS, keysAfter } from './clientFunctions';
import { series, STEP, T0 } from './testFixtures';

const times = (n: number) => Array.from({ length: n }, (_, i) => T0 + i * STEP * 1000);
const ctx = (n = 5, keys: string[] = []): ClientContext => ({ stepSec: STEP, times: times(n), keys, refLetter: 'a' });

function run(name: string, values: Array<number | null>, args: Array<number | string> = [], keys: string[] = []) {
  return CLIENT_FUNCTIONS[name]([series(values)], args, ctx(values.length, keys))[0].values;
}

const EXPECTED = [
  'abs',
  'ceil',
  'floor',
  'round',
  'log2',
  'log10',
  'cumsum',
  'integral',
  'clamp_min',
  'clamp_max',
  'cutoff_min',
  'cutoff_max',
  'is_greater',
  'is_less',
  'is_between',
  'exclude_null',
  'count_nonzero',
  'count_not_null',
  'fill',
  'default_zero',
  'top',
  'bottom',
  'per_second',
  'per_minute',
  'per_hour',
  'diff',
  'monotonic_diff',
  'derivative',
  'throughput',
  'moving_rollup',
  'trend_line',
  'ewma_3',
  'ewma_5',
  'ewma_10',
  'ewma_20',
  'median_3',
  'median_5',
  'median_7',
  'median_9',
  'rollingavg_5',
  'rollingavg_13',
  'rollingavg_21',
  'rollingavg_29',
];

describe('registry', () => {
  it('implements every client function by name', () => {
    expect(Object.keys(CLIENT_FUNCTIONS).sort()).toEqual([...EXPECTED].sort());
  });

  it.each(EXPECTED)('%s returns no series for no input (except default_zero)', (name) => {
    const out = CLIENT_FUNCTIONS[name]([], [], ctx(3));
    expect(out).toHaveLength(name === 'default_zero' ? 1 : 0);
  });

  it.each(EXPECTED.filter((n) => n !== 'default_zero' && n !== 'trend_line'))(
    '%s keeps an all-null series null',
    (name) => {
      const out = CLIENT_FUNCTIONS[name]([series([null, null, null])], [], ctx(3));
      if (name.startsWith('count_')) {
        expect(out[0].values).toEqual([0, 0, 0]);
      } else if (name !== 'exclude_null') {
        expect(out[0].values).toEqual([null, null, null]);
      }
    }
  );

  it.each(EXPECTED)('%s does not mutate its input', (name) => {
    const input = series([3, null, -1, 4]);
    const copy = JSON.parse(JSON.stringify(input));
    CLIENT_FUNCTIONS[name]([input], [], ctx(4));
    expect(input).toEqual(copy);
  });

  it('collapses groups only for the count functions', () => {
    expect(keysAfter('count_nonzero', ['host'])).toEqual([]);
    expect(keysAfter('count_not_null', ['host'])).toEqual([]);
    expect(keysAfter('abs', ['host'])).toEqual(['host']);
  });
});

describe('arithmetic', () => {
  it('abs, ceil, floor', () => {
    expect(run('abs', [-1.5, null, 2])).toEqual([1.5, null, 2]);
    expect(run('ceil', [-1.5, null, 2.1])).toEqual([-1, null, 3]);
    expect(run('floor', [-1.5, null, 2.9])).toEqual([-2, null, 2]);
  });

  it('round to decimals, ties up like PromQL', () => {
    expect(run('round', [1.25, 2.5, -2.5, null])).toEqual([1, 3, -2, null]);
    expect(run('round', [1.256, 3.14159], [2])).toEqual([1.26, 3.14]);
    expect(run('round', [1.234], ['1'])).toEqual([1.2]);
    expect(run('round', [1234], [-2])).toEqual([1200]);
  });

  it('log2 and log10 drop non-positive values', () => {
    expect(run('log2', [8, 0, -1, null])).toEqual([3, null, null, null]);
    expect(run('log10', [1000, 1])).toEqual([3, 0]);
  });

  it('cumsum keeps the running total over gaps', () => {
    expect(run('cumsum', [null, 1, 2, null, 3])).toEqual([null, 1, 3, 3, 6]);
    expect(run('cumsum', [5])).toEqual([5]);
  });

  it('integral sums value × step seconds', () => {
    expect(run('integral', [1, null, 2])).toEqual([60, 60, 180]);
  });
});

describe('exclusion', () => {
  it('clamps and cuts off', () => {
    expect(run('clamp_min', [-1, 5, null], [0])).toEqual([0, 5, null]);
    expect(run('clamp_max', [-1, 5, null], [2])).toEqual([-1, 2, null]);
    expect(run('cutoff_min', [1, 2, 3], [2])).toEqual([null, 2, 3]);
    expect(run('cutoff_max', [1, 2, 3], ['2'])).toEqual([1, 2, null]);
  });

  it('remaps to 1 or 0 against thresholds, nulls stay null', () => {
    expect(run('is_greater', [1, 2, 3, null], [2])).toEqual([0, 0, 1, null]);
    expect(run('is_less', [1, 2, 3, null], ['2'])).toEqual([1, 0, 0, null]);
    expect(run('is_between', [0, 1, 2, 3, null], [1, 2])).toEqual([0, 1, 1, 0, null]);
  });

  it('exclude_null drops series missing a group label', () => {
    const input = [series([1], { host: 'a' }), series([2], {}), series([3], { host: '' })];
    const out = CLIENT_FUNCTIONS.exclude_null(input, [], ctx(1, ['host']));
    expect(out.map((s) => s.labels)).toEqual([{ host: 'a' }, { host: '' }]);
  });
});

describe('count', () => {
  const input = [series([1, 0, null], { host: 'a' }), series([2, null, null], { host: 'b' })];

  it('count_nonzero counts non-null, non-zero series per point', () => {
    const out = CLIENT_FUNCTIONS.count_nonzero(input, [], ctx(3, ['host']));
    expect(out).toHaveLength(1);
    expect(out[0].labels).toEqual({});
    expect(out[0].values).toEqual([2, 0, 0]);
  });

  it('count_not_null counts non-null series per point', () => {
    expect(CLIENT_FUNCTIONS.count_not_null(input, [], ctx(3, ['host']))[0].values).toEqual([2, 1, 0]);
  });
});

describe('interpolation', () => {
  const gappy = [1, null, null, 4, null, null, null, null, null, null, 9, null];

  it('null is a no-op', () => {
    expect(run('fill', gappy, ['null'])).toEqual(gappy);
  });

  it('zero fills runs up to the limit, including the edges', () => {
    expect(run('fill', [null, 1, null, null, 2, null], ['zero', 120])).toEqual([0, 1, 0, 0, 2, 0]);
    expect(run('fill', gappy, ['zero', 120])).toEqual([1, 0, 0, 4, null, null, null, null, null, null, 9, 0]);
  });

  it('linear interpolates interior gaps only', () => {
    expect(run('fill', [null, 1, null, null, 4, null], ['linear', 300])).toEqual([null, 1, 2, 3, 4, null]);
  });

  it('last carries forward, also at the end', () => {
    expect(run('fill', [null, 1, null, 4, null], ['last', 300])).toEqual([null, 1, 1, 4, 4]);
  });

  it('the limit is never shorter than one step', () => {
    expect(run('fill', [1, null, 3], ['linear', 10])).toEqual([1, 2, 3]);
    expect(run('fill', [1, null, null, 4], ['linear', 10])).toEqual([1, null, null, 4]);
  });

  it('a single point and empty series are fine', () => {
    expect(run('fill', [7], ['linear', 300])).toEqual([7]);
    expect(run('fill', [], ['zero', 300])).toEqual([]);
  });

  it('default_zero fills every null', () => {
    expect(run('default_zero', [null, 1, null])).toEqual([0, 1, 0]);
  });

  it('default_zero emits a zero series for an empty ungrouped query only', () => {
    const ungrouped = CLIENT_FUNCTIONS.default_zero([], [], ctx(3));
    expect(ungrouped).toHaveLength(1);
    expect(ungrouped[0]).toMatchObject({ refLetter: 'a', labels: {}, values: [0, 0, 0] });
    expect(ungrouped[0].times).toEqual(times(3));
    expect(CLIENT_FUNCTIONS.default_zero([], [], ctx(3, ['host']))).toEqual([]);
  });
});

describe('rank', () => {
  const input = [
    series([1, 1, 1], { host: 'low' }),
    series([5, 5, null], { host: 'high' }),
    series([0, 10, 0], { host: 'spiky' }),
    series([null, null, null], { host: 'empty' }),
    series([-3, 9, 3], { host: 'last' }),
  ];
  const hosts = (out: typeof input) => out.map((s) => s.labels.host);
  const top = (args: Array<number | string>) => hosts(CLIENT_FUNCTIONS.top(input, args, ctx(3)));
  const bottom = (args: Array<number | string>) => hosts(CLIENT_FUNCTIONS.bottom(input, args, ctx(3)));

  it('top ranks by mean over non-null points by default', () => {
    expect(top([2])).toEqual(['high', 'spiky']);
    expect(top([])).toEqual(['high', 'spiky', 'last', 'low', 'empty']);
  });

  it('top by every reducer', () => {
    expect(top([1, 'max'])).toEqual(['spiky']);
    expect(top([1, 'min'])).toEqual(['high']);
    expect(top([1, 'sum'])).toEqual(['high']);
    expect(top([1, 'last'])).toEqual(['high']);
    expect(top([1, 'l2norm'])).toEqual(['spiky']);
    expect(top([1, 'area'])).toEqual(['high']);
  });

  it('asc keeps the lowest, series without data rank last either way', () => {
    expect(top([2, 'mean', 'asc'])).toEqual(['low', 'last']);
    expect(top([10, 'mean', 'asc']).pop()).toBe('empty');
  });

  it('bottom is top in the other direction', () => {
    expect(bottom([2, 'mean', 'desc'])).toEqual(['low', 'last']);
    expect(bottom([1, 'max'])).toEqual(['low']);
    expect(bottom([1, 'mean', 'asc'])).toEqual(['high']);
  });

  it('accepts numeric strings', () => {
    expect(top(['1', 'mean', 'desc'])).toEqual(['high']);
  });
});

describe('rate', () => {
  it('per_second, per_minute, per_hour divide by Δt in seconds between non-null points', () => {
    expect(run('per_second', [0, 60, null, 180])).toEqual([null, 1, null, 1]);
    expect(run('per_minute', [0, 60, null, 180])).toEqual([null, 60, null, 60]);
    expect(run('per_hour', [0, 60])).toEqual([null, 3600]);
  });

  it('per_* count a drop as 0, derivative keeps the sign', () => {
    expect(run('per_second', [120, 60, 120])).toEqual([null, 0, 1]);
    expect(run('derivative', [120, 60, 120])).toEqual([null, -1, 1]);
    expect(run('derivative', [0, -120])).toEqual([null, -2]);
  });

  it('diff and monotonic_diff use consecutive non-null points', () => {
    expect(run('diff', [5, null, 2, 4])).toEqual([null, null, -3, 2]);
    expect(run('monotonic_diff', [5, null, 2, 4])).toEqual([null, null, 0, 2]);
  });

  it('a single point has no rate', () => {
    expect(run('per_second', [5])).toEqual([null]);
    expect(run('diff', [5])).toEqual([null]);
  });

  it('throughput divides by the step', () => {
    expect(run('throughput', [120, null])).toEqual([2, null]);
  });
});

describe('smoothing', () => {
  it('ewma seeds with the first value, α = 2/(N+1), skips nulls', () => {
    const alpha = 2 / 4;
    expect(run('ewma_3', [2, null, 4, 8])).toEqual([2, null, 2 + alpha * 2, 3 * (1 - alpha) + alpha * 8]);
    expect(run('ewma_10', [5])).toEqual([5]);
  });

  it('median over the last N non-null points', () => {
    expect(run('median_3', [1, 9, null, 2, 3])).toEqual([1, 5, null, 2, 3]);
  });

  it('rolling average over the last N non-null points', () => {
    expect(run('rollingavg_5', [1, 2, 3, 4, 5, 6, null])).toEqual([1, 1.5, 2, 2.5, 3, 4, null]);
  });

  it('moving_rollup aggregates the trailing window in seconds at non-null points', () => {
    const values = [1, 3, null, 5, 7];
    expect(run('moving_rollup', values, [120, 'avg'])).toEqual([1, 2, null, 5, 6]);
    expect(run('moving_rollup', values, [180, 'sum'])).toEqual([1, 4, null, 8, 12]);
    expect(run('moving_rollup', values, [180, 'max'])).toEqual([1, 3, null, 5, 7]);
    expect(run('moving_rollup', values, [180, 'min'])).toEqual([1, 1, null, 3, 5]);
    expect(run('moving_rollup', values, [180, 'count'])).toEqual([1, 2, null, 2, 2]);
    expect(run('moving_rollup', values, [180, 'median'])).toEqual([1, 2, null, 4, 6]);
    expect(run('moving_rollup', values, [180, 'last'])).toEqual([1, 3, null, 5, 7]);
  });
});

describe('trend_line', () => {
  it('replaces the values with the least-squares line over the whole grid', () => {
    const out = run('trend_line', [1, null, 3, 4]);
    [1, 2, 3, 4].forEach((v, i) => expect(out[i]).toBeCloseTo(v, 10));
  });

  it('a single point gives a flat line, no points give nulls', () => {
    expect(run('trend_line', [null, 5, null])).toEqual([5, 5, 5]);
    expect(run('trend_line', [null, null])).toEqual([null, null]);
  });
});
