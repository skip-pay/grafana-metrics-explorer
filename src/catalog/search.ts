import { MetricInfo } from '../model/types';
import { keyRank } from './keys';
import { MetricMatch, TagMatch, TagPair } from './types';

type Range = [number, number];
interface Hit {
  score: number;
  ranges: Range[];
}
interface Query {
  /** Lower case, separators collapsed to one `_`, trimmed. */
  whole: string;
  tokens: string[];
  /** The tokens without separators, for the subsequence tier. */
  chars: string;
}

// Tier bases; bonuses within a tier stay below the next tier.
const EXACT = 1000;
const PREFIX = 900;
const TOKEN_PREFIX = 800;
const IN_ORDER = 600;
const ANY_ORDER = 500;
const SUBSEQUENCE = 300;

/** Lower case with `.`, `-` and whitespace as `_`; one character for one, so match indices fit the original. */
function canonical(text: string): string {
  const lower = text.toLowerCase();
  return (lower.length === text.length ? lower : text).replace(/[\s.-]/g, '_');
}

function prepareQuery(text: string): Query | null {
  const whole = canonicalKey(text);
  if (whole === '') {
    return null;
  }
  const tokens = whole.split('_');
  return { whole, tokens, chars: tokens.join('') };
}

function canonicalKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s._-]+/g, '_')
    .replace(/^_|_$/g, '');
}

function isAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

/** A token starts at `i`: the text start or after a non-alphanumeric character. */
function isBoundary(text: string, i: number): boolean {
  return i === 0 || !isAlnum(text.charCodeAt(i - 1));
}

function indexAtBoundary(text: string, needle: string, from: number): number {
  for (let at = text.indexOf(needle, from); at >= 0; at = text.indexOf(needle, at + 1)) {
    if (isBoundary(text, at)) {
      return at;
    }
  }
  return -1;
}

/** Each token at or after `from`, preferring occurrences that start a token. */
function findToken(text: string, token: string, from: number, preferBoundary: boolean): number {
  const at = preferBoundary ? indexAtBoundary(text, token, from) : -1;
  return at >= 0 ? at : text.indexOf(token, from);
}

function boundaryBonus(text: string, ranges: Range[]): number {
  const atBoundary = ranges.filter(([start]) => isBoundary(text, start)).length;
  return Math.round((40 * atBoundary) / ranges.length);
}

function tokensInOrder(text: string, tokens: string[], preferBoundary: boolean): Range[] | null {
  const ranges: Range[] = [];
  let pos = 0;
  for (const token of tokens) {
    const at = findToken(text, token, pos, preferBoundary);
    if (at < 0) {
      return null;
    }
    ranges.push([at, at + token.length]);
    pos = at + token.length;
  }
  return ranges;
}

function tokensAnyOrder(text: string, tokens: string[]): Range[] | null {
  const ranges: Range[] = [];
  for (const token of tokens) {
    const at = findToken(text, token, 0, true);
    if (at < 0) {
      return null;
    }
    ranges.push([at, at + token.length]);
  }
  return ranges;
}

/** Every query character in order; fewer runs, gaps and runs off token starts score higher. */
function subsequence(text: string, chars: string): Hit | null {
  const ranges: Range[] = [];
  let pos = 0;
  let gaps = 0;
  let boundaryRuns = 0;
  for (const ch of chars) {
    const at = text.indexOf(ch, pos);
    if (at < 0) {
      return null;
    }
    const last = ranges[ranges.length - 1];
    if (last && last[1] === at) {
      last[1] = at + 1;
    } else {
      gaps += last ? at - last[1] : 0;
      boundaryRuns += isBoundary(text, at) ? 1 : 0;
      ranges.push([at, at + 1]);
    }
    pos = at + 1;
  }
  const score = SUBSEQUENCE + 5 * boundaryRuns - 10 * (ranges.length - 1) - 0.2 * gaps;
  return { score: Math.max(1, score), ranges };
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Tiers: exact > prefix > token-prefix > all tokens in order > all tokens in any order > subsequence. */
function match(text: string, q: Query): Hit | null {
  if (text === q.whole) {
    return { score: EXACT, ranges: [[0, text.length]] };
  }
  if (text.startsWith(q.whole)) {
    return { score: PREFIX, ranges: [[0, q.whole.length]] };
  }
  const at = indexAtBoundary(text, q.whole, 1);
  if (at >= 0) {
    return { score: TOKEN_PREFIX, ranges: [[at, at + q.whole.length]] };
  }
  const inOrder = tokensInOrder(text, q.tokens, true) ?? tokensInOrder(text, q.tokens, false);
  if (inOrder) {
    return { score: IN_ORDER + boundaryBonus(text, inOrder), ranges: mergeRanges(inOrder) };
  }
  const anyOrder = q.tokens.length > 1 ? tokensAnyOrder(text, q.tokens) : null;
  if (anyOrder) {
    return { score: ANY_ORDER + boundaryBonus(text, anyOrder), ranges: mergeRanges(anyOrder) };
  }
  // One or two scattered characters match nearly everything.
  return q.chars.length >= 3 ? subsequence(text, q.chars) : null;
}

function compareText(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

interface PreparedMetric {
  metric: MetricInfo;
  text: string;
}

const metricIndexes = new WeakMap<MetricInfo[], PreparedMetric[]>();

function prepareMetrics(metrics: MetricInfo[]): PreparedMetric[] {
  let index = metricIndexes.get(metrics);
  if (!index) {
    index = metrics
      .map((metric) => ({ metric, text: canonical(metric.name) }))
      .sort((a, b) => (a.metric.name < b.metric.name ? -1 : a.metric.name > b.metric.name ? 1 : 0));
    metricIndexes.set(metrics, index);
  }
  return index;
}

/**
 * Ranked metric search; case-insensitive and `.`, `_`, `-` and spaces are equivalent separators.
 * Shorter names win ties. An empty query lists the metrics by name.
 */
export function searchMetrics(query: string, metrics: MetricInfo[], limit = 100): MetricMatch[] {
  const index = prepareMetrics(metrics);
  const q = prepareQuery(query);
  if (!q) {
    return index.slice(0, limit).map(({ metric }) => ({ metric, score: 0, ranges: [] }));
  }
  const hits: MetricMatch[] = [];
  for (const { metric, text } of index) {
    const hit = match(text, q);
    if (hit) {
      hits.push({ metric, score: hit.score, ranges: hit.ranges });
    }
  }
  hits.sort((a, b) => b.score - a.score || compareText(a.metric.name, b.metric.name));
  return withoutFallback(hits).slice(0, limit);
}

/** Scattered-character matches are only a fallback: they are dropped once any token matches. Expects a sorted list. */
function withoutFallback<T extends { score: number }>(sorted: T[]): T[] {
  return sorted.length > 0 && sorted[0].score >= ANY_ORDER ? sorted.filter((hit) => hit.score >= ANY_ORDER) : sorted;
}

interface PreparedPair {
  pair: TagPair;
  /** Canonical `key:value`. */
  label: string;
  value: string;
}

const pairIndexes = new WeakMap<TagPair[], PreparedPair[]>();

function preparePairs(pairs: TagPair[]): PreparedPair[] {
  let index = pairIndexes.get(pairs);
  if (!index) {
    index = pairs.map((pair) => ({
      pair,
      label: canonical(`${pair.key}:${pair.value}`),
      value: canonical(pair.value),
    }));
    pairIndexes.set(pairs, index);
  }
  return index;
}

/** Keys named by the text before `:` — exact (separator-insensitive) match, else prefix (`env` → `environment`). */
function keysNamed(text: string, index: PreparedPair[]): Set<string> {
  const wanted = canonicalKey(text);
  const keys = [...new Set(index.map(({ pair }) => pair.key))];
  const exact = keys.filter((key) => canonicalKey(key) === wanted);
  return new Set(exact.length > 0 ? exact : keys.filter((key) => canonicalKey(key).startsWith(wanted)));
}

/** Score, then useful keys before low-priority ones; an unranked listing groups by key in natural value order. */
function compareTagMatches(a: TagMatch, b: TagMatch): number {
  return (
    b.score - a.score ||
    keyRank(a.pair.key) - keyRank(b.pair.key) ||
    (a.score > 0
      ? compareText(`${a.pair.key}:${a.pair.value}`, `${b.pair.key}:${b.pair.value}`)
      : a.pair.key.localeCompare(b.pair.key) || a.pair.value.localeCompare(b.pair.value, undefined, { numeric: true }))
  );
}

/**
 * Ranked search over `key:value` pairs with the metric search's tiers. `key:` narrows to that key and
 * ranks its values; a leading `!` is ignored for matching and returned as `negated`.
 */
export function searchTags(query: string, pairs: TagPair[], limit = 100): TagMatch[] {
  const index = preparePairs(pairs);
  let text = query.trim();
  const negated = text.startsWith('!');
  if (negated) {
    text = text.slice(1).trim();
  }
  const colon = text.indexOf(':');
  const keys = colon >= 0 ? keysNamed(text.slice(0, colon), index) : undefined;
  const results: TagMatch[] = [];

  if (keys && keys.size > 0) {
    const q = prepareQuery(text.slice(colon + 1));
    for (const item of index) {
      if (!keys.has(item.pair.key)) {
        continue;
      }
      const keyRange: Range = [0, item.pair.key.length];
      const hit = q ? match(item.value, q) : { score: 0, ranges: [] };
      if (hit) {
        const offset = item.pair.key.length + 1;
        const ranges = hit.ranges.map(([start, end]): Range => [start + offset, end + offset]);
        results.push({ pair: item.pair, negated, score: hit.score, ranges: [keyRange, ...ranges] });
      }
    }
  } else {
    // Also reached when the text before `:` names no key, e.g. a URL value.
    const q = prepareQuery(text);
    for (const item of index) {
      const hit = q ? match(item.label, q) : { score: 0, ranges: [] };
      if (hit) {
        results.push({ pair: item.pair, negated, score: hit.score, ranges: hit.ranges });
      }
    }
  }
  results.sort(compareTagMatches);
  return withoutFallback(results).slice(0, limit);
}
