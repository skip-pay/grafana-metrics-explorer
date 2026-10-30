import React, { useEffect, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

import { Catalog, isNoiseKey, sortLabelKeys, TimeWindow } from '../../catalog';
import { MetricInfo, MetricKind, ResolvedMetric } from '../../model/types';
import { getEditorColors } from './styles';
import { preventDefault, unitText } from './utils';

export interface MetricPreviewProps {
  metric: MetricInfo;
  catalog?: Catalog;
  timeWindow?: TimeWindow;
  /** Click on a tag chip: group the query by that key. */
  onGroupBy?: (key: string) => void;
}

/** Chips shown before the `+N` overflow chip. */
const MAX_CHIPS = 12;
const RESOLVE_DELAY_MS = 150;
const COUNT_CONCURRENCY = 4;
/** The values API caps its answer, so a count at the cap is shown as `1000+`. */
const VALUES_CAP = 1000;
const MINUTE = 60_000;

const TYPE_LABELS: Record<MetricKind, string> = {
  gauge: 'Gauge',
  delta_counter: 'Count',
  cumulative_counter: 'Count',
  distribution: 'Distribution',
  cloudwatch: 'CloudWatch',
};

interface PreviewState {
  name: string;
  resolved?: ResolvedMetric;
  failed?: boolean;
  /** Value counts per tag key, filled in as they arrive. */
  counts: Record<string, number>;
  countsDone?: boolean;
}

/**
 * Side pane of the metric list: name, `unit │ type`, description and the tag keys with their value
 * counts in the time window, resolved lazily for the highlighted metric.
 */
export const MetricPreview = ({ metric, catalog, timeWindow, onGroupBy }: MetricPreviewProps) => {
  const styles = useStyles2(getStyles);
  const [state, setState] = useState<PreviewState>();
  const from = timeWindow ? Math.floor(timeWindow.from / MINUTE) * MINUTE : undefined;
  const to = timeWindow ? Math.ceil(timeWindow.to / MINUTE) * MINUTE : undefined;
  const name = metric.name;

  useEffect(() => {
    if (!catalog || from === undefined || to === undefined) {
      return;
    }
    let cancelled = false;
    const range = { from, to };
    const update = (fn: (prev: PreviewState) => PreviewState) =>
      !cancelled && setState((prev) => fn(prev?.name === name ? prev : { name, counts: {} }));
    // Debounced, so arrowing through the list does not resolve every row on the way.
    const timer = setTimeout(async () => {
      let resolved: ResolvedMetric;
      try {
        resolved = await catalog.resolve(name, range);
      } catch {
        update((prev) => ({ ...prev, failed: true }));
        return;
      }
      update((prev) => ({ ...prev, resolved }));
      const queue = sortLabelKeys(resolved.labelKeys.filter((k) => !isNoiseKey(k, resolved.name)));
      const worker = async () => {
        for (let key = queue.shift(); key !== undefined && !cancelled; key = queue.shift()) {
          const count = await catalog.labelValues(resolved, key, [], range).then(
            (values) => values.length,
            () => 0
          );
          update((prev) => ({ ...prev, counts: { ...prev.counts, [key]: count } }));
        }
      };
      await Promise.all(Array.from({ length: COUNT_CONCURRENCY }, worker));
      update((prev) => ({ ...prev, countsDone: true }));
    }, RESOLVE_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [catalog, name, from, to]);

  const current = state?.name === name ? state : undefined;
  const kind = current?.resolved?.kind ?? metric.kind;
  const unit = unitText(metric)?.toLowerCase();
  // Keys with values in the window, most values first; keys without any are hidden.
  const keys = Object.entries(current?.counts ?? {})
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = keys.slice(0, MAX_CHIPS);

  let tags: React.ReactNode = null;
  if (catalog) {
    if (current?.failed) {
      tags = <div className={styles.muted}>Tags unavailable</div>;
    } else if (shown.length === 0) {
      tags = <div className={styles.muted}>{current?.countsDone ? 'No tags in this time range' : 'Loading tags…'}</div>;
    } else {
      tags = (
        <div className={styles.chips}>
          {shown.map(([key, count]) => (
            <button
              key={key}
              type="button"
              className={styles.chip}
              disabled={!onGroupBy}
              onMouseDown={preventDefault}
              onClick={() => onGroupBy?.(key)}
            >
              {key} ({count >= VALUES_CAP ? `${VALUES_CAP}+` : count})
            </button>
          ))}
          {keys.length > MAX_CHIPS && <span className={styles.chip}>+{keys.length - MAX_CHIPS}</span>}
        </div>
      );
    }
  }

  return (
    <div className={styles.card} data-testid="metric-preview">
      <div className={styles.name}>{metric.name}</div>
      <div className={styles.meta}>
        {unit && (
          <>
            <span>
              <span className={styles.metaLabel}>unit:</span> {unit}
            </span>
            <span className={styles.metaSeparator} aria-hidden>
              │
            </span>
          </>
        )}
        <span>
          <span className={styles.metaLabel}>type:</span> {TYPE_LABELS[kind]}
        </span>
      </div>
      <div className={styles.scroll}>
        {metric.help && <div className={styles.help}>{metric.help}</div>}
        {tags}
      </div>
      {catalog && onGroupBy && <div className={styles.footer}>Click a tag to group by</div>}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    card: css({
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1),
      minHeight: 0,
      width: '100%',
      padding: theme.spacing(1.5),
    }),
    name: css({
      fontWeight: theme.typography.fontWeightBold,
      wordBreak: 'break-all',
    }),
    meta: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(1),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    metaLabel: css({
      color: theme.colors.text.link,
    }),
    metaSeparator: css({
      color: theme.colors.border.medium,
    }),
    scroll: css({
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1),
      minHeight: 0,
      overflowY: 'auto',
    }),
    help: css({
      color: theme.colors.text.primary,
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: theme.typography.bodySmall.lineHeight,
    }),
    chips: css({
      display: 'flex',
      flexWrap: 'wrap',
      gap: theme.spacing(0.5),
    }),
    chip: css({
      padding: theme.spacing(0, 0.5),
      border: 'none',
      borderRadius: 2,
      background: colors.tagChipBg,
      color: colors.tagChipText,
      font: 'inherit',
      fontSize: theme.typography.bodySmall.fontSize,
      lineHeight: '22px',
      cursor: 'pointer',
      '&:hover:not(:disabled)': { textDecoration: 'underline' },
      '&:disabled': { cursor: 'default' },
    }),
    muted: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    footer: css({
      marginTop: 'auto',
      paddingTop: theme.spacing(1),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
  };
};
