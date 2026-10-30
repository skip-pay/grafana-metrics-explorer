import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AbsoluteTimeRange, EventBus, GrafanaTheme2, TimeRange } from '@grafana/data';
import { TimeZone } from '@grafana/schema';
import { Alert, Button, useStyles2 } from '@grafana/ui';

import { Catalog, getCatalog, isNoiseKey, sortLabelKeys, TimeWindow } from '../catalog';
import { canAddQuery } from '../model/defaults';
import { MetricInfo, MetricQuery, ResolvedMetric } from '../model/types';
import { useExplorerData } from '../runner';
import { PanelOptions } from '../types';
import { ChartArea } from './ChartArea';
import { DisplayBar } from './DisplayBar';
import { FormulaRow, QueryRow } from './editor';
import { isCounterKind } from './editor/utils';
import { copyToClipboard, exploreUrl, promqlText } from './exportLinks';
import { PromqlDrawer } from './PromqlDrawer';
import { SplitBar } from './SplitBar';
import { FormulaPatch, formulaLetters, QueryPatch, useExplorerState } from './state';
import { TopBar } from './TopBar';
import { useElementHeight } from './useElementHeight';

export interface ExplorerProps {
  width: number;
  height: number;
  timeRange: TimeRange;
  timeZone: TimeZone;
  onChangeTimeRange: (timeRange: AbsoluteTimeRange) => void;
  options: PanelOptions;
  eventBus?: EventBus;
}

const DEFAULT_MAX_RANGE_HOURS = 24;
/** Autocomplete never reads more than this window, whatever the panel allows. */
const CATALOG_WINDOW_MS = 24 * 3600 * 1000;
const GAP = 8;

export const Explorer = ({ width, height, timeRange, timeZone, onChangeTimeRange, options }: ExplorerProps) => {
  const styles = useStyles2(getStyles);
  const { datasourceUid } = options;
  const maxRangeHours = options.maxRangeHours > 0 ? options.maxRangeHours : DEFAULT_MAX_RANGE_HOURS;
  const catalog = useMemo(() => getCatalog(datasourceUid), [datasourceUid]);
  const { metrics, loading: metricsLoading, error: metricsError } = useMetricList(catalog);
  const metricByName = useMemo(() => new Map(metrics.map((m) => [m.name, m])), [metrics]);
  const kindOf = useCallback((name: string) => metricByName.get(name)?.kind, [metricByName]);

  const explorer = useExplorerState(undefined, { kindOf, metrics: metricsLoading ? undefined : metrics });
  const { state, pending } = explorer;
  const contentWidth = Math.max(0, width - 2 * GAP);
  const data = useExplorerData(state, {
    datasourceUid,
    timeRange,
    timeZone,
    widthPx: contentWidth,
    maxRangeHours,
  });

  const from = timeRange.from.valueOf();
  const to = timeRange.to.valueOf();
  const timeWindow = useMemo<TimeWindow>(() => ({ from: Math.max(from, to - CATALOG_WINDOW_MS), to }), [from, to]);
  const letters = useMemo(() => state.queries.map((q) => q.letter), [state.queries]);
  const splitKeys = useMemo(
    () => splitKeyOptions(state.queries.map((q) => data.resolved[q.metric])),
    [state.queries, data.resolved]
  );

  const kindOfQuery = (q: MetricQuery) => data.resolved[q.metric]?.kind ?? metricByName.get(q.metric)?.kind;
  // The Bars hint is for counts; a rate reads fine as a line.
  const counterShown = state.queries.some(
    (q) => !q.hidden && isCounterKind(kindOfQuery(q)) && !q.functions.some((f) => f.name === 'as_rate')
  );
  const usedLetters = useMemo(
    () => new Set(state.formulas.flatMap((f) => formulaLetters(f.expression))),
    [state.formulas]
  );
  const deleteBlocked = (q: MetricQuery): string | undefined =>
    state.queries.length <= 1
      ? 'The only query cannot be deleted'
      : usedLetters.has(q.letter)
        ? 'Query used in other formulas'
        : undefined;

  const formulaErrors = useMemo(() => {
    const errors: Record<string, string | undefined> = {};
    for (const f of data.plan?.formulas ?? []) {
      errors[f.id] = data.rowMessages[f.refLetter]?.join(' ');
    }
    return errors;
  }, [data.plan, data.rowMessages]);

  const [showPromql, setShowPromql] = useState(false);
  const [toolbarRef, toolbarHeight] = useElementHeight<HTMLDivElement>();
  const [drawerRef, drawerHeight] = useElementHeight<HTMLDivElement>();
  const chartHeight = height - 2 * GAP - toolbarHeight - GAP - (showPromql ? drawerHeight + GAP : 0);

  const promql = promqlText(data.plan);
  const explore = useMemo(
    () => exploreUrl(data.plan, datasourceUid, timeRange.raw),
    [data.plan, datasourceUid, timeRange.raw]
  );
  const empty = !pending && state.queries.every((q) => q.metric === '');
  const warnings = metricsError ? [metricsError, ...data.warnings] : data.warnings;

  return (
    <div className={styles.root} style={{ width, height }}>
      <div ref={toolbarRef} className={styles.toolbar}>
        <TopBar
          viz={state.viz}
          onVizChange={explorer.setViz}
          showPromql={showPromql}
          onTogglePromql={() => setShowPromql((s) => !s)}
        />
        {explorer.warning && (
          <Alert severity="warning" title={explorer.warning} onRemove={explorer.dismissWarning} bottomSpacing={0} />
        )}
        {/* Rows of a readable link appear once it is built; until then they would show the placeholder state. */}
        {!pending && (
          <div className={styles.rows}>
            {state.queries.map((query) => (
              <QueryRow
                key={query.id}
                query={query}
                metricInfo={metricByName.get(query.metric)}
                resolved={data.resolved[query.metric]}
                metrics={metrics}
                metricsLoading={metricsLoading}
                catalog={catalog}
                timeWindow={timeWindow}
                deleteBlocked={deleteBlocked(query)}
                onChange={(patch: QueryPatch) => explorer.updateQuery(query.id, patch)}
                onRemove={() => explorer.removeQuery(query.id)}
                warnings={data.rowMessages[query.letter]}
              />
            ))}
            {state.formulas.map((formula) => (
              <FormulaRow
                key={formula.id}
                formula={formula}
                letters={letters}
                onChange={(patch: FormulaPatch) => explorer.updateFormula(formula.id, patch)}
                onRemove={() => explorer.removeFormula(formula.id)}
                error={formulaErrors[formula.id]}
              />
            ))}
          </div>
        )}
        <div className={styles.addRow}>
          <Button
            size="sm"
            variant="secondary"
            fill="outline"
            icon="plus"
            disabled={!canAddQuery(state)}
            onClick={explorer.addQuery}
          >
            Add Query
          </Button>
          <Button size="sm" variant="secondary" fill="outline" icon="plus" onClick={explorer.addFormula}>
            Add Formula
          </Button>
        </div>
        <DisplayBar
          viz={state.viz}
          display={state.display}
          reducer={state.reducer}
          toplistLimit={state.toplistLimit}
          counter={counterShown}
          onDisplayChange={explorer.setDisplay}
          onReducerChange={explorer.setReducer}
          onToplistLimitChange={explorer.setToplistLimit}
        />
        <SplitBar
          split={state.split}
          keys={state.viz === 'timeseries' ? splitKeys : undefined}
          onChange={explorer.setSplit}
          onCopyLink={() => copyToClipboard(window.location.href, 'Link')}
          onCopyPromql={promql ? () => copyToClipboard(promql, 'PromQL') : undefined}
          exploreUrl={explore}
        />
      </div>
      <ChartArea
        title={data.plan?.title ?? ''}
        charts={data.charts}
        split={state.viz === 'timeseries' && state.split.key !== null}
        splitKey={state.split.key}
        loading={data.loading || pending}
        errors={data.errors}
        warnings={warnings}
        empty={empty}
        width={contentWidth}
        height={chartHeight}
        timeZone={timeZone}
        onChangeTimeRange={onChangeTimeRange}
      />
      {showPromql && (
        <div ref={drawerRef}>
          <PromqlDrawer plan={data.plan} />
        </div>
      )}
    </div>
  );
};

/** The metric catalogue for the pickers, loaded once per datasource. */
function useMetricList(catalog: Catalog): { metrics: MetricInfo[]; loading: boolean; error?: string } {
  const [list, setList] = useState<{ catalog: Catalog; metrics: MetricInfo[]; error?: string } | null>(null);
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => catalog.listMetrics())
      .then(
        (metrics) => active && setList({ catalog, metrics }),
        (e: unknown) =>
          active &&
          setList({
            catalog,
            metrics: [],
            error: `The metric list could not be loaded: ${e instanceof Error ? e.message : String(e)}`,
          })
      );
    return () => {
      active = false;
    };
  }, [catalog]);
  return list?.catalog === catalog ? { ...list, loading: false } : { metrics: NO_METRICS, loading: true };
}

const NO_METRICS: MetricInfo[] = [];

/** Tag keys the chart can be split by: those of every queried metric without the noise keys, useful ones first. */
function splitKeyOptions(resolved: Array<ResolvedMetric | undefined>): string[] {
  const keys = new Set<string>();
  for (const metric of resolved) {
    for (const key of metric?.labelKeys ?? []) {
      if (metric && !safeIsNoise(key, metric.name)) {
        keys.add(key);
      }
    }
  }
  return sortLabelKeys([...keys]);
}

function safeIsNoise(key: string, metric: string): boolean {
  try {
    return isNoiseKey(key, metric);
  } catch {
    return false;
  }
}

const getStyles = (theme: GrafanaTheme2) => ({
  root: css({
    display: 'flex',
    flexDirection: 'column',
    gap: GAP,
    padding: GAP,
    overflow: 'auto',
    color: theme.colors.text.primary,
  }),
  toolbar: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
    flexShrink: 0,
  }),
  rows: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
  }),
  addRow: css({
    display: 'flex',
    gap: theme.spacing(1),
  }),
});
