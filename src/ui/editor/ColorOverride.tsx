import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { PaletteId } from '../../model/types';
import { COLOR_OVERRIDES, PALETTE_OVERRIDES, paletteEntry, PaletteSwatch } from '../palettes';
import { Popover } from './Popover';
import { getEditorColors, getEditorStyles } from './styles';

export interface ColorOverrideProps {
  /** Hex colour (ungrouped) or palette id (grouped); undefined follows the chart palette. */
  color?: string;
  /** Grouped queries pick a palette, ungrouped ones a single colour. */
  grouped: boolean;
  onChange: (color: string | undefined) => void;
}

/** The row's palette icon: a "Color Override" swatch grid, or a "Palette Override" list for grouped queries. */
export const ColorOverride = ({ color, grouped, onChange }: ColorOverrideProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const palette = PALETTE_OVERRIDES.find((p) => p === color);
  const hex = color?.startsWith('#') ? color.toUpperCase() : undefined;
  const set = grouped ? palette !== undefined : hex !== undefined;
  const pick = (value: string | undefined) => {
    setOpen(false);
    onChange(value);
  };

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={cx(editorStyles.iconButton, (open || set) && editorStyles.iconButtonActive)}
        aria-label={grouped ? 'Palette override' : 'Color override'}
        aria-expanded={open}
        title={grouped ? 'Palette override' : 'Color override'}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            // Keep Grafana's global Esc (leave kiosk or panel view) out of it while the popover is open.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Icon name="palette" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} keepFocus testId="color-override">
        <div
          className={styles.panel}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className={styles.header}>
            <span>{grouped ? 'Palette Override' : 'Color Override'}</span>
            <button type="button" className={styles.reset} onClick={() => pick(undefined)}>
              Reset
            </button>
          </div>
          {grouped ? (
            <div role="menu" aria-label="Palette override">
              {PALETTE_OVERRIDES.map((id: PaletteId) => (
                <div
                  key={id}
                  role="menuitemradio"
                  aria-checked={id === palette}
                  className={cx(styles.palette, id === palette && styles.paletteActive)}
                  onClick={() => pick(id)}
                >
                  <PaletteSwatch palette={id} />
                  {paletteEntry(id).label}
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.grid}>
              {COLOR_OVERRIDES.map((row) => (
                <React.Fragment key={row.label}>
                  <span className={styles.rowLabel}>{row.label}</span>
                  <span className={styles.swatches}>
                    {row.colors.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={cx(styles.swatch, c === hex && styles.swatchActive)}
                        style={{ background: c }}
                        aria-label={`${row.label} ${c}`}
                        aria-pressed={c === hex}
                        onClick={() => pick(c)}
                      />
                    ))}
                  </span>
                </React.Fragment>
              ))}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
};

const SWATCH = 20;

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    panel: css({
      padding: theme.spacing(1.5, 2),
      overflowY: 'auto',
    }),
    header: css({
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: theme.spacing(3),
      marginBottom: theme.spacing(1.5),
      fontSize: theme.typography.h5.fontSize,
    }),
    reset: css({
      border: 'none',
      background: 'transparent',
      color: theme.colors.text.link,
      cursor: 'pointer',
      padding: 0,
      '&:hover': { textDecoration: 'underline' },
    }),
    palette: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      minHeight: 28,
      padding: theme.spacing(0.25, 0.5),
      cursor: 'pointer',
      '&:hover': { background: theme.colors.action.hover },
    }),
    paletteActive: css({
      background: colors.active,
      color: colors.activeText,
      '&:hover': { background: colors.active },
    }),
    grid: css({
      display: 'grid',
      gridTemplateColumns: 'max-content max-content',
      columnGap: theme.spacing(2),
      rowGap: theme.spacing(0.75),
      alignItems: 'start',
    }),
    rowLabel: css({
      lineHeight: `${SWATCH}px`,
      color: theme.colors.text.secondary,
    }),
    swatches: css({
      display: 'grid',
      gridTemplateColumns: `repeat(8, ${SWATCH}px)`,
      gap: 4,
    }),
    swatch: css({
      width: SWATCH,
      height: SWATCH,
      padding: 0,
      border: 'none',
      borderRadius: 2,
      cursor: 'pointer',
      '&:hover': { outline: `2px solid ${theme.colors.text.secondary}`, outlineOffset: 1 },
    }),
    swatchActive: css({
      outline: `2px solid ${theme.colors.text.primary}`,
      outlineOffset: 1,
    }),
  };
};
