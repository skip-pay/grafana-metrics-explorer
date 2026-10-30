import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { locationService } from '@grafana/runtime';

import { newFormula, newId, newQuery, nextLetter, withMetric } from '../model/defaults';
import {
  DisplayOptions,
  ExplorerState,
  FormulaQuery,
  MetricInfo,
  MetricKind,
  MetricQuery,
  Reducer,
  SplitOptions,
  Visualization,
} from '../model/types';
import {
  decodeState,
  encodeState,
  InitialState,
  LinkParams,
  readInitialState,
  readLinkParams,
  URL_PARAM,
  writeState,
} from '../model/url';
import { stateFromLink } from './deepLink';

/** Kind of a metric by name, used to apply the kind's defaults when a query's metric changes. */
export type KindLookup = (metric: string) => MetricKind | undefined;

export type QueryPatch = Partial<Omit<MetricQuery, 'kind' | 'id' | 'letter'>>;
export type FormulaPatch = Partial<Omit<FormulaQuery, 'kind' | 'id'>>;

// Pure state transitions; the hook below wraps them.

export function updateQuery(state: ExplorerState, id: string, patch: QueryPatch, kindOf?: KindLookup): ExplorerState {
  return mapQueries(state, id, (query) => {
    const { metric, ...rest } = stripIdentity(patch);
    const next: MetricQuery = { ...query, ...rest };
    if (metric === undefined || metric === query.metric) {
      return next;
    }
    const kind = metric === '' ? undefined : kindOf?.(metric);
    return kind ? withMetric(next, metric, kind) : { ...next, metric };
  });
}

/** Adds a copy of the last query under the next letter, visible, so it can be varied. */
export function addQuery(state: ExplorerState): ExplorerState {
  if (!nextLetter(state.queries)) {
    return state;
  }
  const fresh = newQuery(state);
  const last = state.queries[state.queries.length - 1];
  const query: MetricQuery = last
    ? {
        ...last,
        id: fresh.id,
        letter: fresh.letter,
        hidden: false,
        functions: last.functions.map((f) => ({ ...f, id: newId() })),
      }
    : fresh;
  return { ...state, queries: [...state.queries, query] };
}

/** Removes a query; the last remaining query cannot be removed. */
export function removeQuery(state: ExplorerState, id: string): ExplorerState {
  if (state.queries.length <= 1 || !state.queries.some((q) => q.id === id)) {
    return state;
  }
  return { ...state, queries: state.queries.filter((q) => q.id !== id) };
}

/**
 * Query letters an expression references: one-letter identifiers that are not function calls, quoted strings
 * left out. Works on half-typed expressions too, so a query stays protected while its formula is being edited.
 */
export function formulaLetters(expression: string): string[] {
  const unquoted = expression.replace(/'[^']*'?|"[^"]*"?/g, ' ');
  const letters = new Set<string>();
  for (const m of unquoted.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?=\s*(\()?)/g)) {
    if (m[1] === undefined && /^[a-z]$/.test(m[0])) {
      letters.add(m[0]);
    }
  }
  return [...letters];
}

export function addFormula(state: ExplorerState): ExplorerState {
  return { ...state, formulas: [...state.formulas, newFormula(state)] };
}

export function updateFormula(state: ExplorerState, id: string, patch: FormulaPatch): ExplorerState {
  const { kind, id: _id, ...rest } = patch as Partial<FormulaQuery>;
  return {
    ...state,
    formulas: state.formulas.map((f) => (f.id === id ? { ...f, ...rest } : f)),
  };
}

export function removeFormula(state: ExplorerState, id: string): ExplorerState {
  return { ...state, formulas: state.formulas.filter((f) => f.id !== id) };
}

export function setViz(state: ExplorerState, viz: Visualization): ExplorerState {
  return state.viz === viz ? state : { ...state, viz };
}

export function setDisplay(state: ExplorerState, patch: Partial<DisplayOptions>): ExplorerState {
  return { ...state, display: { ...state.display, ...patch } };
}

export function setSplit(state: ExplorerState, patch: Partial<SplitOptions>): ExplorerState {
  return { ...state, split: { ...state.split, ...patch } };
}

export function setReducer(state: ExplorerState, reducer: Reducer): ExplorerState {
  return state.reducer === reducer ? state : { ...state, reducer };
}

export function setToplistLimit(state: ExplorerState, toplistLimit: number): ExplorerState {
  return state.toplistLimit === toplistLimit ? state : { ...state, toplistLimit };
}

function mapQueries(state: ExplorerState, id: string, fn: (q: MetricQuery) => MetricQuery): ExplorerState {
  if (!state.queries.some((q) => q.id === id)) {
    return state;
  }
  return { ...state, queries: state.queries.map((q) => (q.id === id ? fn(q) : q)) };
}

/** Id, kind and letter belong to the row and are never patched. */
function stripIdentity(patch: QueryPatch): QueryPatch {
  const { kind, id, letter, ...rest } = patch as Partial<MetricQuery>;
  return rest;
}

export interface ExplorerStateApi {
  state: ExplorerState;
  /** Set when the state in the link was invalid and the default was used instead, or link parameters were ignored. */
  warning?: string;
  /** The link's readable parameters wait for the metric catalogue; `state` is a placeholder until then. */
  pending: boolean;
  dismissWarning: () => void;
  updateQuery: (id: string, patch: QueryPatch) => void;
  addQuery: () => void;
  removeQuery: (id: string) => void;
  addFormula: () => void;
  updateFormula: (id: string, patch: FormulaPatch) => void;
  removeFormula: (id: string) => void;
  setViz: (viz: Visualization) => void;
  setDisplay: (patch: Partial<DisplayOptions>) => void;
  setSplit: (patch: Partial<SplitOptions>) => void;
  setReducer: (reducer: Reducer) => void;
  setToplistLimit: (limit: number) => void;
  replaceState: (state: ExplorerState) => void;
}

/**
 * Explorer state kept in the URL parameter `mx`: every change is written back, and a URL change we did
 * not write ourselves (back/forward, a pasted link) replaces the state. A link with readable parameters
 * instead of `mx` is built into a state once `metrics` (the catalogue, undefined while loading) is there.
 */
export function useExplorerState(
  initial: () => InitialState = readInitialState,
  options: { kindOf?: KindLookup; metrics?: MetricInfo[] } = {}
): ExplorerStateApi {
  const [init] = useState(initial);
  const [state, setState] = useState<ExplorerState>(init.state);
  const [warning, setWarning] = useState<string | undefined>(init.warning);
  const [link, setLink] = useState<LinkParams | undefined>(init.link);
  const lastWritten = useRef<string | null>(null);
  const kindOf = useRef<KindLookup | undefined>(options.kindOf);
  const { metrics } = options;

  useEffect(() => {
    kindOf.current = options.kindOf;
  }, [options.kindOf]);

  // Set during render rather than in an effect, so the placeholder never renders once the catalogue is there.
  if (link && metrics) {
    const built = stateFromLink(link, metrics);
    setState(built.state);
    setWarning(built.warning);
    setLink(undefined);
  }

  useEffect(() => {
    // The URL keeps the link until its state is built; the first write then replaces it with `mx`.
    if (link) {
      return;
    }
    lastWritten.current = encodeState(state);
    writeState(state);
  }, [state, link]);

  useEffect(() => {
    const sub = locationService.getLocationObservable().subscribe(() => {
      const value = locationService.getSearchObject()[URL_PARAM];
      if (typeof value !== 'string' || value === '') {
        const next = readLinkParams();
        if (next) {
          setLink(next);
        }
        return;
      }
      if (value === lastWritten.current) {
        return;
      }
      const decoded = decodeState(value);
      if (decoded.ok) {
        lastWritten.current = value;
        setState(decoded.state);
        setWarning(undefined);
        setLink(undefined);
      } else {
        setWarning(`The explorer state in the link is invalid (${decoded.error}).`);
      }
    });
    return () => sub.unsubscribe();
  }, []);

  const update = useCallback(
    <A extends unknown[]>(fn: (s: ExplorerState, ...args: A) => ExplorerState) =>
      (...args: A) =>
        setState((s) => fn(s, ...args)),
    []
  );

  const actions = useMemo(
    () => ({
      updateQuery: (id: string, patch: QueryPatch) => setState((s) => updateQuery(s, id, patch, kindOf.current)),
      addQuery: update(addQuery),
      removeQuery: update(removeQuery),
      addFormula: update(addFormula),
      updateFormula: update(updateFormula),
      removeFormula: update(removeFormula),
      setViz: update(setViz),
      setDisplay: update(setDisplay),
      setSplit: update(setSplit),
      setReducer: update(setReducer),
      setToplistLimit: update(setToplistLimit),
      replaceState: (next: ExplorerState) => setState(next),
      dismissWarning: () => setWarning(undefined),
    }),
    [update]
  );

  return { state, warning, pending: link !== undefined, ...actions };
}
