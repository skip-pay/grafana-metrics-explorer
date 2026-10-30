import {
  CATEGORY_ORDER,
  FUNCTIONS,
  getFunction,
  newFunctionCall,
  normalizeArgs,
  operand,
  QUICK_PICKS,
  renderFunctionCall,
  timeshiftOffsetSec,
} from './functions';

const EXPECTED: Record<string, string[]> = {
  Arithmetic: ['abs', 'log2', 'log10', 'cumsum', 'integral', 'ceil', 'floor', 'round'],
  'Boolean remapping': ['is_greater', 'is_less', 'is_between'],
  Interpolation: ['fill', 'default_zero'],
  Timeshift: ['timeshift', 'hour_before', 'day_before', 'week_before', 'month_before'],
  Rate: ['per_second', 'per_minute', 'per_hour', 'diff', 'monotonic_diff', 'derivative', 'throughput'],
  Smoothing: [
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
  ],
  Rollup: ['rollup', 'moving_rollup'],
  Rank: ['top', 'bottom'],
  Count: ['as_count', 'as_rate', 'count_nonzero', 'count_not_null'],
  Regression: ['trend_line'],
  Exclusion: ['exclude_null', 'cutoff_max', 'cutoff_min', 'clamp_max', 'clamp_min'],
  Formula: ['minimum', 'maximum', 'pow', 'time'],
};
const MODIFIERS = [
  'rollup',
  'as_count',
  'as_rate',
  'fill',
  'timeshift',
  'hour_before',
  'day_before',
  'week_before',
  'month_before',
];
const SERVER = [
  'count_nonzero',
  'count_not_null',
  'abs',
  'ceil',
  'floor',
  'round',
  'log2',
  'log10',
  'clamp_min',
  'clamp_max',
  'cutoff_min',
  'cutoff_max',
  'throughput',
  'is_greater',
  'is_less',
  'is_between',
];

describe('FUNCTIONS', () => {
  it('holds every function by category, once', () => {
    const byCategory: Record<string, string[]> = {};
    for (const f of FUNCTIONS) {
      (byCategory[f.category] ??= []).push(f.name);
    }
    expect(byCategory).toEqual(EXPECTED);
    expect(new Set(FUNCTIONS.map((f) => f.name)).size).toBe(FUNCTIONS.length);
  });

  it('lists the categories in menu order, then the formula-only functions', () => {
    const categories = [...new Set(FUNCTIONS.map((f) => f.category))];
    expect(categories).toEqual([...CATEGORY_ORDER, 'Formula']);
  });

  it('quick picks are known functions', () => {
    expect(QUICK_PICKS).toEqual(['rollup', 'top', 'timeshift', 'per_second', 'abs']);
    for (const name of QUICK_PICKS) {
      expect(getFunction(name)).toBeDefined();
    }
  });

  it('describes each function in one line', () => {
    for (const f of FUNCTIONS) {
      expect(f.label).not.toBe('');
      expect(f.description).toMatch(/^[^\n]{10,120}$/);
    }
  });

  it('marks modifiers, and gives every post function a client key equal to its name', () => {
    for (const f of FUNCTIONS) {
      if (MODIFIERS.includes(f.name)) {
        expect(f.stage).toBe('modifier');
        expect(f.client).toBeUndefined();
        expect(f.promql).toBeUndefined();
      } else {
        expect(f.stage).toBe('post');
        expect(f.client).toBe(f.name);
      }
      expect(Boolean(f.promql)).toBe(SERVER.includes(f.name));
      expect(Boolean(f.formulaOnly)).toBe(f.category === 'Formula');
    }
  });

  it('declares parameters with defaults among their options', () => {
    const params = Object.fromEntries(FUNCTIONS.map((f) => [f.name, f.params.map((p) => [p.name, p.default])]));
    expect(params.rollup).toEqual([
      ['agg', 'avg'],
      ['seconds', 0],
    ]);
    expect(getFunction('rollup')!.params[0].options).toEqual(['avg', 'count', 'max', 'min', 'sum']);
    expect(params.fill).toEqual([
      ['method', 'null'],
      ['limit', 300],
    ]);
    expect(params.top).toEqual([
      ['n', 5],
      ['by', 'mean'],
      ['dir', 'desc'],
    ]);
    expect(params.round).toEqual([['decimals', 0]]);
    expect(params.is_between).toEqual([
      ['lower', 0],
      ['upper', 1],
    ]);
    expect(params.timeshift).toEqual([['seconds', -3600]]);
    expect(params.moving_rollup).toEqual([
      ['seconds', 300],
      ['agg', 'avg'],
    ]);
    for (const f of FUNCTIONS) {
      for (const p of f.params.filter((p) => p.kind === 'enum')) {
        expect(p.options).toContain(p.default);
      }
    }
  });
});

describe('PromQL wrappers', () => {
  const ctx = { stepSec: 60 };
  const wrap = (name: string, args: Array<number | string> = newFunctionCall(name).args, inner = 'sum(x)') =>
    getFunction(name)!.promql!(inner, args, ctx);

  it('wraps the inner expression', () => {
    expect(wrap('abs')).toBe('abs(sum(x))');
    expect(wrap('ceil')).toBe('ceil(sum(x))');
    expect(wrap('floor')).toBe('floor(sum(x))');
    expect(wrap('log2')).toBe('log2(sum(x))');
    expect(wrap('log10')).toBe('log10(sum(x))');
    expect(wrap('round')).toBe('round(sum(x), 1)');
    expect(wrap('round', [2])).toBe('round(sum(x), 0.01)');
    expect(wrap('clamp_min', [5])).toBe('clamp_min(sum(x), 5)');
    expect(wrap('clamp_max', [-1.5])).toBe('clamp_max(sum(x), -1.5)');
    expect(wrap('cutoff_min', [10])).toBe('sum(x) >= 10');
    expect(wrap('cutoff_max', [10])).toBe('sum(x) <= 10');
    expect(wrap('count_nonzero')).toBe('count(sum(x) != 0)');
    expect(wrap('count_not_null')).toBe('count(sum(x))');
    expect(wrap('throughput')).toBe('sum(x) / 60');
    expect(wrap('is_greater', [30])).toBe('sum(x) > bool 30');
    expect(wrap('is_less', [-1])).toBe('sum(x) < bool -1');
    expect(wrap('is_between', [10, 30])).toBe('(sum(x) >= bool 10) * (sum(x) <= bool 30)');
  });

  it('parenthesises binary operands', () => {
    expect(wrap('cutoff_min', [1], 'a / (b > 0)')).toBe('(a / (b > 0)) >= 1');
    expect(wrap('throughput', [], 'sum(x) * 60')).toBe('(sum(x) * 60) / 60');
    expect(wrap('count_nonzero', [], 'x >= 1')).toBe('count((x >= 1) != 0)');
    expect(wrap('is_greater', [0], 'a / b')).toBe('(a / b) > bool 0');
    expect(operand('sum by (a) (m{p="a / b"}[60s] offset 60s)')).toBe('sum by (a) (m{p="a / b"}[60s] offset 60s)');
  });
});

describe('calls', () => {
  it('creates calls with default arguments and fresh ids', () => {
    const a = newFunctionCall('top');
    const b = newFunctionCall('top');
    expect(a).toEqual({ id: expect.any(String), name: 'top', args: [5, 'mean', 'desc'] });
    expect(a.id).not.toBe(b.id);
    expect(() => newFunctionCall('nope')).toThrow('Unknown function nope()');
  });

  it('normalizes arguments', () => {
    const top = getFunction('top')!;
    expect(normalizeArgs(top, [])).toEqual({ args: [5, 'mean', 'desc'] });
    expect(normalizeArgs(top, ['25', 'max'])).toEqual({ args: [25, 'max', 'desc'] });
    expect(normalizeArgs(top, [7])).toEqual({
      args: [5, 'mean', 'desc'],
      error: expect.stringContaining('n must be one of'),
    });
    expect(normalizeArgs(getFunction('round')!, ['x'])).toEqual({
      args: [0],
      error: expect.stringContaining('a number'),
    });
    expect(normalizeArgs(getFunction('abs')!, [1])).toEqual({ args: [], error: 'abs() takes 0 arguments' });
  });

  it('renders pills', () => {
    const call = (name: string, args: Array<number | string>) => ({ id: 'x', name, args });
    expect(renderFunctionCall(call('as_count', []))).toBe('.as_count()');
    expect(renderFunctionCall(call('rollup', ['avg', 60]))).toBe('.rollup(avg, 60)');
    expect(renderFunctionCall(call('rollup', ['max', 0]))).toBe('.rollup(max)');
    expect(renderFunctionCall(call('rollup', ['sum', 45]))).toBe('.rollup(sum, 45)');
    expect(renderFunctionCall(call('fill', ['zero', 300]))).toBe('.fill(zero)');
    expect(renderFunctionCall(call('fill', ['null', 600]))).toBe('.fill(null, 600)');
    expect(renderFunctionCall(call('abs', []))).toBe('abs()');
    expect(renderFunctionCall(call('top', [10, 'mean', 'desc']))).toBe('top(10, mean, desc)');
    expect(renderFunctionCall(call('timeshift', [-3600]))).toBe('timeshift(-3600)');
    expect(renderFunctionCall(call('day_before', []))).toBe('day_before()');
  });

  it('turns timeshifts into offsets into the past', () => {
    const call = (name: string, args: Array<number | string> = []) => ({ id: 'x', name, args });
    expect(timeshiftOffsetSec(call('timeshift', [-7200]))).toBe(7200);
    expect(timeshiftOffsetSec(call('timeshift', [600]))).toBe(-600);
    expect(timeshiftOffsetSec(call('timeshift'))).toBe(3600);
    expect(timeshiftOffsetSec(call('hour_before'))).toBe(3600);
    expect(timeshiftOffsetSec(call('day_before'))).toBe(86400);
    expect(timeshiftOffsetSec(call('week_before'))).toBe(604800);
    expect(timeshiftOffsetSec(call('month_before'))).toBe(2419200);
    expect(timeshiftOffsetSec(call('abs'))).toBeUndefined();
  });
});
