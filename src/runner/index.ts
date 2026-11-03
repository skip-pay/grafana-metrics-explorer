import { useEffect, useMemo, useRef, useState } from 'react';
import { CoreApp, DataQueryError, PanelData, TimeRange } from '@grafana/data';
import { createQueryRunner } from '@grafana/runtime';
import type { DataQuery } from '@grafana/schema';
import { useTheme2 } from '@grafana/ui';

import { getCatalog, TimeWindow } from '../catalog';
import { compile, CompiledPlan, GROUP_LIMIT, MAX_SLICE_SEC, sliceSec, topLevelFilters } from '../compile';
import { buildCharts, ChartModel, evaluate, EvaluateResult } from '../engine';
import { ExplorerState, MetricInfo, ResolvedMetric, TagFilter } from '../model/types';
import { REQUEST_TIMEOUT_MS, RunOutcome, SequentialRunner } from './sequential';

export { MAX_QUERIES_PER_REQUEST, REQUEST_TIMEOUT_MS, SequentialRunner } from './sequential';

/** Edits are debounced; time-range changes and the first run go out at once. */
export const DEBOUNCE_MS = 400;
/** The catalogue (label keys, temporality) is read over at most this window. */
export const CATALOG_WINDOW_MS = 24 * 3600 * 1000;
/** Group estimates are keyed by the catalogue window snapped to this, so a moving "now" reuses them. */
const ESTIMATE_SNAP_MS = 5 * 60_000;

export interface ExplorerData {
  loading: boolean;
  plan?: CompiledPlan;
  result?: EvaluateResult;
  charts: ChartModel[];
  errors: string[];
  /** Warnings that belong to no single row. */
  warnings: string[];
  /** Warnings and errors per row, keyed by query letter or formula ref (`f1`, `f2`…). */
  rowMessages: Record<string, string[]>;
  resolved: Record<string, ResolvedMetric | undefined>;
}

export interface ExplorerDataArgs {
  datasourceUid: string;
  timeRange: TimeRange;
  timeZone: string;
  widthPx: number;
  maxRangeHours: number;
}

/** Everything a run depends on besides the time range; its JSON form is the run key. */
interface RunSpec {
  uid: string;
  timeZone: string;
  stepSec: number;
  maxDataPoints: number;
  queries: Array<{ refId: string; expr: string; interval: string }>;
}

interface RunState {
  /** Key of the latest run. */
  key: string;
  loading: boolean;
  timedOut: boolean;
  /** Latest finished data and the key and plan it was requested with. */
  data?: PanelData;
  dataKey?: string;
  dataPlan?: CompiledPlan;
}

/** Resolves, compiles, runs and evaluates the explorer state; re-runs on state and time-range changes. */
export function useExplorerData(state: ExplorerState, args: ExplorerDataArgs): ExplorerData {
  const { datasourceUid, timeRange, timeZone, widthPx, maxRangeHours } = args;
  const theme = useTheme2();
  const from = timeRange.from.valueOf();
  const to = timeRange.to.valueOf();
  const range = useMemo(() => ({ from, to }), [from, to]);
  const catalogWindow = useMemo(() => ({ from: Math.max(from, to - CATALOG_WINDOW_MS), to }), [from, to]);

  const names = useMemo(
    () => [...new Set(state.queries.map((q) => q.metric).filter((m) => m !== ''))],
    [state.queries]
  );
  const resolution = useResolvedMetrics(datasourceUid, names, catalogWindow);

  const compiled = useMemo((): { plan?: CompiledPlan; error?: string } => {
    try {
      return { plan: compile(state, { range, widthPx, metrics: resolution.metrics, maxRangeHours }) };
    } catch (e) {
      return { error: `The queries could not be compiled: ${message(e)}` };
    }
  }, [state, range, widthPx, resolution.metrics, maxRangeHours]);
  const plan = compiled.plan;
  const groups = useGroupEstimates(datasourceUid, plan, state, resolution.resolved, catalogWindow);

  const runKey = useMemo(() => {
    if (!plan || !resolution.ready || !groups.ready || names.length === 0 || plan.errors.length > 0) {
      return null;
    }
    // A grouped query with more groups than the limit runs capped to the top groups.
    const queries = plan.queries
      .filter((q) => !q.skip && q.expr !== '')
      .map((q) => ({
        refId: q.refId,
        expr: q.cappedExpr !== undefined && (groups.counts[q.letter] ?? 0) > GROUP_LIMIT ? q.cappedExpr : q.expr,
        interval: `${q.stepSec}s`,
      }));
    if (queries.length === 0) {
      return null;
    }
    const rangeSec = Math.max(1, (range.to - range.from) / 1000);
    const spec: RunSpec = {
      uid: datasourceUid,
      timeZone,
      stepSec: plan.stepSec,
      maxDataPoints: Math.ceil(rangeSec / plan.stepSec) + 2,
      queries,
    };
    return JSON.stringify(spec);
  }, [plan, resolution.ready, groups, names.length, range, datasourceUid, timeZone]);
  // Waiting for metric resolution or group estimates counts as loading: a run follows right after.
  const resolving = names.length > 0 && !resolution.ready;
  const estimating = Boolean(plan) && resolution.ready && !groups.ready;

  const [run, setRun] = useState<RunState | null>(null);
  const runner = useRef<SequentialRunner<CompiledPlan | undefined> | null>(null);
  const planRef = useRef(plan);
  const timeRangeRef = useRef(timeRange);
  /** `from-to` of the last run: a run for the same range is an edit and gets debounced. */
  const lastRange = useRef<string | null>(null);

  useEffect(() => {
    const seq = new SequentialRunner<CompiledPlan | undefined>(createQueryRunner(), (outcome) =>
      setRun((prev) => applyOutcome(prev, outcome))
    );
    runner.current = seq;
    return () => {
      seq.destroy();
      runner.current = null;
    };
  }, []);

  useEffect(() => {
    planRef.current = plan;
    timeRangeRef.current = timeRange;
  }, [plan, timeRange]);

  // Keyed on the range values, not the object: a refresh of a relative range moves them.
  useEffect(() => {
    const seq = runner.current;
    if (!seq) {
      return;
    }
    if (runKey === null) {
      seq.cancel();
      return;
    }
    const rangeKey = `${from}-${to}`;
    const delay = lastRange.current === rangeKey ? DEBOUNCE_MS : 0;
    const timer = setTimeout(() => {
      lastRange.current = rangeKey;
      const spec: RunSpec = JSON.parse(runKey);
      seq.run(runKey, planRef.current, toRunnerOptions(spec, timeRangeRef.current), sliceSec(spec.stepSec) * 1000);
    }, delay);
    return () => clearTimeout(timer);
  }, [runKey, from, to]);

  // The data of an older run is shown (with its own plan) until the current one arrives.
  const evaluated = useMemo(() => {
    if ((runKey === null && !estimating) || !run?.data) {
      return undefined;
    }
    const current = run.dataKey === runKey;
    const evalPlan = current ? plan : run.dataPlan;
    if (!evalPlan) {
      return undefined;
    }
    try {
      const result = evaluate(evalPlan, run.data, state, resolution.metrics);
      const charts = buildCharts(state, evalPlan, result, theme, resolution.metrics);
      return { result, charts, error: undefined };
    } catch (e) {
      // A stale result may not fit the edited state; only the current one reports errors.
      return current
        ? { result: undefined, charts: [], error: `The results could not be processed: ${message(e)}` }
        : undefined;
    }
  }, [runKey, estimating, run, plan, state, resolution.metrics, theme]);

  const loading = resolving || estimating || (runKey !== null && (run?.key !== runKey || run.loading));

  const errors = useMemo(() => {
    const list: string[] = [];
    if (compiled.error) {
      list.push(compiled.error);
    }
    list.push(...(plan?.errors ?? []));
    if (runKey !== null && run?.key === runKey && !run.loading) {
      if (run.timedOut) {
        list.push(
          `A request took longer than ${REQUEST_TIMEOUT_MS / 1000} s and was cancelled. Try a shorter time range or a narrower filter.`
        );
      } else if (run.dataKey === runKey) {
        list.push(...queryErrors(run.data?.errors ?? []));
      }
    }
    if (evaluated?.error) {
      list.push(evaluated.error);
    }
    return dedupe(list);
  }, [compiled.error, plan, runKey, run, evaluated]);

  // Messages about one row go under that row; the rest is shown above the chart.
  const messages = useMemo(() => {
    const rows: Record<string, string[]> = {};
    const global: string[] = [];
    if (!resolution.ready) {
      return { rows, global };
    }
    const add = (ref: string, text: string) => {
      rows[ref] = dedupe([...(rows[ref] ?? []), text]);
    };
    for (const q of state.queries) {
      const failure = resolution.failed[q.metric];
      if (failure) {
        add(q.letter, `Metric \`${q.metric}\` could not be loaded: ${failure}`);
      }
    }
    // A row without a metric needs no message; the chart area asks for one.
    const picked = new Set(state.queries.filter((q) => q.metric !== '').map((q) => q.letter));
    const sliced = plan !== undefined && range.to - range.from > sliceSec(plan.stepSec) * 1000;
    for (const q of plan?.queries ?? []) {
      if (!picked.has(q.letter)) {
        continue;
      }
      for (const w of q.skip ? [q.skip, ...q.warnings] : q.warnings) {
        add(q.letter, w);
      }
      const count = groups.counts[q.letter];
      if (!q.skip && q.cappedExpr !== undefined && count !== undefined && count > GROUP_LIMIT) {
        const over = sliced ? ` (ranked over the last ${MAX_SLICE_SEC / 3600} h)` : '';
        add(q.letter, `Showing the top ${GROUP_LIMIT} of ≈${count.toLocaleString('en-US')} groups${over}`);
      }
    }
    global.push(...(evaluated?.result?.warnings ?? []));
    const refs = new Set([...state.queries.map((q) => q.letter), ...(plan?.formulas ?? []).map((f) => f.refLetter)]);
    for (const [ref, err] of Object.entries(evaluated?.result?.rowErrors ?? {})) {
      if (refs.has(ref)) {
        add(ref, err);
      } else {
        global.push(`${ref}: ${err}`);
      }
    }
    return { rows, global: dedupe(global) };
  }, [resolution, state.queries, plan, range, groups, evaluated]);

  return {
    loading,
    plan,
    result: evaluated?.result,
    charts: evaluated?.charts ?? [],
    errors,
    warnings: messages.global,
    rowMessages: messages.rows,
    resolved: resolution.resolved,
  };
}

function applyOutcome(prev: RunState | null, outcome: RunOutcome<CompiledPlan | undefined>): RunState {
  const kept = { data: prev?.data, dataKey: prev?.dataKey, dataPlan: prev?.dataPlan };
  const next: RunState = { key: outcome.key, loading: outcome.loading, timedOut: Boolean(outcome.timedOut), ...kept };
  if (outcome.data) {
    next.data = outcome.data;
    next.dataKey = outcome.key;
    next.dataPlan = outcome.tag;
  }
  return next;
}

function toRunnerOptions(spec: RunSpec, timeRange: TimeRange) {
  const datasource = { type: 'prometheus', uid: spec.uid };
  const queries = spec.queries.map((q): DataQuery & Record<string, unknown> => ({
    refId: q.refId,
    datasource,
    expr: q.expr,
    range: true,
    instant: false,
    interval: q.interval,
    legendFormat: '__auto',
  }));
  return {
    datasource,
    queries,
    timeRange,
    timezone: spec.timeZone,
    maxDataPoints: spec.maxDataPoints,
    minInterval: `${spec.stepSec}s`,
    app: CoreApp.Dashboard,
  };
}

function queryErrors(errors: DataQueryError[]): string[] {
  return errors.map((e) => {
    const text = e.message || e.data?.message || e.data?.error || e.statusText || 'The query failed.';
    return e.refId ? `${e.refId}: ${text}` : text;
  });
}

interface Resolution {
  uid: string;
  resolved: Record<string, ResolvedMetric | undefined>;
  /** Catalogue info of metrics whose resolution failed. */
  fallback: Record<string, MetricInfo | undefined>;
  failed: Record<string, string>;
}

/**
 * Resolves every queried metric once per datasource; the results stay in the hook's state, and `ready` is
 * true when every metric is resolved or failed.
 */
function useResolvedMetrics(datasourceUid: string, names: string[], window: TimeWindow) {
  const [stored, setStored] = useState<Resolution>(() => emptyResolution(datasourceUid));
  const pending = useRef(new Set<string>());
  const res = useMemo(
    () => (stored.uid === datasourceUid ? stored : emptyResolution(datasourceUid)),
    [stored, datasourceUid]
  );

  useEffect(() => {
    const catalog = getCatalog(datasourceUid);
    const merge = (patch: (r: Resolution) => Partial<Resolution>) =>
      setStored((r) => {
        const base = r.uid === datasourceUid ? r : emptyResolution(datasourceUid);
        return { ...base, ...patch(base) };
      });
    for (const name of names) {
      const id = `${datasourceUid}\u0000${name}`;
      if (name in res.resolved || name in res.failed || pending.current.has(id)) {
        continue;
      }
      pending.current.add(id);
      Promise.resolve()
        .then(() => catalog.resolve(name, window))
        .then(
          (metric) => merge((r) => ({ resolved: { ...r.resolved, [name]: metric } })),
          async (e: unknown) => {
            const info = await Promise.resolve()
              .then(() => catalog.getMetric(name))
              .catch(() => undefined);
            merge((r) => ({ failed: { ...r.failed, [name]: message(e) }, fallback: { ...r.fallback, [name]: info } }));
          }
        )
        .finally(() => pending.current.delete(id));
    }
  }, [datasourceUid, names, window, res]);

  return useMemo(() => {
    const metrics: Record<string, ResolvedMetric | MetricInfo | undefined> = {};
    for (const name of names) {
      metrics[name] = res.resolved[name] ?? res.fallback[name];
    }
    const ready = names.every((n) => n in res.resolved || n in res.failed);
    return { metrics, ready, resolved: res.resolved, failed: res.failed };
  }, [names, res]);
}

interface EstimateRequest {
  id: string;
  letter: string;
  metric: ResolvedMetric;
  keys: string[];
  filters: TagFilter[];
}

/**
 * Estimated group counts of the grouped queries by letter: the product of the value counts of their group keys
 * under their top-level filter terms (catalogue calls, cached there), an upper bound when the filter has groups.
 * `ready` once every estimate is known or has failed; a failed one leaves the query uncapped.
 */
function useGroupEstimates(
  datasourceUid: string,
  plan: CompiledPlan | undefined,
  state: ExplorerState,
  resolved: Record<string, ResolvedMetric | undefined>,
  window: TimeWindow
): { counts: Record<string, number>; ready: boolean } {
  const [estimates, setEstimates] = useState<Record<string, number | null>>({});
  const pending = useRef(new Set<string>());
  /** Ids of the latest requests; a late result never prunes a newer estimate. */
  const wanted = useRef(new Set<string>());

  const requests = useMemo(() => {
    const byLetter = new Map(state.queries.map((q) => [q.letter, q]));
    const snapped = [Math.floor(window.from / ESTIMATE_SNAP_MS), Math.ceil(window.to / ESTIMATE_SNAP_MS)];
    const list: EstimateRequest[] = [];
    for (const cq of plan?.queries ?? []) {
      const query = byLetter.get(cq.letter);
      const metric = query ? resolved[query.metric] : undefined;
      if (cq.skip || cq.cappedExpr === undefined || !query || !metric) {
        continue;
      }
      const filters = topLevelFilters(query.filters);
      const id = JSON.stringify([datasourceUid, metric.name, cq.groupBy, filters, snapped]);
      list.push({ id, letter: cq.letter, metric, keys: cq.groupBy, filters });
    }
    return list;
  }, [datasourceUid, plan, state.queries, resolved, window]);

  useEffect(() => {
    const catalog = getCatalog(datasourceUid);
    wanted.current = new Set(requests.map((r) => r.id));
    const settle = (id: string, count: number | null) =>
      setEstimates((prev) => {
        // Only estimates still asked for are kept.
        const next: Record<string, number | null> = { [id]: count };
        for (const [key, value] of Object.entries(prev)) {
          if (wanted.current.has(key)) {
            next[key] = value;
          }
        }
        return next;
      });
    for (const request of requests) {
      if (request.id in estimates || pending.current.has(request.id)) {
        continue;
      }
      pending.current.add(request.id);
      Promise.all(request.keys.map((key) => catalog.labelValues(request.metric, key, request.filters, window)))
        .then(
          (lists) =>
            settle(
              request.id,
              lists.reduce((product, values) => product * values.length, 1)
            ),
          () => settle(request.id, null)
        )
        .finally(() => pending.current.delete(request.id));
    }
  }, [datasourceUid, requests, estimates, window]);

  return useMemo(() => {
    const counts: Record<string, number> = {};
    for (const request of requests) {
      const count = estimates[request.id];
      if (typeof count === 'number') {
        counts[request.letter] = count;
      }
    }
    return { counts, ready: requests.every((r) => r.id in estimates) };
  }, [requests, estimates]);
}

function emptyResolution(uid: string): Resolution {
  return { uid, resolved: {}, fallback: {}, failed: {} };
}

function message(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  if (typeof e === 'object' && e !== null) {
    const o = e as { message?: unknown; data?: { message?: unknown } };
    const text = o.data?.message ?? o.message;
    if (typeof text === 'string') {
      return text;
    }
  }
  return String(e);
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
