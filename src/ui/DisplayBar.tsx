import React, { useId } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Switch, useStyles2 } from '@grafana/ui';

import { TOPLIST_LIMITS } from '../model/defaults';
import { DisplayOptions, DisplayType, LineStyle, PaletteId, Reducer, Stroke, Visualization } from '../model/types';
import { getEditorColors } from './editor/styles';
import { MenuSelect, MenuSelectOption } from './MenuSelect';
import { PALETTE_MENU, PaletteSwatch } from './palettes';

interface Props {
  viz: Visualization;
  display: DisplayOptions;
  reducer: Reducer;
  toplistLimit: number;
  /** A visible query shows a counter, which reads better as bars. */
  counter?: boolean;
  onDisplayChange: (patch: Partial<DisplayOptions>) => void;
  onReducerChange: (reducer: Reducer) => void;
  onToplistLimitChange: (limit: number) => void;
}

const BARS_HINT = 'We recommend switching to a "Bars" display when using count-based metrics.';

const DISPLAY_OPTIONS: Array<MenuSelectOption<DisplayType>> = [
  { value: 'lines', label: 'Lines' },
  { value: 'areas', label: 'Areas' },
  { value: 'bars', label: 'Bars' },
];
const STYLE_OPTIONS: Array<MenuSelectOption<LineStyle>> = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];
const STROKE_OPTIONS: Array<MenuSelectOption<Stroke>> = [
  { value: 'normal', label: 'Normal' },
  { value: 'thin', label: 'Thin' },
  { value: 'thick', label: 'Thick' },
];
const ORDER_OPTIONS: Array<MenuSelectOption<DisplayOptions['orderBy']>> = [
  { value: 'tags', label: 'Tags' },
  { value: 'values', label: 'Values' },
];
const REDUCER_OPTIONS: Array<MenuSelectOption<Reducer>> = [
  { value: 'avg', label: 'avg', description: 'Average over the time range' },
  { value: 'sum', label: 'sum', description: 'Sum over the time range' },
  { value: 'min', label: 'min', description: 'Minimum over the time range' },
  { value: 'max', label: 'max', description: 'Maximum over the time range' },
  { value: 'last', label: 'last', description: 'Last value in the time range' },
];
const LIMIT_OPTIONS: Array<MenuSelectOption<number>> = TOPLIST_LIMITS.map((n) => ({ value: n, label: String(n) }));
const PALETTE_OPTIONS: Array<MenuSelectOption<PaletteId>> = PALETTE_MENU.map((p) => ({
  value: p.id,
  label: p.label,
  icon: <PaletteSwatch palette={p.id} />,
}));

/** Visualizations whose charts reduce each series to one value. */
const REDUCED: Visualization[] = ['queryvalue', 'table', 'toplist', 'barchart', 'piechart'];

/** Display options under the queries; the controls depend on the visualization. */
export const DisplayBar = ({
  viz,
  display,
  reducer,
  toplistLimit,
  counter,
  onDisplayChange,
  onReducerChange,
  onToplistLimitChange,
}: Props) => {
  const styles = useStyles2(getStyles);
  const id = useId();

  const palette = (
    <MenuSelect
      label="Color:"
      value={display.palette}
      options={PALETTE_OPTIONS}
      onChange={(p) => onDisplayChange({ palette: p })}
      menuWidth={320}
    />
  );

  if (viz !== 'timeseries') {
    return (
      <div className={styles.bar}>
        {REDUCED.includes(viz) && (
          <>
            <MenuSelect label="Aggregation:" value={reducer} options={REDUCER_OPTIONS} onChange={onReducerChange} />
            {viz === 'toplist' && (
              <MenuSelect label="Limit:" value={toplistLimit} options={LIMIT_OPTIONS} onChange={onToplistLimitChange} />
            )}
          </>
        )}
        {viz !== 'queryvalue' && (
          <>
            {REDUCED.includes(viz) && <span className={styles.divider} />}
            {palette}
          </>
        )}
      </div>
    );
  }

  const isLines = display.display === 'lines';
  const hint = isLines && counter;
  return (
    <div className={styles.bar}>
      {/* The caption stays outside, so only the value turns pink with the hint. */}
      <span className={styles.labelled}>
        <span className={styles.caption}>Display:</span>
        <MenuSelect
          ariaLabel="Display"
          value={display.display}
          options={DISPLAY_OPTIONS}
          onChange={(d) => onDisplayChange({ display: d })}
          className={hint ? styles.hint : undefined}
          tooltip={hint ? BARS_HINT : undefined}
        />
      </span>
      <span className={styles.switch}>
        <Switch
          id={`${id}-labels`}
          value={display.showLabels}
          disabled={!isLines}
          onChange={(e) => onDisplayChange({ showLabels: e.currentTarget.checked })}
        />
        <label htmlFor={`${id}-labels`}>Show labels</label>
      </span>
      <MenuSelect
        label="Style:"
        value={display.lineStyle}
        options={STYLE_OPTIONS}
        onChange={(s) => onDisplayChange({ lineStyle: s })}
      />
      <MenuSelect
        label="Stroke:"
        value={display.stroke}
        options={STROKE_OPTIONS}
        onChange={(s) => onDisplayChange({ stroke: s })}
      />
      <span className={styles.divider} />
      {palette}
      <span className={styles.divider} />
      <MenuSelect
        label="Order by:"
        value={display.orderBy}
        options={ORDER_OPTIONS}
        onChange={(o) => onDisplayChange({ orderBy: o })}
      />
      <span className={styles.switch}>
        <Switch
          id={`${id}-reverse`}
          value={display.reverse}
          onChange={(e) => onDisplayChange({ reverse: e.currentTarget.checked })}
        />
        <label htmlFor={`${id}-reverse`}>Reverse</label>
      </span>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    bar: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      columnGap: theme.spacing(1.5),
      rowGap: theme.spacing(0.5),
      minHeight: 37,
      padding: theme.spacing(0.5, 0),
      borderTop: `1px solid ${theme.colors.border.weak}`,
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    switch: css({
      display: 'inline-flex',
      alignItems: 'center',
      gap: theme.spacing(0.75),
      whiteSpace: 'nowrap',
      label: {
        cursor: 'pointer',
        color: theme.colors.text.primary,
      },
    }),
    divider: css({
      width: 1,
      height: 16,
      background: theme.colors.border.medium,
    }),
    labelled: css({
      display: 'inline-flex',
      alignItems: 'center',
      gap: theme.spacing(0.25),
    }),
    caption: css({
      color: theme.colors.text.secondary,
      paddingLeft: theme.spacing(0.5),
    }),
    hint: css({
      background: colors.hintBg,
      '&:hover': { background: colors.hintBg },
    }),
  };
};
