import { FilterGroup, FilterItem, FilterOp, TagFilter } from '../model/types';

const LABEL_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidLabelKey(key: string): boolean {
  return LABEL_KEY.test(key);
}

export function isFilterGroup(item: FilterItem): item is FilterGroup {
  return 'items' in item;
}

/** Every term of the filters, inside groups too. */
export function filterTerms(items: FilterItem[]): TagFilter[] {
  return items.flatMap((item) => (isFilterGroup(item) ? filterTerms(item.items) : [item]));
}

/**
 * The top-level terms without the groups. They select at least what the whole filter selects, so tag values and
 * group counts read under them are an upper bound.
 */
export function topLevelFilters(items: FilterItem[]): TagFilter[] {
  return items.filter((item): item is TagFilter => !isFilterGroup(item));
}

/** A PromQL string literal. */
export function promString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}

/** `*` alone means "has the tag"; elsewhere `*` matches any run of characters. */
function wildcardRegex(value: string): string {
  return value === '*' ? '.+' : value.split('*').map(escapeRegex).join('.*');
}

// OpenObserve anchors an alternation per branch (`a|b` runs as `^a|b$`), so every emitted regex is grouped.
const group = (parts: string[]) => `(?:${parts.join('|')})`;

/** A label matcher: an exact value (`=`, `!=`) or regex alternatives (`=~`, `!~`); `any` when one is `key:*`. */
interface Matcher {
  key: string;
  negated: boolean;
  exact?: string;
  patterns: string[];
  any: boolean;
  /** The PromQL matcher, which also tells matchers apart. */
  text: string;
}

type Branch = Matcher[];

/** Branches a filter may compile to; each one repeats the metric's selectors in the query. */
export const MAX_BRANCHES = 16;
/**
 * Branches a cross product may reach before merging, and a merge may keep; stops many groups from growing
 * exponentially. Merging rarely brings more than this back to MAX_BRANCHES.
 */
const MAX_EXPANSION = 4 * MAX_BRANCHES;

function matcher(m: Omit<Matcher, 'text'>): Matcher {
  const text =
    m.exact !== undefined
      ? `${m.key}${m.negated ? '!=' : '='}${promString(m.exact)}`
      : `${m.key}${m.negated ? '!~' : '=~'}${promString(group(m.patterns))}`;
  return { ...m, text };
}

function termMatcher(f: TagFilter): Matcher {
  const negated = f.op === 'neq' || f.op === 'not_in';
  if (f.op === 'in' || f.op === 'not_in') {
    return matcher({ key: f.key, negated, patterns: f.values.map(escapeRegex), any: false });
  }
  const value = f.values[0] ?? '';
  return matcher({
    key: f.key,
    negated,
    ...(value.includes('*') ? {} : { exact: value }),
    patterns: [wildcardRegex(value)],
    any: value === '*',
  });
}

/** Either value of two positive matchers on one key. */
function either(a: Matcher, b: Matcher): Matcher {
  return matcher({ key: a.key, negated: false, patterns: [...a.patterns, ...b.patterns], any: a.any || b.any });
}

class TooManyBranches extends Error {}

/**
 * Items joined by `op`, negated or not, as a disjunction of matcher conjunctions: NOT goes down to the terms by
 * De Morgan's laws. In an AND list, eq terms of one key match either value.
 */
function branchesOf(op: FilterGroup['op'], items: FilterItem[], negated: boolean): Branch[] {
  const operands: Array<Matcher | Branch[]> = [];
  const eqAt = new Map<string, number>();
  for (const item of items) {
    if (isFilterGroup(item)) {
      operands.push(branchesOf(item.op, item.items, negated !== Boolean(item.negated)));
      continue;
    }
    const m = termMatcher(item);
    const eqKey = op === 'and' && item.op === 'eq' ? item.key : undefined;
    const at = eqKey !== undefined ? eqAt.get(eqKey) : undefined;
    if (at !== undefined) {
      operands[at] = either(operands[at] as Matcher, m);
      continue;
    }
    if (eqKey !== undefined) {
      eqAt.set(eqKey, operands.length);
    }
    operands.push(m);
  }
  const alternatives = operands.map((o) =>
    Array.isArray(o) ? o : [[negated ? matcher({ ...o, negated: !o.negated }) : o]]
  );
  if ((op === 'and') !== negated) {
    return product(alternatives);
  }
  return merge(alternatives.flat());
}

/**
 * One branch per choice of an alternative from every operand, merged after each operand with several alternatives
 * to keep the count down, and at the end.
 */
function product(operands: Branch[][]): Branch[] {
  let branches: Branch[] = [[]];
  for (const alternatives of operands) {
    if (branches.length * alternatives.length > MAX_EXPANSION) {
      throw new TooManyBranches();
    }
    const next = branches.flatMap((branch) => alternatives.map((alt) => [...branch, ...alt]));
    branches = alternatives.length > 1 ? merge(next) : next;
  }
  return merge(branches);
}

/** A branch with the texts of its matchers. */
interface Entry {
  branch: Branch;
  texts: Set<string>;
}

const entry = (branch: Branch): Entry => ({ branch, texts: new Set(branch.map((m) => m.text)) });

/**
 * Joins pairs of branches that are one branch together until none is left. Each branch is joined into the ones
 * kept so far, which never join each other, and a joined branch keeps the earlier place.
 */
function merge(branches: Branch[]): Branch[] {
  const out: Entry[] = [];
  for (const branch of branches) {
    let at = out.length;
    out.push(entry(branch));
    for (let k = 0; k < out.length; k++) {
      const [i, j] = k < at ? [k, at] : [at, k];
      const joined = k === at ? undefined : (join(out[i], out[j]) ?? join(out[j], out[i]));
      if (joined) {
        out[i] = entry(joined);
        out.splice(j, 1);
        at = i;
        k = -1;
      }
    }
    if (out.length > MAX_EXPANSION) {
      throw new TooManyBranches();
    }
  }
  return out.map((e) => e.branch);
}

/**
 * `a OR b` as one branch, if it is one: `a` when `b` only adds matchers to it, or `a` with its matcher on one key
 * widened when the two differ only in a positive matcher on that key.
 */
function join(a: Entry, b: Entry): Branch | undefined {
  const onlyA = a.branch.filter((m) => !b.texts.has(m.text));
  if (onlyA.length === 0) {
    return a.branch;
  }
  const onlyB = b.branch.filter((m) => !a.texts.has(m.text));
  const [x, y] = [onlyA[0], onlyB[0]];
  if (onlyA.length === 1 && onlyB.length === 1 && !x.negated && !y.negated && x.key === y.key) {
    return a.branch.map((m) => (m === x ? either(x, y) : m));
  }
  return undefined;
}

/** PromQL label matchers (`k="v"`, `k=~"(?:a|b)"`…) of terms joined by AND; eq terms of one key are ORed. */
export function filtersToMatchers(filters: TagFilter[]): string[] {
  return branchesOf('and', filters, false)[0].map((m) => m.text);
}

/**
 * PromQL label matchers of the filters, one list per OR branch: together the branches select what the filters
 * select. Without groups there is one branch, the same as `filtersToMatchers`.
 */
export function filterBranches(items: FilterItem[]): string[][] | { error: string } {
  const tooMany = {
    error:
      `The filter expands to more than ${MAX_BRANCHES} OR branches; ` +
      'simplify it or list the values of a tag with IN (…)',
  };
  let branches: Branch[];
  try {
    branches = branchesOf('and', items, false);
  } catch (e) {
    if (e instanceof TooManyBranches) {
      return tooMany;
    }
    throw e;
  }
  if (branches.length > MAX_BRANCHES) {
    return tooMany;
  }
  if (branches.some((branch) => branch.some((m) => m.negated && m.any))) {
    return { error: 'Filtering on a missing tag (!key:*) is not supported' };
  }
  return branches.map((branch) => branch.map((m) => m.text));
}

/** AND or OR after whitespace, ending a value: followed by whitespace, "(" or the end. */
const OPERATOR = /\s(?:AND|OR)(?=[\s(]|$)/;

function needsQuotes(value: string): boolean {
  return value === '' || value !== value.trim() || /[,{}()"\\]/.test(value) || OPERATOR.test(value);
}

/** A tag value as written in the text form, double-quoted when it holds a separator. */
export function quoteValue(value: string): string {
  return needsQuotes(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

/** A term, or a group in parentheses with its items joined by AND or OR. */
export function filterToText(item: FilterItem): string {
  if (isFilterGroup(item)) {
    return `${item.negated ? 'NOT ' : ''}(${item.items.map(filterToText).join(` ${item.op.toUpperCase()} `)})`;
  }
  switch (item.op) {
    case 'eq':
      return `${item.key}:${quoteValue(item.values[0] ?? '')}`;
    case 'neq':
      return `!${item.key}:${quoteValue(item.values[0] ?? '')}`;
    case 'in':
      return `${item.key} IN (${item.values.map(quoteValue).join(',')})`;
    case 'not_in':
      return `${item.key} NOT IN (${item.values.map(quoteValue).join(',')})`;
  }
}

/** The scope between the braces of the text form; no filter is `*` (everywhere). */
export function renderScope(filters: FilterItem[]): string {
  return filters.length === 0 ? '*' : filters.map(filterToText).join(',');
}

class ScopeError extends Error {}

const COMPLEMENT: Record<FilterOp, FilterOp> = { eq: 'neq', neq: 'eq', in: 'not_in', not_in: 'in' };

/** NOT of an item: a term turns into its complement, a group toggles its negation. */
function negate(item: FilterItem): FilterItem {
  if (isFilterGroup(item)) {
    return item.negated ? { op: item.op, items: item.items } : { op: item.op, negated: true, items: item.items };
  }
  if (item.op === 'eq' && item.values[0] === '*') {
    throw new ScopeError(`NOT ${item.key}:* (tag absent) is not supported`);
  }
  return { ...item, op: COMPLEMENT[item.op] };
}

/** Items joined by `op`: a single item stays itself, and groups of the same operator are flattened into it. */
function combine(op: FilterGroup['op'], items: FilterItem[]): FilterItem {
  const flat = items.flatMap((item) => (isFilterGroup(item) && item.op === op && !item.negated ? item.items : [item]));
  return flat.length === 1 ? flat[0] : { op, items: flat };
}

/**
 * Recursive descent over the scope: `or = and {OR and}`, `and = unary {(AND | ",") unary}`,
 * `unary = NOT unary | "(" or ")" | term`. The `after` arguments name the token before, for errors.
 */
class ScopeParser {
  private i = 0;

  constructor(private readonly s: string) {}

  fail(message: string): never {
    throw new ScopeError(message);
  }

  /** The next character after whitespace, which is skipped. */
  peek(): string {
    while (/\s/.test(this.s.charAt(this.i))) {
      this.i++;
    }
    return this.s.charAt(this.i);
  }

  /** AND, OR or NOT at the cursor, when followed by whitespace, "(" or the end. */
  keyword(): string | undefined {
    this.peek();
    return /^(?:AND|OR|NOT)(?=[\s(]|$)/.exec(this.s.slice(this.i))?.[0];
  }

  accept(word: string): boolean {
    if (this.keyword() !== word) {
      return false;
    }
    this.i += word.length;
    return true;
  }

  end(): void {
    const rest = this.s.slice(this.i).trim();
    if (rest !== '') {
      this.fail(rest.startsWith(')') ? 'Unexpected ")"' : `Unexpected text "${rest}"`);
    }
  }

  or(after?: string): FilterItem {
    const items = [this.and(after)];
    while (this.accept('OR')) {
      items.push(this.and('OR'));
    }
    return combine('or', items);
  }

  and(after?: string): FilterItem {
    const items = [this.unary(after)];
    for (;;) {
      if (this.peek() === ',') {
        this.i++;
        items.push(this.unary(','));
      } else if (this.accept('AND')) {
        items.push(this.unary('AND'));
      } else {
        return combine('and', items);
      }
    }
  }

  unary(after?: string): FilterItem {
    if (this.accept('NOT')) {
      return negate(this.unary('NOT'));
    }
    if (this.peek() !== '(') {
      return this.term(after);
    }
    this.i++;
    const item = this.or('(');
    if (this.peek() !== ')') {
      return this.peek() === '' ? this.fail('Missing ")"') : this.fail(`Unexpected text "${this.s.slice(this.i)}"`);
    }
    this.i++;
    return item;
  }

  /** `k:v`, `!k:v`, `k:v*`, `k:*`, `k IN (a,b)` or `k NOT IN (a,b)`. */
  term(after?: string): TagFilter {
    const c = this.peek();
    const keyword = this.keyword();
    if (c === '' || c === ',' || c === ')' || keyword) {
      return this.fail(
        after
          ? `Expected a filter after "${after}"`
          : c === ''
            ? 'Empty filter'
            : `Expected a filter before "${keyword ?? c}"`
      );
    }
    if (c === '$') {
      return this.fail('Template variables are not supported');
    }
    const start = this.i;
    const negated = c === '!';
    if (negated) {
      this.i++;
      this.peek();
    }
    const key = /^[^\s:!(),"]*/.exec(this.s.slice(this.i))![0];
    this.i += key.length;
    const afterKey = this.i;
    if (this.peek() === ':') {
      this.i++;
      this.checkKey(key);
      const value = this.value(key);
      if (value === '') {
        return this.fail(`Missing value for "${key}"`);
      }
      if (negated && value === '*') {
        return this.fail(`!${key}:* (tag absent) is not supported`);
      }
      return { key, op: negated ? 'neq' : 'eq', values: [value] };
    }
    this.i = afterKey;
    const inForm = negated || key === '' ? null : /^\s+(NOT\s+IN|IN)\s*\(/i.exec(this.s.slice(this.i));
    if (!inForm) {
      const raw = /^[^,()]*/.exec(this.s.slice(start))![0];
      const cut = raw.search(OPERATOR);
      return this.fail(`Expected key:value, got "${(cut >= 0 ? raw.slice(0, cut) : raw).trim()}"`);
    }
    this.checkKey(key);
    this.i += inForm[0].length;
    const op = /^not/i.test(inForm[1]) ? 'not_in' : 'in';
    return { key, op, values: this.list(`${key} ${op === 'in' ? 'IN' : 'NOT IN'}`) };
  }

  checkKey(key: string): void {
    if (!isValidLabelKey(key)) {
      this.fail(`Invalid tag key "${key}"`);
    }
  }

  /** A value after `key:`: double-quoted, or the text up to the next ",", ")", AND or OR, trimmed. */
  value(key: string): string {
    if (this.peek() === '"') {
      const value = this.quoted();
      const c = this.peek();
      if (c !== '' && c !== ',' && c !== ')' && !/^(?:AND|OR)(?=[\s(]|$)/.test(this.s.slice(this.i))) {
        this.fail(`Unexpected text after the quoted value "${value}"`);
      }
      return value;
    }
    const raw = /^[^,()"]*/.exec(this.s.slice(this.i))![0];
    const cut = raw.search(OPERATOR);
    const text = cut >= 0 ? raw.slice(0, cut) : raw;
    this.i += text.length;
    const c = this.s.charAt(this.i);
    if (c === '(' && /\sNOT\s*$/.test(text)) {
      this.fail('Expected AND, OR or "," before NOT');
    }
    if (c === '"') {
      this.fail(`Unexpected quote in the value of "${key}"`);
    }
    if (c === '(') {
      this.fail(`Unexpected "(" in the value of "${key}"; quote values that contain parentheses`);
    }
    return text.trim();
  }

  /** The values of an IN list up to its ")"; `term` names the list in errors. */
  list(term: string): string[] {
    const values: string[] = [];
    for (;;) {
      let value: string;
      if (this.peek() === '"') {
        value = this.quoted();
      } else {
        const raw = /^[^,()"]*/.exec(this.s.slice(this.i))![0];
        this.i += raw.length;
        value = raw.trim();
      }
      if (value === '') {
        this.fail(`Empty value in ${term} (…)`);
      }
      values.push(value);
      const c = this.peek();
      this.i++;
      if (c === ')') {
        return values;
      }
      if (c === '') {
        this.fail(`Missing ")" in ${term} (…)`);
      }
      if (c !== ',') {
        this.fail(`Unexpected ${c === '"' ? 'quote' : `"${c}"`} in ${term} (…)`);
      }
    }
  }

  quoted(): string {
    const start = this.i;
    let out = '';
    for (this.i++; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === '\\' && this.i + 1 < this.s.length) {
        out += this.s[++this.i];
      } else if (c === '"') {
        this.i++;
        return out;
      } else {
        out += c;
      }
    }
    return this.fail(`Unterminated quote in ${this.s.slice(start)}`);
  }
}

/**
 * The filters of a scope: `*` or empty for none, else terms combined with AND, OR, NOT and parentheses, where a comma
 * is AND. NOT binds tighter than AND, AND tighter than OR; the keywords are uppercase. The result is the top-level
 * AND list.
 */
export function parseScopeText(scope: string): FilterItem[] | { error: string } {
  const text = scope.trim();
  if (text === '' || text === '*') {
    return [];
  }
  try {
    const parser = new ScopeParser(text);
    const root = parser.or();
    parser.end();
    return isFilterGroup(root) && root.op === 'and' && !root.negated ? root.items : [root];
  } catch (e) {
    if (e instanceof ScopeError) {
      return { error: e.message };
    }
    throw e;
  }
}
