import React, { useId, useMemo, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

import { Catalog, searchMetrics, TimeWindow } from '../../catalog';
import { MetricInfo } from '../../model/types';
import { Highlight } from './Highlight';
import { MetricPreview } from './MetricPreview';
import { Popover } from './Popover';
import { getEditorColors, ROW_HEIGHT } from './styles';
import { SuggestionItem, SuggestionList } from './SuggestionList';

export interface MetricPickerProps {
  value: string;
  metrics: MetricInfo[];
  loading?: boolean;
  onChange: (name: string) => void;
  /** With a catalogue and a time window the preview card lazily shows the tag keys. */
  catalog?: Catalog;
  timeWindow?: TimeWindow;
  /** Click on a tag chip of the preview: pick that metric (if another) and group by the key. */
  onGroupBy?: (metric: string, key: string) => void;
}

const LIMIT = 100;
/** Names shown above the current metric when the list opens on it. */
const BROWSE_BEFORE = 10;
// Wide enough for most CloudWatch names, which differ only at the end.
const LIST_WIDTH = 460;
const PREVIEW_WIDTH = 360;

interface Row {
  metric: MetricInfo;
  ranges: Array<[number, number]>;
}

/** The metric field: a search input with a ranked, highlighted name list and a preview pane on the right. */
export const MetricPicker = ({
  value,
  metrics,
  loading,
  onChange,
  catalog,
  timeWindow,
  onGroupBy,
}: MetricPickerProps) => {
  const styles = useStyles2(getStyles);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  // Until the user types, the list browses the names around the current metric.
  const [typed, setTyped] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();

  // By name, with the hundreds of CloudWatch streams after the application metrics.
  const sorted = useMemo(
    () =>
      [...metrics].sort(
        (a, b) =>
          Number(a.kind === 'cloudwatch') - Number(b.kind === 'cloudwatch') ||
          (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
      ),
    [metrics]
  );
  const rows = useMemo(
    () => (!open ? [] : typed ? findRows(text, sorted) : browseRows(value, sorted)),
    [open, typed, text, value, sorted]
  );
  const activeIndex = rows.length === 0 ? -1 : Math.min(active, rows.length - 1);
  const activeMetric = activeIndex >= 0 ? rows[activeIndex].metric : undefined;

  const start = () => {
    setText(value);
    setTyped(false);
    setActive(Math.max(0, sorted.findIndex((m) => m.name === value) - browseStart(value, sorted)));
    setOpen(true);
  };

  const accept = (name: string) => {
    setOpen(false);
    if (name !== '' && name !== value) {
      onChange(name);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (!open) {
          start();
        } else if (rows.length > 0) {
          setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
        }
        return;
      case 'Enter':
        e.preventDefault();
        if (!open) {
          start();
        } else if (activeMetric) {
          accept(activeMetric.name);
        } else {
          // Not in the catalogue (e.g. it failed to load): take the typed name as is.
          accept(text.trim());
        }
        return;
      case 'Tab':
        if (open && activeMetric && typed && text.trim() !== '') {
          accept(activeMetric.name);
        } else {
          setOpen(false);
        }
        return;
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
    }
  };

  const items: SuggestionItem[] = rows.map((row) => ({
    id: row.metric.name,
    content: (
      <Highlight className={styles.rowName} text={row.metric.name} ranges={row.ranges} title={row.metric.name} />
    ),
  }));

  return (
    <>
      <div ref={setAnchor} className={cx(styles.field, open && styles.fieldOpen)} data-value={open ? text : value}>
        <input
          className={styles.input}
          size={1}
          value={open ? text : value}
          placeholder="Search metrics…"
          role="combobox"
          aria-label="Metric"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onMouseDown={(e) => {
            // Focus by click selects the whole name (a plain click would drop the selection on mouseup).
            if (document.activeElement !== e.currentTarget) {
              e.preventDefault();
              e.currentTarget.focus();
            } else if (!open) {
              start();
            }
          }}
          onFocus={(e) => {
            start();
            e.currentTarget.select();
          }}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setText(e.target.value);
            setTyped(true);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <Popover anchor={anchor} open={open} keepFocus width={LIST_WIDTH + PREVIEW_WIDTH} testId="metric-picker-popover">
        <div className={styles.body}>
          <SuggestionList
            id={listId}
            className={styles.list}
            items={items}
            active={activeIndex}
            onHover={setActive}
            onPick={(index) => accept(rows[index].metric.name)}
            variant="strong"
            emptyText={
              <div className={styles.empty}>
                {loading && metrics.length === 0 ? 'Loading metrics…' : 'No matching results'}
              </div>
            }
          />
          {activeMetric && (
            <div className={styles.preview}>
              <MetricPreview
                metric={activeMetric}
                catalog={catalog}
                timeWindow={timeWindow}
                onGroupBy={
                  onGroupBy &&
                  ((key) => {
                    setOpen(false);
                    onGroupBy(activeMetric.name, key);
                  })
                }
              />
            </div>
          )}
        </div>
      </Popover>
    </>
  );
};

/** Empty text: the first names alphabetically; otherwise the ranked search. */
function findRows(text: string, sorted: MetricInfo[]): Row[] {
  const query = text.trim();
  if (query === '') {
    return browseRows('', sorted);
  }
  return searchMetrics(query, sorted, LIMIT).map((match) => ({ metric: match.metric, ranges: match.ranges }));
}

/** The current metric's alphabetical neighbourhood, or the first names without one. */
function browseRows(value: string, sorted: MetricInfo[]): Row[] {
  const start = browseStart(value, sorted);
  return sorted.slice(start, start + LIMIT).map((metric) => ({ metric, ranges: [] }));
}

function browseStart(value: string, sorted: MetricInfo[]): number {
  const index = value === '' ? -1 : sorted.findIndex((m) => m.name === value);
  return index < 0 ? 0 : Math.max(0, Math.min(index - BROWSE_BEFORE, sorted.length - LIMIT));
}

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    field: css({
      display: 'inline-grid',
      height: ROW_HEIGHT,
      minWidth: 200,
      maxWidth: 480,
      border: `1px solid ${theme.colors.border.medium}`,
      background: colors.metricBg,
      position: 'relative',
      // Grows with the name: the hidden copy sizes the grid cell the input shares.
      '&::after': {
        content: 'attr(data-value) " "',
        visibility: 'hidden',
        whiteSpace: 'pre',
        overflow: 'hidden',
        gridArea: '1 / 1',
        padding: theme.spacing(0, 1),
        font: 'inherit',
      },
      '&:focus-within': {
        borderColor: theme.colors.primary.border,
        zIndex: 1,
      },
    }),
    fieldOpen: css({
      borderColor: theme.colors.primary.border,
    }),
    input: css({
      gridArea: '1 / 1',
      width: '100%',
      minWidth: 0,
      padding: theme.spacing(0, 1),
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: theme.colors.text.primary,
      font: 'inherit',
      textOverflow: 'ellipsis',
      '&::placeholder': { color: theme.colors.text.secondary, opacity: 1 },
    }),
    body: css({
      display: 'flex',
      minHeight: 0,
      flex: '1 1 auto',
    }),
    list: css({
      flex: `1 1 ${LIST_WIDTH}px`,
      minWidth: 0,
    }),
    preview: css({
      display: 'flex',
      flex: `0 0 ${PREVIEW_WIDTH}px`,
      minHeight: 0,
      borderLeft: `1px solid ${theme.colors.border.weak}`,
      [`@media (max-width: ${LIST_WIDTH + PREVIEW_WIDTH}px)`]: { display: 'none' },
    }),
    rowName: css({
      display: 'block',
      lineHeight: '26px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    empty: css({
      padding: theme.spacing(2),
      textAlign: 'center',
      color: theme.colors.text.secondary,
    }),
  };
};
