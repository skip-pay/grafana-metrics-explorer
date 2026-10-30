import { Series } from '../model/types';
import { CLIENT_FUNCTIONS, keysAfter, ROLLUP_AGGS, TOP_REDUCERS } from './clientFunctions';
import { clean, constantSeries, labelKey, SeriesSet, unionKeys, Values } from './series';

export class FormulaError extends Error {}

type Token =
  | { type: 'number'; value: number; pos: number }
  | { type: 'string'; value: string; pos: number }
  | { type: 'ident'; value: string; pos: number }
  | { type: 'op'; value: '+' | '-' | '*' | '/'; pos: number }
  | { type: '(' | ')' | ','; pos: number };

export type FormulaNode =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ref'; letter: string }
  | { type: 'unary'; op: '+' | '-'; arg: FormulaNode }
  | { type: 'binary'; op: '+' | '-' | '*' | '/'; left: FormulaNode; right: FormulaNode }
  | { type: 'call'; name: string; args: FormulaNode[] };

const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const rest = text.slice(i);
    if (/\s/.test(ch)) {
      i++;
    } else if (NUMBER.test(rest)) {
      const m = rest.match(NUMBER)![0];
      tokens.push({ type: 'number', value: Number(m), pos: i });
      i += m.length;
    } else if (IDENT.test(rest)) {
      const m = rest.match(IDENT)![0];
      tokens.push({ type: 'ident', value: m, pos: i });
      i += m.length;
    } else if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1);
      if (end < 0) {
        throw new FormulaError(`Unterminated string at position ${i + 1}`);
      }
      tokens.push({ type: 'string', value: text.slice(i + 1, end), pos: i });
      i = end + 1;
    } else if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ type: 'op', value: ch, pos: i });
      i++;
    } else if (ch === '(' || ch === ')' || ch === ',') {
      tokens.push({ type: ch, pos: i });
      i++;
    } else {
      throw new FormulaError(`Unexpected character \`${ch}\` at position ${i + 1}`);
    }
  }
  return tokens;
}

/** The expression with each query letter replaced by `texts` (the query's text form); unchanged if it does not parse. */
export function expandLetters(expression: string, texts: Map<string, string>): string {
  let tokens: Token[];
  try {
    tokens = tokenize(expression);
  } catch {
    return expression.trim();
  }
  let out = '';
  let last = 0;
  tokens.forEach((t, i) => {
    const text = t.type === 'ident' && tokens[i + 1]?.type !== '(' ? texts.get(t.value) : undefined;
    if (text !== undefined && t.type === 'ident') {
      out += expression.slice(last, t.pos) + text;
      last = t.pos + t.value.length;
    }
  });
  return (out + expression.slice(last)).trim();
}

const BINDING: Record<string, number> = { '+': 10, '-': 10, '*': 20, '/': 20 };
const UNARY_BINDING = 30;

/** Pratt parser over the tokens of a formula expression. */
export function parseFormula(text: string): FormulaNode {
  const tokens = tokenize(text);
  if (tokens.length === 0) {
    throw new FormulaError('Formula is empty');
  }
  let pos = 0;

  const describe = (t: Token | undefined) => {
    if (!t) {
      return 'end of formula';
    }
    const value = 'value' in t ? String(t.value) : t.type;
    return `\`${value}\` at position ${t.pos + 1}`;
  };

  const expect = (type: Token['type']) => {
    const t = tokens[pos];
    if (!t || t.type !== type) {
      throw new FormulaError(type === ')' ? `Missing \`)\` before ${describe(t)}` : `Unexpected ${describe(t)}`);
    }
    pos++;
  };

  const prefix = (): FormulaNode => {
    const t = tokens[pos++];
    if (!t) {
      throw new FormulaError('Unexpected end of formula');
    }
    switch (t.type) {
      case 'number':
        return { type: 'number', value: t.value };
      case 'string':
        return { type: 'string', value: t.value };
      case 'op':
        if (t.value === '-' || t.value === '+') {
          return { type: 'unary', op: t.value, arg: expression(UNARY_BINDING) };
        }
        break;
      case '(': {
        const inner = expression(0);
        expect(')');
        return inner;
      }
      case 'ident':
        if (tokens[pos]?.type === '(') {
          pos++;
          const args: FormulaNode[] = [];
          if (tokens[pos]?.type !== ')') {
            args.push(expression(0));
            while (tokens[pos]?.type === ',') {
              pos++;
              args.push(expression(0));
            }
          }
          expect(')');
          return { type: 'call', name: t.value, args };
        }
        return { type: 'ref', letter: t.value };
    }
    throw new FormulaError(`Unexpected ${describe(t)}`);
  };

  const expression = (minBinding: number): FormulaNode => {
    let left = prefix();
    for (;;) {
      const t = tokens[pos];
      if (!t || t.type !== 'op' || BINDING[t.value] <= minBinding) {
        return left;
      }
      pos++;
      left = { type: 'binary', op: t.value, left, right: expression(BINDING[t.value]) };
    }
  };

  const node = expression(0);
  if (pos < tokens.length) {
    throw new FormulaError(`Unexpected ${describe(tokens[pos])}`);
  }
  return node;
}

interface ParamSpec {
  kind: 'number' | 'string';
  options?: string[];
}

interface FormulaFunction {
  /** Leading arguments that are expressions (series or numbers). */
  operands: number;
  /** Trailing literal parameters; all optional. */
  params: ParamSpec[];
}

const number: ParamSpec = { kind: 'number' };

const FORMULA_ONLY: Record<string, FormulaFunction> = {
  minimum: { operands: 2, params: [] },
  maximum: { operands: 2, params: [] },
  pow: { operands: 2, params: [] },
  time: { operands: 0, params: [] },
};

const CLIENT_PARAMS: Record<string, ParamSpec[]> = {
  round: [number],
  clamp_min: [number],
  clamp_max: [number],
  cutoff_min: [number],
  cutoff_max: [number],
  is_greater: [number],
  is_less: [number],
  is_between: [number, number],
  top: [number, { kind: 'string', options: TOP_REDUCERS }, { kind: 'string', options: ['asc', 'desc'] }],
  bottom: [number, { kind: 'string', options: TOP_REDUCERS }, { kind: 'string', options: ['asc', 'desc'] }],
  moving_rollup: [number, { kind: 'string', options: ROLLUP_AGGS }],
};

/** Functions callable in a formula: every client post function (not the `fill` modifier) plus the formula-only ones. */
function formulaFunction(name: string): FormulaFunction | undefined {
  if (FORMULA_ONLY[name]) {
    return FORMULA_ONLY[name];
  }
  if (name !== 'fill' && CLIENT_FUNCTIONS[name]) {
    return { operands: 1, params: CLIENT_PARAMS[name] ?? [] };
  }
  return undefined;
}

/** A literal parameter: a number (optionally negated) or a quoted string. */
function literal(node: FormulaNode): number | string | undefined {
  if (node.type === 'number' || node.type === 'string') {
    return node.value;
  }
  if (node.type === 'unary' && node.arg.type === 'number') {
    return node.op === '-' ? -node.arg.value : node.arg.value;
  }
  return undefined;
}

/** Throws a FormulaError for unknown letters, unknown functions and wrong arguments. */
function checkFormula(node: FormulaNode, letters: string[]): void {
  switch (node.type) {
    case 'number':
      return;
    case 'string':
      throw new FormulaError(`Unexpected string '${node.value}'`);
    case 'ref':
      if (!letters.includes(node.letter)) {
        throw new FormulaError(`Unknown query \`${node.letter}\``);
      }
      return;
    case 'unary':
      return checkFormula(node.arg, letters);
    case 'binary':
      checkFormula(node.left, letters);
      return checkFormula(node.right, letters);
    case 'call': {
      const fn = formulaFunction(node.name);
      if (!fn) {
        throw new FormulaError(`Unknown function \`${node.name}\``);
      }
      const max = fn.operands + fn.params.length;
      if (node.args.length < fn.operands || node.args.length > max) {
        const expected = fn.operands === max ? `${max}` : `${fn.operands} to ${max}`;
        throw new FormulaError(`\`${node.name}\` takes ${expected} argument${max === 1 ? '' : 's'}`);
      }
      node.args.slice(0, fn.operands).forEach((arg) => checkFormula(arg, letters));
      node.args.slice(fn.operands).forEach((arg, i) => {
        const spec = fn.params[i];
        const value = literal(arg);
        if (spec.kind === 'number' && typeof value !== 'number') {
          throw new FormulaError(`Argument ${fn.operands + i + 1} of \`${node.name}\` must be a number`);
        }
        if (spec.kind === 'string' && typeof value !== 'string') {
          throw new FormulaError(`Argument ${fn.operands + i + 1} of \`${node.name}\` must be a quoted string`);
        }
        if (spec.options && !spec.options.includes(String(value))) {
          throw new FormulaError(`\`${node.name}\` accepts ${spec.options.map((o) => `'${o}'`).join(', ')}`);
        }
      });
    }
  }
}

/** The error message for an invalid formula, or null. */
export function formulaError(expression: string, letters: string[]): string | null {
  try {
    checkFormula(parseFormula(expression), letters);
    return null;
  } catch (e) {
    if (e instanceof FormulaError) {
      return e.message;
    }
    throw e;
  }
}

type Value = { kind: 'scalar'; value: number | null } | { kind: 'set'; set: SeriesSet };

export interface FormulaEnv {
  refLetter: string;
  stepSec: number;
  times: number[];
  /** Series of every query letter that exists; a letter without compiled query maps to an empty set. */
  rows: Record<string, SeriesSet>;
  /** Refuse results with more series than this. */
  maxSeries: number;
}

type BinaryFn = (a: number | null, b: number | null) => number | null;

const BINARY: Record<'+' | '-' | '*' | '/', BinaryFn> = {
  '+': (a, b) => (a === null || b === null ? null : a + b),
  '-': (a, b) => (a === null || b === null ? null : a - b),
  '*': (a, b) => (a === null || b === null ? null : a * b),
  '/': (a, b) => (a === null || b === null || b === 0 ? null : a / b),
};

const EXTREMES: Record<string, BinaryFn> = {
  minimum: (a, b) => (a === null ? b : b === null ? a : Math.min(a, b)),
  maximum: (a, b) => (a === null ? b : b === null ? a : Math.max(a, b)),
};

const pow: BinaryFn = (a, b) => (a === null || b === null ? null : clean(Math.pow(a, b)));

/** Units survive `+`, `-`, minimum/maximum and the one-operand functions when both sides agree. */
function keepUnit(a: Value, b: Value): string | undefined {
  const ua = a.kind === 'set' ? a.set.unit : undefined;
  const ub = b.kind === 'set' ? b.set.unit : undefined;
  if (a.kind === 'scalar') {
    return ub;
  }
  if (b.kind === 'scalar') {
    return ua;
  }
  return ua === ub ? ua : undefined;
}

function describeSet(set: SeriesSet): string {
  return set.keys.length ? `by {${set.keys.join(',')}}` : 'ungrouped';
}

function combine(a: Value, b: Value, fn: BinaryFn, env: FormulaEnv, unit: string | undefined): Value {
  if (a.kind === 'scalar' && b.kind === 'scalar') {
    return { kind: 'scalar', value: fn(a.value, b.value) };
  }
  const zip = (x: Values, y: Values): Values => env.times.map((_, i) => clean(fn(x[i] ?? null, y[i] ?? null)));
  const pair = (left: Series, right: Series, labels: Record<string, string>): Series => ({
    ...left,
    refLetter: env.refLetter,
    labels,
    values: zip(left.values, right.values),
  });
  if (a.kind === 'scalar' || b.kind === 'scalar') {
    const set = a.kind === 'set' ? a.set : (b as { kind: 'set'; set: SeriesSet }).set;
    const scalar = a.kind === 'scalar' ? a.value : (b as { kind: 'scalar'; value: number | null }).value;
    const constant = env.times.map(() => scalar);
    const series = set.series.map((s) => ({
      ...s,
      refLetter: env.refLetter,
      values: a.kind === 'scalar' ? zip(constant, s.values) : zip(s.values, constant),
    }));
    return { kind: 'set', set: { series, keys: set.keys, unit } };
  }

  const left = a.set;
  const right = b.set;
  const keys = unionKeys(left.keys, right.keys);
  const result = (series: Series[]): Value => {
    if (series.length > env.maxSeries) {
      throw new FormulaError(`Too many series (${series.length}). Add a filter or group by fewer tags.`);
    }
    return { kind: 'set', set: { series, keys, unit } };
  };
  if (left.series.length === 0 || right.series.length === 0) {
    return result([]);
  }
  const broadcastLeft = left.series.length === 1 && left.keys.length === 0;
  const broadcastRight = right.series.length === 1 && right.keys.length === 0;
  const sameKeys = left.keys.length === right.keys.length && left.keys.every((k) => right.keys.includes(k));
  if (broadcastLeft || broadcastRight || (!sameKeys && (left.series.length === 1 || right.series.length === 1))) {
    const one = broadcastLeft || (!broadcastRight && left.series.length === 1);
    return one
      ? result(right.series.map((r) => pair(left.series[0], r, { ...left.series[0].labels, ...r.labels })))
      : result(left.series.map((l) => pair(l, right.series[0], { ...right.series[0].labels, ...l.labels })));
  }
  const common = sameKeys ? left.keys : left.keys.filter((k) => right.keys.includes(k));
  if (common.length === 0) {
    throw new FormulaError(
      `Cannot combine series ${describeSet(left)} with series ${describeSet(right)}: they share no tags`
    );
  }
  const byKey = new Map<string, Series[]>();
  for (const r of right.series) {
    const k = labelKey(r.labels, common);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const out: Series[] = [];
  for (const l of left.series) {
    for (const r of byKey.get(labelKey(l.labels, common)) ?? []) {
      out.push(pair(l, r, { ...r.labels, ...l.labels }));
    }
  }
  return result(out);
}

function toSet(v: Value, env: FormulaEnv): SeriesSet {
  if (v.kind === 'set') {
    return v.set;
  }
  return { series: [constantSeries(env.refLetter, env.times, clean(v.value))], keys: [] };
}

function evalNode(node: FormulaNode, env: FormulaEnv): Value {
  switch (node.type) {
    case 'number':
      return { kind: 'scalar', value: node.value };
    case 'string':
      throw new FormulaError(`Unexpected string '${node.value}'`);
    case 'ref': {
      const set = env.rows[node.letter];
      if (!set) {
        throw new FormulaError(`Unknown query \`${node.letter}\``);
      }
      return { kind: 'set', set: { ...set, series: set.series.map((s) => ({ ...s, refLetter: env.refLetter })) } };
    }
    case 'unary': {
      const v = evalNode(node.arg, env);
      if (node.op === '+') {
        return v;
      }
      return combine({ kind: 'scalar', value: -1 }, v, BINARY['*'], env, v.kind === 'set' ? v.set.unit : undefined);
    }
    case 'binary': {
      const a = evalNode(node.left, env);
      const b = evalNode(node.right, env);
      const unit = node.op === '+' || node.op === '-' ? keepUnit(a, b) : undefined;
      return combine(a, b, BINARY[node.op], env, unit);
    }
    case 'call':
      return evalCall(node, env);
  }
}

function evalCall(node: Extract<FormulaNode, { type: 'call' }>, env: FormulaEnv): Value {
  const name = node.name;
  if (name === 'time') {
    const values = env.times.map((t) => t / 1000);
    return { kind: 'set', set: { series: [{ ...constantSeries(env.refLetter, env.times, null), values }], keys: [] } };
  }
  if (name in EXTREMES || name === 'pow') {
    const a = evalNode(node.args[0], env);
    const b = evalNode(node.args[1], env);
    return name === 'pow' ? combine(a, b, pow, env, undefined) : combine(a, b, EXTREMES[name], env, keepUnit(a, b));
  }
  const set = toSet(evalNode(node.args[0], env), env);
  const args = node.args.slice(1).map((arg) => literal(arg)!);
  const series = CLIENT_FUNCTIONS[name](set.series, args, {
    stepSec: env.stepSec,
    times: env.times,
    keys: set.keys,
    refLetter: env.refLetter,
  });
  return { kind: 'set', set: { series, keys: keysAfter(name, set.keys), unit: set.unit } };
}

/** Parses, checks and evaluates a formula; throws FormulaError. A plain number becomes a constant series. */
export function evaluateFormula(expression: string, env: FormulaEnv): SeriesSet {
  const node = parseFormula(expression);
  checkFormula(node, Object.keys(env.rows));
  return toSet(evalNode(node, env), env);
}
