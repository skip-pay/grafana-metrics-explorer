import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { AbsoluteTimeRange, EventBusSrv, FieldConfigSource, GrafanaTheme2 } from '@grafana/data';
import { PanelRenderer } from '@grafana/runtime';
import { Alert, Icon, LoadingBar, PanelContext, PanelContextProvider, useStyles2 } from '@grafana/ui';

import { ChartModel, fitChart, fitTiles } from '../engine';
import { chartSeries, nextVisibleSeries, visibilityOverrides, VisibleSeries } from './seriesVisibility';
import { useElementHeight } from './useElementHeight';

/** Charts never get shorter than this; the area scrolls instead. */
export const MIN_CHART_HEIGHT = 200;
/** Split tiles are small multiples and may be shorter. */
export const MIN_TILE_HEIGHT = 140;
const PADDING = 8;
const GAP = 8;
const TILE_TITLE_HEIGHT = 22;

interface Props {
  title: string;
  charts: ChartModel[];
  /** One tile per split value instead of one chart. */
  split: boolean;
  /** The split tag key; tiles are titled by the tag value alone. */
  splitKey?: string | null;
  loading: boolean;
  errors: string[];
  warnings: string[];
  /** No query has a metric yet. */
  empty: boolean;
  width: number;
  height: number;
  timeZone: string;
  onChangeTimeRange: (range: AbsoluteTimeRange) => void;
}

export const ChartArea = ({
  title,
  charts,
  split,
  splitKey,
  loading,
  errors,
  warnings,
  empty,
  width,
  height,
  timeZone,
  onChangeTimeRange,
}: Props) => {
  const styles = useStyles2(getStyles);
  const [headerRef, headerHeight] = useElementHeight<HTMLDivElement>();
  const innerWidth = Math.max(0, width - 2 * PADDING - 2);
  const bodyHeight = Math.max(MIN_CHART_HEIGHT, height - headerHeight - 2 * PADDING - 2);
  const hasData = charts.some((c) => c.data.series.length > 0);
  const single = useMemo(
    () => (charts[0] ? fitChart(charts[0], innerWidth, bodyHeight) : undefined),
    [charts, innerWidth, bodyHeight]
  );

  let body: React.ReactNode = null;
  if (empty) {
    body = (
      <div className={styles.message}>
        <Icon name="chart-line" size="xxl" />
        <div>Pick a metric to start</div>
      </div>
    );
  } else if (!hasData) {
    body = !loading && errors.length === 0 ? <div className={styles.message}>No data</div> : null;
  } else if (split) {
    body = (
      <SplitGrid
        charts={charts}
        splitKey={splitKey}
        width={innerWidth}
        height={bodyHeight}
        timeZone={timeZone}
        onChangeTimeRange={onChangeTimeRange}
      />
    );
  } else {
    body = (
      <ChartView
        chart={single!}
        width={innerWidth}
        height={bodyHeight}
        timeZone={timeZone}
        onChangeTimeRange={onChangeTimeRange}
      />
    );
  }

  return (
    <div className={styles.frame}>
      {loading && (
        <div className={styles.loading}>
          <LoadingBar width={width} />
        </div>
      )}
      <div ref={headerRef} className={styles.header}>
        {title && !empty && (
          <div className={styles.title} title={title}>
            {title}
          </div>
        )}
        <Messages severity="error" messages={errors} />
        <Messages severity="warning" messages={warnings} />
      </div>
      <div className={styles.body} style={{ height: bodyHeight }}>
        {body}
      </div>
    </div>
  );
};

const Messages = ({ severity, messages }: { severity: 'error' | 'warning'; messages: string[] }) => {
  if (messages.length === 0) {
    return null;
  }
  const [first, ...rest] = messages;
  return (
    <Alert severity={severity} title={first} bottomSpacing={0} topSpacing={0}>
      {rest.length > 0 && (
        <ul>
          {rest.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
};

/** Columns of the split grid: 3, or 1–2 on narrow widths, never more than there are charts. */
export function splitColumns(width: number, count: number): number {
  const byWidth = width >= 840 ? 3 : width >= 520 ? 2 : 1;
  return Math.max(1, Math.min(byWidth, count));
}

/** `key:value` tile titles shown as the value alone. */
function tileTitle(title: string, key?: string | null): string {
  return key && title.startsWith(`${key}:`) ? title.slice(key.length + 1) : title;
}

interface GridProps {
  charts: ChartModel[];
  splitKey?: string | null;
  width: number;
  height: number;
  timeZone: string;
  onChangeTimeRange: (range: AbsoluteTimeRange) => void;
}

const SplitGrid = ({ charts, splitKey, width, height, timeZone, onChangeTimeRange }: GridProps) => {
  const styles = useStyles2(getStyles);
  const columns = splitColumns(width, charts.length);
  const rows = Math.ceil(charts.length / columns);
  const fitHeight = Math.floor((height - GAP * (rows - 1)) / rows) - TILE_TITLE_HEIGHT;
  const chartHeight = Math.max(MIN_TILE_HEIGHT, fitHeight);
  // Leave room for the scrollbar when the tiles do not fit.
  const usable = fitHeight < MIN_TILE_HEIGHT ? width - 16 : width;
  const tileWidth = Math.floor((usable - GAP * (columns - 1)) / columns);
  const fitted = useMemo(() => fitTiles(charts, tileWidth, chartHeight), [charts, tileWidth, chartHeight]);
  return (
    <div className={styles.grid} style={{ gridTemplateColumns: `repeat(${columns}, ${tileWidth}px)` }}>
      {fitted.map((chart) => (
        <div key={chart.title} className={styles.tile}>
          <div className={styles.tileHeader}>
            <span className={styles.tileTitle} title={chart.title}>
              {tileTitle(chart.title, splitKey)}
            </span>
          </div>
          <ChartView
            chart={chart}
            width={tileWidth}
            height={chartHeight}
            timeZone={timeZone}
            onChangeTimeRange={onChangeTimeRange}
          />
        </div>
      ))}
    </div>
  );
};

interface ChartViewProps {
  chart: ChartModel;
  width: number;
  height: number;
  timeZone: string;
  onChangeTimeRange: (range: AbsoluteTimeRange) => void;
}

/**
 * One chart in its own panel context, so legend clicks and hover events stay inside the explorer instead
 * of editing the dashboard panel. A legend click isolates a series, ctrl/cmd-click toggles it.
 */
const ChartView = ({ chart, width, height, timeZone, onChangeTimeRange }: ChartViewProps) => {
  const eventBus = useMemo(() => new EventBusSrv(), []);
  const frames = chart.data.series;
  const names = useMemo(() => chartSeries(frames).names, [frames]);
  const signature = names.join('\u0001');
  // Visibility is forgotten as soon as the chart shows a different set of series.
  const [visibility, setVisibility] = useState<{ signature: string; visible: VisibleSeries }>({
    signature: '',
    visible: null,
  });
  const visible = visibility.signature === signature ? visibility.visible : null;

  const fieldConfig = useMemo((): FieldConfigSource => {
    const extra = visibilityOverrides(visible, frames);
    return extra.length === 0
      ? chart.fieldConfig
      : { ...chart.fieldConfig, overrides: [...chart.fieldConfig.overrides, ...extra] };
  }, [chart.fieldConfig, visible, frames]);

  const context = useMemo(
    (): PanelContext => ({
      eventsScope: 'mx',
      eventBus,
      onToggleSeriesVisibility: (label, mode) =>
        setVisibility((prev) => ({
          signature,
          visible: nextVisibleSeries(prev.signature === signature ? prev.visible : null, label, mode, names),
        })),
    }),
    [eventBus, signature, names]
  );

  return (
    <PanelContextProvider value={context}>
      <PanelRenderer
        title=""
        pluginId={chart.pluginId}
        width={width}
        height={height}
        data={chart.data}
        options={chart.options}
        fieldConfig={fieldConfig}
        timeZone={timeZone}
        onChangeTimeRange={onChangeTimeRange}
      />
    </PanelContextProvider>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  frame: css({
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    padding: PADDING,
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.primary,
    overflow: 'hidden',
  }),
  loading: css({
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  }),
  header: css({
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(0.5),
    paddingBottom: theme.spacing(0.5),
    ':empty': { padding: 0 },
  }),
  title: css({
    fontSize: theme.typography.body.fontSize,
    lineHeight: '22px',
    color: theme.colors.text.primary,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
  body: css({
    position: 'relative',
    overflowX: 'hidden',
    overflowY: 'auto',
  }),
  message: css({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing(1),
    height: '100%',
    color: theme.colors.text.secondary,
    fontSize: theme.typography.h5.fontSize,
  }),
  grid: css({
    display: 'grid',
    gap: GAP,
  }),
  tile: css({
    minWidth: 0,
  }),
  tileHeader: css({
    display: 'flex',
    height: TILE_TITLE_HEIGHT,
    alignItems: 'center',
  }),
  tileTitle: css({
    maxWidth: '100%',
    padding: theme.spacing(0, 0.5),
    borderRadius: theme.shape.radius.default,
    background: theme.isDark ? 'rgba(80, 160, 230, 0.16)' : '#EAF6FC',
    color: theme.isDark ? theme.colors.text.primary : '#0C3472',
    fontSize: theme.typography.bodySmall.fontSize,
    lineHeight: '18px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  }),
});
