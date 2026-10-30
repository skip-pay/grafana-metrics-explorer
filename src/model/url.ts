import { UrlQueryMap } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import { defaultState, LETTERS, newId, nextLetter, SPLIT_LIMITS, TOPLIST_LIMITS } from './defaults';
import {
  DisplayOptions,
  DisplayType,
  ExplorerState,
  FilterGroup,
  FilterItem,
  FilterOp,
  FormulaQuery,
  FunctionCall,
  LineStyle,
  MetricQuery,
  PaletteId,
  Reducer,
  SpaceAgg,
  SplitOptions,
  Stroke,
  TagFilter,
  Visualization,
} from './types';

export const URL_PARAM = 'mx';
export const STORAGE_KEY = 'skippay-metricsexplorer:last';
/** Readable link parameters; `mx` wins over them, and once the state is built they are replaced by `mx`. */
export const LINK_PARAMS = ['q', 'f', 'viz', 'display', 'split'] as const;

export type DecodeResult = { ok: true; state: ExplorerState } | { ok: false; error: string };
/** The values of each readable link parameter present, in URL order. */
export type LinkParams = Partial<Record<(typeof LINK_PARAMS)[number], string[]>>;

export interface InitialState {
  state: ExplorerState;
  warning?: string;
  /** Readable link parameters to build the state from once the metric catalogue has loaded. */
  link?: LinkParams;
}

export function encodeState(state: ExplorerState): string {
  return JSON.stringify(state);
}

/**
 * Parses and validates a serialised state. A missing field takes its default; a field that is present
 * but invalid rejects the whole state.
 */
export function decodeState(text: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  try {
    return { ok: true, state: toState(raw) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** The state in the current URL, or null when the URL has none. */
export function readUrlState(): DecodeResult | null {
  const value = locationService.getSearchObject()[URL_PARAM];
  return typeof value === 'string' && value !== '' ? decodeState(value) : null;
}

/** The readable link parameters in the URL, or null when it has none. */
export function readLinkParams(search: UrlQueryMap = locationService.getSearchObject()): LinkParams | null {
  const link: LinkParams = {};
  for (const key of LINK_PARAMS.filter((k) => k in search)) {
    const value = search[key];
    // Grafana's URL parser turns numbers and true/false into their types, and a badly encoded value into undefined.
    link[key] = (Array.isArray(value) ? value : [value]).map((v) => (v === undefined || v === null ? '' : String(v)));
  }
  return Object.keys(link).length > 0 ? link : null;
}

/** The `mx` state, else the readable link parameters, else the last state used in this browser, else the default. */
export function readInitialState(): InitialState {
  const fromUrl = readUrlState();
  if (fromUrl) {
    return fromUrl.ok
      ? { state: fromUrl.state }
      : { state: defaultState(), warning: `The explorer state in the link is invalid (${fromUrl.error}).` };
  }
  const link = readLinkParams();
  if (link) {
    return { state: defaultState(), link };
  }
  const stored = readStorage();
  const fromStorage = stored ? decodeState(stored) : null;
  return { state: fromStorage?.ok ? fromStorage.state : defaultState() };
}

/** Writes the state to `mx` in place (replace, not push) and drops the readable link parameters it supersedes. */
export function writeState(state: ExplorerState): void {
  const text = encodeState(state);
  const search = locationService.getSearchObject();
  const stale = LINK_PARAMS.filter((key) => key in search);
  // Skipping an unchanged value keeps location listeners from looping on our own writes.
  if (search[URL_PARAM] !== text || stale.length > 0) {
    locationService.partial({ [URL_PARAM]: text, ...Object.fromEntries(stale.map((key) => [key, null])) }, true);
  }
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // Storage may be full or blocked; the URL still holds the state.
  }
}

function readStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// Exhaustive value sets of the model's string unions; the Record type makes a missing member a compile error.
export const VISUALIZATIONS = keys<Visualization>({
  timeseries: 1,
  queryvalue: 1,
  table: 1,
  heatmap: 1,
  distribution: 1,
  toplist: 1,
  barchart: 1,
  piechart: 1,
});
const SPACE_AGGS = keys<SpaceAgg>({
  avg: 1,
  sum: 1,
  min: 1,
  max: 1,
  count: 1,
  p50: 1,
  p75: 1,
  p90: 1,
  p95: 1,
  p99: 1,
});
const REDUCERS = keys<Reducer>({ avg: 1, sum: 1, min: 1, max: 1, last: 1 });
const FILTER_OPS = keys<FilterOp>({ eq: 1, neq: 1, in: 1, not_in: 1 });
const GROUP_OPS = keys<FilterGroup['op']>({ and: 1, or: 1 });
export const DISPLAY_TYPES = keys<DisplayType>({ lines: 1, bars: 1, areas: 1 });
const LINE_STYLES = keys<LineStyle>({ solid: 1, dashed: 1, dotted: 1 });
const STROKES = keys<Stroke>({ thin: 1, normal: 1, thick: 1 });
const PALETTES = keys<PaletteId>({
  consistent: 1,
  classic: 1,
  cool: 1,
  warm: 1,
  purple: 1,
  orange: 1,
  gray: 1,
  red: 1,
  green: 1,
  blue: 1,
  vivid: 1,
});
const SPLIT_ORDERS = keys<SplitOptions['order']>({ top: 1, bottom: 1 });
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function keys<T extends string>(record: Record<T, 1>): readonly T[] {
  return Object.keys(record) as T[];
}

type Obj = Record<string, unknown>;

function toState(raw: unknown): ExplorerState {
  const o = obj(raw, 'state');
  if (o.v !== 1) {
    throw new Error(`unsupported version ${JSON.stringify(o.v)}`);
  }
  const defaults = defaultState();
  return {
    v: 1,
    viz: oneOf(o.viz, VISUALIZATIONS, defaults.viz, 'viz'),
    queries: toQueries(o.queries),
    formulas: toFormulas(o.formulas),
    display: toDisplay(o.display, defaults.display),
    split: toSplit(o.split, defaults.split),
    reducer: oneOf(o.reducer, REDUCERS, defaults.reducer, 'reducer'),
    toplistLimit: oneOf(o.toplistLimit, TOPLIST_LIMITS, defaults.toplistLimit, 'toplistLimit'),
  };
}

function toQueries(raw: unknown): MetricQuery[] {
  if (raw === undefined) {
    return defaultState().queries;
  }
  const items = arr(raw, 'queries');
  if (items.length === 0) {
    throw new Error('queries: at least one query is required');
  }
  const queries: MetricQuery[] = [];
  const ids = new Set<string>();
  // Explicit letters first, so a query without one gets a letter no other query claims.
  const letters = new Set<string>();
  for (const [i, item] of items.entries()) {
    const letter = obj(item, `queries[${i}]`).letter;
    if (letter === undefined) {
      continue;
    }
    if (typeof letter !== 'string' || !/^[a-z]$/.test(letter) || letters.has(letter)) {
      throw new Error(`queries[${i}].letter: invalid or duplicate letter ${JSON.stringify(letter)}`);
    }
    letters.add(letter);
  }
  for (const [i, item] of items.entries()) {
    const path = `queries[${i}]`;
    const o = obj(item, path);
    if (o.kind !== undefined && o.kind !== 'query') {
      throw new Error(`${path}.kind: expected "query"`);
    }
    let letter = o.letter as string | undefined;
    if (letter === undefined) {
      const taken = [...letters].map((l) => ({ letter: l }));
      // After `z`, any letter no other query has.
      letter = nextLetter(taken) ?? [...LETTERS].find((l) => !letters.has(l));
      if (!letter) {
        throw new Error('queries: too many queries');
      }
      letters.add(letter);
    }
    const query: MetricQuery = {
      kind: 'query',
      id: uniqueId(o.id, ids, `${path}.id`),
      letter,
      hidden: bool(o.hidden, false, `${path}.hidden`),
      metric: str(o.metric, '', `${path}.metric`),
      filters: flatten('and', list(o.filters, `${path}.filters`, toFilterItem)),
      spaceAgg: oneOf(o.spaceAgg, SPACE_AGGS, 'avg', `${path}.spaceAgg`),
      groupBy: list(o.groupBy, `${path}.groupBy`, (v, p) => str(v, undefined, p)),
      functions: toFunctions(o.functions, `${path}.functions`),
    };
    const alias = optStr(o.alias, `${path}.alias`);
    const color = optStr(o.color, `${path}.color`);
    if (color !== undefined && !HEX_COLOR.test(color) && !PALETTES.includes(color as PaletteId)) {
      throw new Error(`${path}.color: ${JSON.stringify(color)} is neither a hex colour nor a palette`);
    }
    queries.push({ ...query, ...(alias !== undefined ? { alias } : {}), ...(color !== undefined ? { color } : {}) });
  }
  return queries;
}

/**
 * A term, or a group when it has `items`. Groups are shaped as the text form parses them, so their text means the
 * same: a group of one item is that item, and groups of the parent's operator are flattened into it.
 */
function toFilterItem(raw: unknown, path: string): FilterItem {
  const o = obj(raw, path);
  if (o.items === undefined) {
    return toFilter(o, path);
  }
  const op = oneOf(o.op, GROUP_OPS, 'and', `${path}.op`);
  const negated = bool(o.negated, false, `${path}.negated`);
  const items = flatten(op, list(o.items, `${path}.items`, toFilterItem));
  if (items.length === 0) {
    throw new Error(`${path}.items: a group takes at least one item`);
  }
  if (items.length === 1 && !negated) {
    return items[0];
  }
  return negated ? { op, negated, items } : { op, items };
}

/** The items with the groups of `op` that are not negated replaced by their items. */
function flatten(op: FilterGroup['op'], items: FilterItem[]): FilterItem[] {
  return items.flatMap((item) => ('items' in item && item.op === op && !item.negated ? item.items : [item]));
}

function toFilter(o: Obj, path: string): TagFilter {
  const key = str(o.key, undefined, `${path}.key`);
  const op = oneOf(o.op, FILTER_OPS, 'eq', `${path}.op`);
  const values = list(o.values, `${path}.values`, (v, p) => str(v, undefined, p));
  const single = op === 'eq' || op === 'neq';
  if (key === '' || (single ? values.length !== 1 : values.length === 0)) {
    throw new Error(`${path}: ${single ? 'eq/neq take exactly one value' : 'in/not_in take at least one value'}`);
  }
  return { key, op, values };
}

function toFunctions(raw: unknown, path: string): FunctionCall[] {
  const ids = new Set<string>();
  return list(raw, path, (item, p) => {
    const o = obj(item, p);
    const name = str(o.name, undefined, `${p}.name`);
    const args = list(o.args, `${p}.args`, (a, ap) => {
      if ((typeof a === 'number' && Number.isFinite(a)) || typeof a === 'string') {
        return a;
      }
      throw new Error(`${ap}: expected a number or a string`);
    });
    return { id: uniqueId(o.id, ids, `${p}.id`), name, args };
  });
}

function toFormulas(raw: unknown): FormulaQuery[] {
  const ids = new Set<string>();
  return list(raw, 'formulas', (item, path) => {
    const o = obj(item, path);
    if (o.kind !== undefined && o.kind !== 'formula') {
      throw new Error(`${path}.kind: expected "formula"`);
    }
    const formula: FormulaQuery = {
      kind: 'formula',
      id: uniqueId(o.id, ids, `${path}.id`),
      expression: str(o.expression, '', `${path}.expression`),
      hidden: bool(o.hidden, false, `${path}.hidden`),
    };
    const alias = optStr(o.alias, `${path}.alias`);
    return alias === undefined ? formula : { ...formula, alias };
  });
}

function toDisplay(raw: unknown, d: DisplayOptions): DisplayOptions {
  if (raw === undefined) {
    return d;
  }
  const o = obj(raw, 'display');
  return {
    display: oneOf(o.display, DISPLAY_TYPES, d.display, 'display.display'),
    showLabels: bool(o.showLabels, d.showLabels, 'display.showLabels'),
    lineStyle: oneOf(o.lineStyle, LINE_STYLES, d.lineStyle, 'display.lineStyle'),
    stroke: oneOf(o.stroke, STROKES, d.stroke, 'display.stroke'),
    palette: oneOf(o.palette, PALETTES, d.palette, 'display.palette'),
    orderBy: oneOf(o.orderBy, ['tags', 'values'] as const, d.orderBy, 'display.orderBy'),
    reverse: bool(o.reverse, d.reverse, 'display.reverse'),
  };
}

function toSplit(raw: unknown, d: SplitOptions): SplitOptions {
  if (raw === undefined) {
    return d;
  }
  const o = obj(raw, 'split');
  const key = o.key === undefined || o.key === null ? null : str(o.key, undefined, 'split.key');
  return {
    key: key === '' ? null : key,
    limit: oneOf(o.limit, SPLIT_LIMITS, d.limit, 'split.limit'),
    order: oneOf(o.order, SPLIT_ORDERS, d.order, 'split.order'),
    sortBy: oneOf(o.sortBy, REDUCERS, d.sortBy, 'split.sortBy'),
  };
}

function uniqueId(raw: unknown, seen: Set<string>, path: string): string {
  let id = raw === undefined ? newId() : str(raw, undefined, path);
  while (id === '' || seen.has(id)) {
    id = newId();
  }
  seen.add(id);
  return id;
}

function obj(raw: unknown, path: string): Obj {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: expected an object`);
  }
  return raw as Obj;
}

function arr(raw: unknown, path: string): unknown[] {
  if (!Array.isArray(raw)) {
    throw new Error(`${path}: expected an array`);
  }
  return raw;
}

function list<T>(raw: unknown, path: string, item: (raw: unknown, path: string) => T): T[] {
  return raw === undefined ? [] : arr(raw, path).map((v, i) => item(v, `${path}[${i}]`));
}

function str(raw: unknown, fallback: string | undefined, path: string): string {
  if (raw === undefined && fallback !== undefined) {
    return fallback;
  }
  if (typeof raw !== 'string') {
    throw new Error(`${path}: expected a string`);
  }
  return raw;
}

function optStr(raw: unknown, path: string): string | undefined {
  return raw === undefined ? undefined : str(raw, undefined, path);
}

function bool(raw: unknown, fallback: boolean, path: string): boolean {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== 'boolean') {
    throw new Error(`${path}: expected true or false`);
  }
  return raw;
}

function oneOf<T extends string | number>(raw: unknown, allowed: readonly T[], fallback: T, path: string): T {
  if (raw === undefined) {
    return fallback;
  }
  if (!allowed.includes(raw as T)) {
    throw new Error(`${path}: ${JSON.stringify(raw)} is not one of ${allowed.join(', ')}`);
  }
  return raw as T;
}
