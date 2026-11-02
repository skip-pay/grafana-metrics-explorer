import { defaultsForKind, newId } from '../model/defaults';
import { FunctionCall, MetricInfo, MetricQuery, SpaceAgg } from '../model/types';
import { isValidLabelKey, parseScopeText, renderScope } from './filters';
import { getFunction, isDottedModifier, normalizeArgs, visibleArgs } from './functions';

const SPACE_AGGS: SpaceAgg[] = ['avg', 'sum', 'min', 'max', 'count', 'p50', 'p75', 'p90', 'p95', 'p99'];

function renderArg(arg: number | string): string {
  return typeof arg === 'number' ? String(arg) : `'${arg.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * The query in text form, e.g. `sum:m{env:prod} by {path}.as_count()`. Dotted modifiers follow the query in list
 * order; every other function wraps it, innermost first.
 */
export function renderQueryText(q: MetricQuery, _metric?: MetricInfo): string {
  let text = `${q.spaceAgg}:${q.metric}{${renderScope(q.filters)}}`;
  if (q.groupBy.length > 0) {
    text += ` by {${q.groupBy.join(',')}}`;
  }
  for (const call of q.functions.filter((c) => isDottedModifier(c.name))) {
    text += `.${call.name}(${visibleArgs(call).map(String).join(', ')})`;
  }
  for (const call of q.functions.filter((c) => !isDottedModifier(c.name))) {
    text = `${call.name}(${[text, ...call.args.map(renderArg)].join(', ')})`;
  }
  return text;
}

type ParsedQuery = Pick<MetricQuery, 'metric' | 'filters' | 'groupBy' | 'functions'> & { spaceAgg?: SpaceAgg };

class ParseError extends Error {}

class Parser {
  private i = 0;

  constructor(private readonly s: string) {}

  fail(message: string): never {
    throw new ParseError(message);
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) {
      this.i++;
    }
  }

  peek(): string {
    this.ws();
    return this.s[this.i] ?? '';
  }

  atEnd(): boolean {
    return this.peek() === '';
  }

  rest(): string {
    return this.s.slice(this.i);
  }

  expect(c: string): void {
    if (this.peek() !== c) {
      this.fail(this.atEnd() ? `Expected "${c}" at the end` : `Expected "${c}" at position ${this.i + 1}`);
    }
    this.i++;
  }

  /** Identifiers allow dots so that metric names can be written `http.requests.total`. */
  ident(): string {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(this.s.slice(this.i));
    if (!m) {
      return '';
    }
    this.i += m[0].length;
    return m[0];
  }

  /** The text up to the matching `close`, skipping double-quoted strings and parentheses. */
  balanced(close: string): string {
    const start = this.i;
    let depth = 0;
    let quoted = false;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (quoted) {
        if (c === '\\') {
          this.i++;
        } else if (c === '"') {
          quoted = false;
        }
      } else if (c === '"') {
        quoted = true;
      } else if (c === '(') {
        depth++;
      } else if (c === ')' && depth > 0) {
        depth--;
      } else if (c === close && depth === 0) {
        return this.s.slice(start, this.i++);
      }
    }
    return this.fail(depth > 0 ? 'Missing ")"' : `Missing "${close}"`);
  }

  arg(): number | string {
    const c = this.peek();
    const rest = this.s.slice(this.i);
    if (c === "'" || c === '"') {
      let out = '';
      for (let j = 1; j < rest.length; j++) {
        if (rest[j] === '\\' && j + 1 < rest.length) {
          out += rest[++j];
        } else if (rest[j] === c) {
          this.i += j + 1;
          return out;
        } else {
          out += rest[j];
        }
      }
      return this.fail('Unterminated string');
    }
    const n = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(rest);
    if (n) {
      this.i += n[0].length;
      return Number(n[0]);
    }
    const word = this.ident();
    return word !== '' ? word : this.fail(`Expected an argument at position ${this.i + 1}`);
  }

  args(): Array<number | string> {
    const args: Array<number | string> = [];
    while (this.peek() === ',') {
      this.i++;
      args.push(this.arg());
    }
    return args;
  }

  call(name: string, args: Array<number | string>): FunctionCall {
    const def = getFunction(name)!;
    // `.rollup(60)` gives only the interval.
    const given = name === 'rollup' && typeof args[0] === 'number' ? [def.params[0].default, ...args] : args;
    const { args: normalized, error } = normalizeArgs(def, given);
    if (error) {
      this.fail(error);
    }
    return { id: newId(), name, args: normalized };
  }

  expr(): ParsedQuery {
    const start = this.i;
    const name = this.ident();
    if (name === '') {
      return this.fail(this.atEnd() ? 'Empty query' : `Expected a query at position ${this.i + 1}`);
    }
    const next = this.peek();
    if (next === '(') {
      const def = getFunction(name);
      if (!def || def.formulaOnly || isDottedModifier(name)) {
        return this.fail(def ? `${name}() cannot wrap a query` : `Unknown function ${name}()`);
      }
      this.i++;
      const inner = this.expr();
      const args = this.args();
      this.expect(')');
      return { ...inner, functions: [...inner.functions, this.call(name, args)] };
    }
    let spaceAgg: SpaceAgg | undefined;
    let metric = name;
    if (next === ':') {
      spaceAgg = SPACE_AGGS.find((a) => a === name.toLowerCase());
      if (!spaceAgg) {
        return this.fail(`Unknown aggregator "${name}"`);
      }
      this.i++;
      metric = this.ident();
      if (metric === '' && this.peek() !== '{') {
        return this.fail(`Expected a metric name at position ${this.i + 1}`);
      }
    } else if (next !== '{') {
      this.i = start;
      return this.fail(`Expected ":" or "{" after "${name}"`);
    }
    this.expect('{');
    const filters = parseScopeText(this.balanced('}'));
    if ('error' in filters) {
      return this.fail(filters.error);
    }
    // `by {…}` may also come after or between the modifiers: `m{*}.as_count() by {x}`.
    let groupBy: string[] | undefined;
    const functions: FunctionCall[] = [];
    for (;;) {
      if (this.peek() === '.') {
        this.i++;
        const mod = this.ident();
        if (!isDottedModifier(mod)) {
          return this.fail(`Unknown modifier .${mod}()`);
        }
        this.expect('(');
        const args = this.peek() === ')' ? [] : [this.arg(), ...this.args()];
        this.expect(')');
        functions.push(this.call(mod, args));
        continue;
      }
      const save = this.i;
      if (groupBy === undefined && this.ident() === 'by') {
        groupBy = this.groupBy();
        continue;
      }
      this.i = save;
      break;
    }
    return { metric, spaceAgg, filters, groupBy: groupBy ?? [], functions };
  }

  groupBy(): string[] {
    this.expect('{');
    const keys: string[] = [];
    for (const raw of this.balanced('}').split(',')) {
      const key = raw.trim();
      if (!isValidLabelKey(key)) {
        return this.fail(`Invalid tag key "${key}" in by {…}`);
      }
      keys.push(key);
    }
    return keys;
  }
}

const normalizeName = (name: string) => name.toLowerCase().replace(/[._\-\s]+/g, '_');

/** The catalogue name for a typed name; `.`, `_` and `-` are interchangeable. */
function resolveMetricName(name: string, metrics: MetricInfo[]): string | { error: string } {
  if (name === '' || metrics.some((m) => m.name === name)) {
    return name;
  }
  const key = normalizeName(name);
  const hit = metrics.find((m) => normalizeName(m.name) === key);
  if (hit) {
    return hit.name;
  }
  return /^[A-Za-z_:][A-Za-z0-9_:]*$/.test(name) ? name : { error: `Unknown metric "${name}"` };
}

/**
 * The histogram or CloudWatch metric whose `_sum` or `_count` stream the name is. The catalogue folds those streams
 * into the metric, where `sum:` reads `_sum` and `count:` reads `_count`.
 */
function foldedStream(name: string, metrics: MetricInfo[]): { metric: string; part: 'sum' | 'count' } | undefined {
  for (const m of metrics) {
    if (m.kind === 'distribution' || m.kind === 'cloudwatch') {
      const part = (['sum', 'count'] as const).find((p) => m.streams[p] === name);
      if (part) {
        return { metric: m.name, part };
      }
    }
  }
  return undefined;
}

/**
 * Parses the text form for raw mode and pasted queries. Dotted metric names resolve against the catalogue;
 * `sum:X_sum` and `sum:X_count` of a histogram or CloudWatch metric `X` read as `sum:X` and `count:X`.
 */
export function parseQueryText(text: string, metrics: MetricInfo[]): Partial<MetricQuery> | { error: string } {
  let parsed: ParsedQuery;
  try {
    const parser = new Parser(text);
    parsed = parser.expr();
    if (!parser.atEnd()) {
      return { error: `Unexpected text after the query: "${parser.rest()}"` };
    }
  } catch (e) {
    if (e instanceof ParseError) {
      return { error: e.message };
    }
    throw e;
  }
  const folded = foldedStream(parsed.metric, metrics);
  if (folded) {
    if (parsed.spaceAgg !== undefined && parsed.spaceAgg !== 'sum') {
      const hint = `${folded.part}:${folded.metric}{…}`;
      return { error: `"${parsed.metric}" is the _${folded.part} stream of "${folded.metric}"; write ${hint}` };
    }
    return { ...parsed, metric: folded.metric, spaceAgg: folded.part };
  }
  const metric = resolveMetricName(parsed.metric, metrics);
  if (typeof metric !== 'string') {
    return metric;
  }
  const info = metrics.find((m) => m.name === metric);
  return {
    metric,
    spaceAgg: parsed.spaceAgg ?? (info ? defaultsForKind(info.kind).spaceAgg : 'avg'),
    filters: parsed.filters,
    groupBy: parsed.groupBy,
    functions: parsed.functions,
  };
}
