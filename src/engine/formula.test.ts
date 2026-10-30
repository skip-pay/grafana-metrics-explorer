import { expandLetters, evaluateFormula, FormulaEnv, formulaError, parseFormula, tokenize } from './formula';
import { SeriesSet } from './series';
import { series, STEP, T0 } from './testFixtures';

const times = [T0, T0 + 60000, T0 + 120000];

function set(keys: string[], items: Array<[Record<string, string>, Array<number | null>]>, unit?: string): SeriesSet {
  return { keys, unit, series: items.map(([labels, values]) => series(values, labels, { times })) };
}

const rows: Record<string, SeriesSet> = {
  a: set([], [[{}, [10, 20, null]]], 'ms'),
  b: set([], [[{}, [2, 0, 4]]], 'ms'),
  c: set([], [[{}, [1, 1, 1]]], 'bytes'),
  h: set(
    ['host'],
    [
      [{ host: 'x' }, [1, 2, 3]],
      [{ host: 'y' }, [10, 20, 30]],
    ]
  ),
  g: set(
    ['host'],
    [
      [{ host: 'y' }, [1, 2, 3]],
      [{ host: 'z' }, [5, 5, 5]],
    ]
  ),
  e: set(
    ['env', 'host'],
    [
      [{ env: 'prod', host: 'x' }, [1, 1, 1]],
      [{ env: 'prod', host: 'y' }, [2, 2, 2]],
      [{ env: 'dev', host: 'x' }, [3, 3, 3]],
    ]
  ),
  p: set(
    ['path'],
    [
      [{ path: '/a' }, [1, 1, 1]],
      [{ path: '/b' }, [2, 2, 2]],
    ]
  ),
  s: set(['host'], [[{ host: 'x' }, [7, 7, 7]]]),
  n: set(
    ['host'],
    [
      [{ host: 'x' }, [1, 1, 1]],
      [{}, [2, 2, 2]],
      [{ host: '' }, [3, 3, 3]],
    ]
  ),
  z: set([], []),
};

const env = (maxSeries = 1000): FormulaEnv => ({ refLetter: 'f1', stepSec: STEP, times, rows, maxSeries });
const evaluate = (expression: string) => evaluateFormula(expression, env());
const values = (expression: string) => evaluate(expression).series.map((s) => s.values);
const byLabels = (expression: string) =>
  Object.fromEntries(evaluate(expression).series.map((s) => [JSON.stringify(s.labels), s.values]));
const error = (expression: string) => formulaError(expression, Object.keys(rows));

describe('tokenizer', () => {
  it('splits numbers, refs, operators, strings and calls', () => {
    expect(tokenize(`top(a, 1.5e2, 'mean', "desc") - .5`).map((t) => ('value' in t ? t.value : t.type))).toEqual([
      'top',
      '(',
      'a',
      ',',
      150,
      ',',
      'mean',
      ',',
      'desc',
      ')',
      '-',
      0.5,
    ]);
  });

  it('rejects unknown characters and unterminated strings', () => {
    expect(error('a % b')).toBe('Unexpected character `%` at position 3');
    expect(error("top(a, 10, 'mean)")).toBe('Unterminated string at position 12');
  });
});

describe('parser', () => {
  it('gives * and / precedence over + and -, left-associative', () => {
    expect(parseFormula('a + b * c')).toEqual({
      type: 'binary',
      op: '+',
      left: { type: 'ref', letter: 'a' },
      right: { type: 'binary', op: '*', left: { type: 'ref', letter: 'b' }, right: { type: 'ref', letter: 'c' } },
    });
    expect(parseFormula('a - b - c')).toMatchObject({ op: '-', left: { op: '-' }, right: { letter: 'c' } });
    expect(parseFormula('a / b / 2')).toMatchObject({ op: '/', left: { op: '/' }, right: { value: 2 } });
  });

  it('parentheses override precedence; unary minus binds tightest', () => {
    expect(parseFormula('(a + b) * c')).toMatchObject({ op: '*', left: { op: '+' } });
    expect(parseFormula('-a * b')).toMatchObject({ op: '*', left: { type: 'unary', op: '-' } });
    expect(parseFormula('- -1')).toMatchObject({ type: 'unary', arg: { type: 'unary', arg: { value: 1 } } });
  });

  it('parses calls with expression, number and string arguments', () => {
    expect(parseFormula(`top(a / b, 5, 'max', "asc")`)).toEqual({
      type: 'call',
      name: 'top',
      args: [
        { type: 'binary', op: '/', left: { type: 'ref', letter: 'a' }, right: { type: 'ref', letter: 'b' } },
        { type: 'number', value: 5 },
        { type: 'string', value: 'max' },
        { type: 'string', value: 'asc' },
      ],
    });
    expect(parseFormula('time()')).toEqual({ type: 'call', name: 'time', args: [] });
  });

  it('reports syntax errors', () => {
    expect(error('')).toBe('Formula is empty');
    expect(error('   ')).toBe('Formula is empty');
    expect(error('a +')).toBe('Unexpected end of formula');
    expect(error('(a + b')).toBe('Missing `)` before end of formula');
    expect(error('a b')).toBe('Unexpected `b` at position 3');
    expect(error('a + * b')).toBe('Unexpected `*` at position 5');
    expect(error('abs(a,)')).toBe('Unexpected `)` at position 7');
    expect(error(')')).toBe('Unexpected `)` at position 1');
  });
});

describe('validation', () => {
  it('accepts valid formulas', () => {
    expect(error('a / b * 100')).toBeNull();
    expect(error(`top(h, 10, 'mean', 'desc')`)).toBeNull();
    expect(error('clamp_min(a, -5)')).toBeNull();
    expect(error('round(a)')).toBeNull();
    expect(error('ewma_10(a) - median_5(b)')).toBeNull();
    expect(error('time() - a')).toBeNull();
    expect(error('pow(a, 2)')).toBeNull();
  });

  it('rejects unknown letters, formula refs and functions', () => {
    expect(error('a + q')).toBe('Unknown query `q`');
    expect(error('f1 * 2')).toBe('Unknown query `f1`');
    expect(error('foo(a)')).toBe('Unknown function `foo`');
    expect(error('fill(a)')).toBe('Unknown function `fill`');
    expect(error('ewma_4(a)')).toBe('Unknown function `ewma_4`');
  });

  it('checks argument counts and types', () => {
    expect(error('abs()')).toBe('`abs` takes 1 argument');
    expect(error('abs(a, b)')).toBe('`abs` takes 1 argument');
    expect(error('minimum(a)')).toBe('`minimum` takes 2 arguments');
    expect(error('time(a)')).toBe('`time` takes 0 arguments');
    expect(error('top(a, 1, 2, 3, 4)')).toBe('`top` takes 1 to 4 arguments');
    expect(error(`top(a, 'mean')`)).toBe('Argument 2 of `top` must be a number');
    expect(error('top(a, 10, mean)')).toBe('Argument 3 of `top` must be a quoted string');
    expect(error(`top(a, 10, 'median')`)).toBe("`top` accepts 'mean', 'max', 'min', 'sum', 'last', 'l2norm', 'area'");
    expect(error(`clamp_max(a, b)`)).toBe('Argument 2 of `clamp_max` must be a number');
    expect(error(`a + 'x'`)).toBe("Unexpected string 'x'");
  });
});

describe('evaluation', () => {
  it('scalars', () => {
    expect(values('1 + 2 * 3')).toEqual([[7, 7, 7]]);
    expect(values('(1 + 2) * 3')).toEqual([[9, 9, 9]]);
    expect(values('-2 - -3')).toEqual([[1, 1, 1]]);
    expect(values('1 / 0')).toEqual([[null, null, null]]);
  });

  it('pointwise arithmetic with precedence; null op x = null', () => {
    expect(values('a + b * 2')).toEqual([[14, 20, null]]);
    expect(values('(a + b) * 2')).toEqual([[24, 40, null]]);
    expect(values('-a')).toEqual([[-10, -20, null]]);
  });

  it('division by zero gives null', () => {
    expect(values('a / b')).toEqual([[5, null, null]]);
    expect(values('a / 0')).toEqual([[null, null, null]]);
  });

  it('broadcasts scalars and ungrouped series over groups', () => {
    expect(byLabels('h * 2')).toEqual({ '{"host":"x"}': [2, 4, 6], '{"host":"y"}': [20, 40, 60] });
    expect(byLabels('100 - h')).toEqual({ '{"host":"x"}': [99, 98, 97], '{"host":"y"}': [90, 80, 70] });
    expect(byLabels('h / c')).toEqual({ '{"host":"x"}': [1, 2, 3], '{"host":"y"}': [10, 20, 30] });
    expect(byLabels('c / h')).toEqual({ '{"host":"x"}': [1, 0.5, 1 / 3], '{"host":"y"}': [0.1, 0.05, 1 / 30] });
    expect(evaluate('h * 2').keys).toEqual(['host']);
  });

  it('pairs series with identical label sets and drops unmatched ones', () => {
    expect(byLabels('h + g')).toEqual({ '{"host":"y"}': [11, 22, 33] });
  });

  it('a single series of the same grouping is matched, not broadcast', () => {
    expect(byLabels('h + s')).toEqual({ '{"host":"x"}': [8, 9, 10] });
  });

  it('absent and explicitly empty labels are different groups', () => {
    expect(byLabels('n * n')).toEqual({ '{"host":"x"}': [1, 1, 1], '{}': [4, 4, 4], '{"host":""}': [9, 9, 9] });
  });

  it('pairs on the common keys when the groupings differ', () => {
    expect(byLabels('e - h')).toEqual({
      '{"host":"x","env":"prod"}': [0, -1, -2],
      '{"host":"y","env":"prod"}': [-8, -18, -28],
      '{"host":"x","env":"dev"}': [2, 1, 0],
    });
    expect(evaluate('e - h').keys).toEqual(['env', 'host']);
  });

  it('broadcasts a single series when the groupings differ', () => {
    expect(byLabels('p + s')).toEqual({ '{"host":"x","path":"/a"}': [8, 8, 8], '{"host":"x","path":"/b"}': [9, 9, 9] });
  });

  it('refuses groupings without a common tag', () => {
    expect(() => evaluate('h + p')).toThrow(
      'Cannot combine series by {host} with series by {path}: they share no tags'
    );
  });

  it('an empty operand gives an empty result', () => {
    expect(evaluate('z + h').series).toEqual([]);
    expect(evaluate('z * 2').series).toEqual([]);
  });

  it('refuses results above the series cap', () => {
    expect(() => evaluateFormula('e - h', { ...env(2) })).toThrow('Too many series (3)');
  });

  it('unknown letters fail at evaluation too', () => {
    expect(() => evaluate('a + q')).toThrow('Unknown query `q`');
  });

  it('client functions with literal and string arguments', () => {
    expect(byLabels(`top(h, 1, 'mean', 'desc')`)).toEqual({ '{"host":"y"}': [10, 20, 30] });
    expect(byLabels(`bottom(h, 1, "max")`)).toEqual({ '{"host":"x"}': [1, 2, 3] });
    expect(values('clamp_max(a, 15)')).toEqual([[10, 15, null]]);
    expect(values('clamp_min(b, -1)')).toEqual([[2, 0, 4]]);
    expect(values('cumsum(b)')).toEqual([[2, 2, 6]]);
    expect(values('abs(-3)')).toEqual([[3, 3, 3]]);
    expect(values('default_zero(a)')).toEqual([[10, 20, 0]]);
    expect(values('per_minute(b)')).toEqual([[null, 0, 4]]);
    expect(values('round(a / 3, 1)')).toEqual([[3.3, 6.7, null]]);
  });

  it('function results compose with operators', () => {
    expect(values('abs(a - 15) * 2')).toEqual([[10, 10, null]]);
    expect(values('count_not_null(h) + 1')).toEqual([[3, 3, 3]]);
    expect(evaluate('count_not_null(h)').keys).toEqual([]);
  });

  it('minimum and maximum take the other side when one is null', () => {
    expect(values('minimum(a, b)')).toEqual([[2, 0, 4]]);
    expect(values('maximum(a, b)')).toEqual([[10, 20, 4]]);
    expect(values('maximum(a, 15)')).toEqual([[15, 20, 15]]);
  });

  it('pow and time', () => {
    expect(values('pow(b, 2)')).toEqual([[4, 0, 16]]);
    expect(values('pow(2, b)')).toEqual([[4, 1, 16]]);
    expect(values('pow(-8, 0.5)')).toEqual([[null, null, null]]);
    expect(values('time()')).toEqual([times.map((t) => t / 1000)]);
    expect(values('time() - time()')).toEqual([[0, 0, 0]]);
  });

  it('results belong to the formula row', () => {
    expect(evaluate('h * 2').series.every((s) => s.refLetter === 'f1')).toBe(true);
    expect(evaluate('a').series[0].refLetter).toBe('f1');
    expect(rows.a.series[0].refLetter).toBe('a');
  });

  it('keeps the unit through + and - of the same unit and through functions, drops it otherwise', () => {
    expect(evaluate('a + b').unit).toBe('ms');
    expect(evaluate('a - 5').unit).toBe('ms');
    expect(evaluate('abs(a)').unit).toBe('ms');
    expect(evaluate('maximum(a, b)').unit).toBe('ms');
    expect(evaluate('a + c').unit).toBeUndefined();
    expect(evaluate('a * 2').unit).toBeUndefined();
    expect(evaluate('a / b').unit).toBeUndefined();
  });
});

describe('expandLetters', () => {
  const texts = new Map([
    ['a', 'avg:cpu{*}'],
    ['b', 'sum:req{env:prod}'],
  ]);

  it('replaces query letters with their text forms and keeps the rest of the expression', () => {
    expect(expandLetters('a * 2', texts)).toBe('avg:cpu{*} * 2');
    expect(expandLetters(' (a+b) / a ', texts)).toBe('(avg:cpu{*}+sum:req{env:prod}) / avg:cpu{*}');
    expect(expandLetters("top(b, 5, 'a', 'desc')", texts)).toBe("top(sum:req{env:prod}, 5, 'a', 'desc')");
  });

  it('leaves unknown letters and unparsable text alone', () => {
    expect(expandLetters('c + 1', texts)).toBe('c + 1');
    expect(expandLetters('a # b', texts)).toBe('a # b');
  });
});
