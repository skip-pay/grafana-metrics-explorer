import { newId } from '../model/defaults';
import { FunctionCall } from '../model/types';
import { FunctionDef, FunctionParam } from './types';

type Args = Array<number | string>;

const ROLLUP_AGGS = ['avg', 'count', 'max', 'min', 'sum'];
const TOP_LIMITS = [5, 10, 25, 50, 100];
const FILL_METHODS = ['null', 'zero', 'linear', 'last'];
const RANK_BY = ['mean', 'max', 'min', 'sum', 'last', 'l2norm', 'area'];

const num = (name: string, def: number): FunctionParam => ({ name, kind: 'number', default: def });
const choice = (name: string, options: Array<string | number>, def: string | number): FunctionParam => ({
  name,
  kind: 'enum',
  options,
  default: def,
});

/** PromQL numbers are plain decimals or exponents, which `String()` produces for finite values. */
function promNumber(value: number | string): string {
  return String(Number(value));
}

/** Parenthesises an expression whose top level is a binary operation, so it can be an operand. */
export function operand(expr: string): string {
  return isBinary(expr) ? `(${expr})` : expr;
}

function isBinary(expr: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (quoted) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === '(' || c === '{' || c === '[') {
      depth++;
    } else if (c === ')' || c === '}' || c === ']') {
      depth--;
    } else if (depth === 0 && c === ' ' && /^ (?:[-+*/%^]|[<>]=?|[!=]=|and|or|unless) /.test(expr.slice(i))) {
      return true;
    }
  }
  return false;
}

function modifier(
  name: string,
  category: string,
  label: string,
  description: string,
  params: FunctionParam[] = []
): FunctionDef {
  return { name, category, label, description, params, stage: 'modifier' };
}

/** A post function; `promql` makes it usable server side, and every post function has a client implementation. */
function post(
  name: string,
  category: string,
  label: string,
  description: string,
  params: FunctionParam[] = [],
  promql?: FunctionDef['promql']
): FunctionDef {
  return { name, category, label, description, params, stage: 'post', promql, client: name };
}

const wrap = (fn: string) => (inner: string) => `${fn}(${inner})`;

const smoothing = (prefix: string, label: string, spans: number[], describe: (n: number) => string) =>
  spans.map((n) => post(`${prefix}_${n}`, 'Smoothing', `${label} ${n}`, describe(n)));

/** Category order of the function menu. */
export const CATEGORY_ORDER: string[] = [
  'Arithmetic',
  'Boolean remapping',
  'Interpolation',
  'Timeshift',
  'Rate',
  'Smoothing',
  'Rollup',
  'Rank',
  'Count',
  'Regression',
  'Exclusion',
];

/** Functions offered before the full list. */
export const QUICK_PICKS: string[] = ['rollup', 'top', 'timeshift', 'per_second', 'abs'];

/** Remaps to 1 or 0; null stays null. */
const remap = (op: string) => (inner: string, args: Args) => `${operand(inner)} ${op} bool ${promNumber(args[0])}`;

/** Registry in menu order: by CATEGORY_ORDER, the formula-only functions last. */
export const FUNCTIONS: FunctionDef[] = [
  // Arithmetic
  post('abs', 'Arithmetic', 'Absolute value', 'The absolute value of each point.', [], wrap('abs')),
  post('log2', 'Arithmetic', 'Log2', 'The base-2 logarithm of each point.', [], wrap('log2')),
  post('log10', 'Arithmetic', 'Log10', 'The base-10 logarithm of each point.', [], wrap('log10')),
  post('cumsum', 'Arithmetic', 'Cumulative sum', 'The running sum over the visible time range.'),
  post('integral', 'Arithmetic', 'Integral', 'The running sum of value × seconds over the visible time range.'),
  post('ceil', 'Arithmetic', 'Ceil', 'Rounds each point up to an integer.', [], wrap('ceil')),
  post('floor', 'Arithmetic', 'Floor', 'Rounds each point down to an integer.', [], wrap('floor')),
  post(
    'round',
    'Arithmetic',
    'Round',
    'Rounds each point to the given number of decimals.',
    [num('decimals', 0)],
    (inner, args) => `round(${inner}, ${promNumber(10 ** -Number(args[0]))})`
  ),

  // Boolean remapping
  post(
    'is_greater',
    'Boolean remapping',
    'Greater than',
    '1 where the value is greater than the threshold, else 0.',
    [num('threshold', 0)],
    remap('>')
  ),
  post(
    'is_less',
    'Boolean remapping',
    'Less than',
    '1 where the value is less than the threshold, else 0.',
    [num('threshold', 0)],
    remap('<')
  ),
  post(
    'is_between',
    'Boolean remapping',
    'Between',
    '1 where the value is between the lower and upper threshold (inclusive), else 0.',
    [num('lower', 0), num('upper', 1)],
    (inner, args) =>
      `(${operand(inner)} >= bool ${promNumber(args[0])}) * (${operand(inner)} <= bool ${promNumber(args[1])})`
  ),

  // Interpolation
  modifier(
    'fill',
    'Interpolation',
    'Fill',
    'Fills gaps up to the limit (seconds) with null, zero, a line or the last value.',
    [choice('method', FILL_METHODS, 'null'), num('limit', 300)]
  ),
  post(
    'default_zero',
    'Interpolation',
    'Default zero',
    'Replaces missing points with 0, and no data with a zero series.'
  ),

  // Timeshift
  modifier(
    'timeshift',
    'Timeshift',
    'Timeshift',
    'Shows the query shifted by the given seconds (negative = earlier).',
    [num('seconds', -3600)]
  ),
  modifier('hour_before', 'Timeshift', 'Hour before', 'Shows the query one hour earlier.'),
  modifier('day_before', 'Timeshift', 'Day before', 'Shows the query one day earlier.'),
  modifier('week_before', 'Timeshift', 'Week before', 'Shows the query one week earlier.'),
  modifier('month_before', 'Timeshift', 'Month before', 'Shows the query 28 days earlier.'),

  // Rate
  post('per_second', 'Rate', 'Per second', 'The increase between consecutive points per second; a drop counts as 0.'),
  post('per_minute', 'Rate', 'Per minute', 'The increase between consecutive points per minute; a drop counts as 0.'),
  post('per_hour', 'Rate', 'Per hour', 'The increase between consecutive points per hour; a drop counts as 0.'),
  post('diff', 'Rate', 'Difference', 'The difference between consecutive points.'),
  post(
    'monotonic_diff',
    'Rate',
    'Monotonic difference',
    'The difference between consecutive points, negative ones dropped.'
  ),
  post(
    'derivative',
    'Rate',
    'Derivative',
    'The difference between consecutive points divided by the seconds between them.'
  ),
  post(
    'throughput',
    'Rate',
    'Throughput',
    'Each point divided by the interval in seconds.',
    [],
    (inner, _args, ctx) => `${operand(inner)} / ${ctx.stepSec}`
  ),

  // Smoothing
  ...smoothing(
    'ewma',
    'EWMA',
    [3, 5, 10, 20],
    (n) => `Exponentially weighted moving average with a span of ${n} points.`
  ),
  ...smoothing('median', 'Median', [3, 5, 7, 9], (n) => `Rolling median of the last ${n} points.`),
  ...smoothing('rollingavg', 'Rolling average', [5, 13, 21, 29], (n) => `Rolling mean of the last ${n} points.`),

  // Rollup
  modifier(
    'rollup',
    'Rollup',
    'Rollup',
    'Time aggregation of each source series and the interval in seconds (0 = automatic, never below the step).',
    [choice('agg', ROLLUP_AGGS, 'avg'), num('seconds', 0)]
  ),
  post('moving_rollup', 'Rollup', 'Moving rollup', 'Aggregates each point with the points of the preceding window.', [
    num('seconds', 300),
    choice('agg', ['avg', 'sum', 'min', 'max', 'median'], 'avg'),
  ]),

  // Rank
  post('top', 'Rank', 'Top', 'Keeps the N series ranked highest by the reducer over the time range.', [
    choice('n', TOP_LIMITS, 5),
    choice('by', RANK_BY, 'mean'),
    choice('dir', ['desc', 'asc'], 'desc'),
  ]),
  post('bottom', 'Rank', 'Bottom', 'Keeps the N series ranked lowest by the reducer over the time range.', [
    choice('n', TOP_LIMITS, 5),
    choice('by', RANK_BY, 'mean'),
    choice('dir', ['desc', 'asc'], 'desc'),
  ]),

  // Count
  modifier('as_count', 'Count', 'As count', 'Counters: the number of events per interval.'),
  modifier('as_rate', 'Count', 'As rate', 'Counters: events per second within each interval.'),
  post(
    'count_nonzero',
    'Count',
    'Count non-zero',
    'The number of series with a non-zero value at each point.',
    [],
    (inner) => `count(${operand(inner)} != 0)`
  ),
  post(
    'count_not_null',
    'Count',
    'Count not null',
    'The number of series with a value at each point.',
    [],
    (inner) => `count(${inner})`
  ),

  // Regression
  post('trend_line', 'Regression', 'Trend line', 'The least-squares line over the time range.'),

  // Exclusion
  post('exclude_null', 'Exclusion', 'Exclude N/A', 'Removes series that lack one of the group-by tags.'),
  post(
    'cutoff_max',
    'Exclusion',
    'Cutoff max',
    'Removes points above the threshold.',
    [num('threshold', 0)],
    (inner, args) => `${operand(inner)} <= ${promNumber(args[0])}`
  ),
  post(
    'cutoff_min',
    'Exclusion',
    'Cutoff min',
    'Removes points below the threshold.',
    [num('threshold', 0)],
    (inner, args) => `${operand(inner)} >= ${promNumber(args[0])}`
  ),
  post(
    'clamp_max',
    'Exclusion',
    'Clamp max',
    'Lowers points above the threshold to the threshold.',
    [num('threshold', 0)],
    (inner, args) => `clamp_max(${inner}, ${promNumber(args[0])})`
  ),
  post(
    'clamp_min',
    'Exclusion',
    'Clamp min',
    'Raises points below the threshold to the threshold.',
    [num('threshold', 0)],
    (inner, args) => `clamp_min(${inner}, ${promNumber(args[0])})`
  ),

  // Formula only
  ...(
    [
      ['minimum', 'Minimum', 'minimum(x, y): the smaller of the two at each point.'],
      ['maximum', 'Maximum', 'maximum(x, y): the larger of the two at each point.'],
      ['pow', 'Power', 'pow(x, y): x raised to the power y.'],
      ['time', 'Time', 'time(): the timestamp of each point in seconds.'],
    ] as const
  ).map(([name, label, description]) => ({ ...post(name, 'Formula', label, description), formulaOnly: true })),
];

const BY_NAME = new Map(FUNCTIONS.map((f) => [f.name, f]));

export function getFunction(name: string): FunctionDef | undefined {
  return BY_NAME.get(name);
}

/** A call of `name` with the registry's default arguments and a fresh id. */
export function newFunctionCall(name: string): FunctionCall {
  const def = BY_NAME.get(name);
  if (!def) {
    throw new Error(`Unknown function ${name}()`);
  }
  return { id: newId(), name, args: def.params.map((p) => p.default) };
}

const DOTTED = new Set(['as_count', 'as_rate', 'fill', 'rollup']);

/** Modifiers written after the query (`.as_count()`); every other function wraps it (`abs(…)`, `timeshift(…)`). */
export function isDottedModifier(name: string): boolean {
  return DOTTED.has(name);
}

const SHIFTS: Record<string, number> = {
  hour_before: 3600,
  day_before: 86400,
  week_before: 7 * 86400,
  month_before: 28 * 86400,
};

/** Seconds a timeshift-family call moves the query into the past, or undefined for other functions. */
export function timeshiftOffsetSec(call: FunctionCall): number | undefined {
  if (call.name === 'timeshift') {
    return -Number(normalizeArgs(BY_NAME.get('timeshift')!, call.args).args[0]);
  }
  return SHIFTS[call.name];
}

/**
 * Arguments completed with defaults and coerced to the parameter types. An invalid value is replaced by the
 * default and reported in `error`.
 */
export function normalizeArgs(def: FunctionDef, args: Args): { args: Args; error?: string } {
  let error: string | undefined;
  if (args.length > def.params.length) {
    error = `${def.name}() takes ${def.params.length} argument${def.params.length === 1 ? '' : 's'}`;
  }
  const out = def.params.map((p, i) => {
    if (i >= args.length) {
      return p.default;
    }
    const value = coerce(p, args[i]);
    if (value === undefined) {
      error ??= `${def.name}(): ${p.name} must be ${describeParam(p)}, not ${JSON.stringify(args[i])}`;
      return p.default;
    }
    return value;
  });
  return error ? { args: out, error } : { args: out };
}

function coerce(p: FunctionParam, raw: number | string): number | string | undefined {
  if (p.kind === 'enum') {
    return p.options?.find((o) => String(o) === String(raw));
  }
  if (p.kind === 'number') {
    const n = typeof raw === 'number' ? raw : raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  }
  return String(raw);
}

function describeParam(p: FunctionParam): string {
  return p.kind === 'enum' ? `one of ${p.options?.join(', ')}` : p.kind === 'number' ? 'a number' : 'a string';
}

/** Arguments shown after the query: dotted modifiers drop trailing defaults but keep their first argument. */
export function visibleArgs(call: FunctionCall): Args {
  const def = BY_NAME.get(call.name);
  if (!def || !isDottedModifier(call.name)) {
    return call.args;
  }
  const args = [...call.args];
  while (args.length > 1 && String(args[args.length - 1]) === String(def.params[args.length - 1]?.default)) {
    args.pop();
  }
  return args;
}

/** Pill text: `.as_count()`, `.rollup(avg, 60)`, `abs()`, `top(10, mean, desc)`. */
export function renderFunctionCall(call: FunctionCall): string {
  const args = visibleArgs(call).map(String).join(', ');
  return `${isDottedModifier(call.name) ? '.' : ''}${call.name}(${args})`;
}
