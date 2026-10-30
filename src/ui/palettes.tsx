import React from 'react';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';

import { PaletteId } from '../model/types';

export interface PaletteMenuEntry {
  id: PaletteId;
  label: string;
  /** Three colours for the menu swatch. */
  swatch: [string, string, string];
}

/** The Color menu, in menu order. */
export const PALETTE_MENU: PaletteMenuEntry[] = [
  { id: 'consistent', label: 'Consistent', swatch: ['#EB364B', '#F99D02', '#41C464'] },
  { id: 'classic', label: 'Classic', swatch: ['#3598EC', '#7EA9FA', '#FCD779'] },
  { id: 'cool', label: 'Cool', swatch: ['#084081', '#54B4CD', '#CFECCA'] },
  { id: 'warm', label: 'Warm', swatch: ['#800026', '#F9562C', '#FEDC7F'] },
  { id: 'purple', label: 'Purple', swatch: ['#442699', '#966FEF', '#DDCBFF'] },
  { id: 'orange', label: 'Orange', swatch: ['#F17A12', '#FFB53C', '#FFECAC'] },
  { id: 'gray', label: 'Gray', swatch: ['#4C4C57', '#9095A2', '#D8DEE3'] },
  { id: 'red', label: 'Red', swatch: ['#8B0404', '#F84C4C', '#FFC1C1'] },
  { id: 'green', label: 'Green', swatch: ['#195530', '#3FB264', '#97F1AE'] },
  { id: 'blue', label: 'Blue', swatch: ['#13328E', '#4884ED', '#A7D0FF'] },
  { id: 'vivid', label: 'Vivid', swatch: ['#00C9FF', '#84D253', '#8081F2'] },
];

/** Palettes a grouped query can override its colours with (no hashing or 16-colour palette). */
export const PALETTE_OVERRIDES: PaletteId[] = [
  'classic',
  'cool',
  'warm',
  'purple',
  'orange',
  'gray',
  'red',
  'green',
  'blue',
];

/** Rows of the colour grid an ungrouped query can pick its line colour from. */
export const COLOR_OVERRIDES: Array<{ label: string; colors: string[] }> = [
  { label: 'Classic', colors: ['#94CBFF', '#3598EC', '#D7C3FF', '#7463E1', '#FFCD1E', '#FFEF95'] },
  {
    label: 'Purple',
    colors: ['#DDCBFF', '#CAB0FE', '#B695FB', '#A17BF4', '#8B63E9', '#744DD6', '#5C38BC', '#442699'],
  },
  { label: 'Cool', colors: ['#CFECCA', '#B3E1BC', '#8FD3BE', '#67C0CA', '#43A5CA', '#2384BA', '#0C63A4', '#084081'] },
  {
    label: 'Green',
    colors: ['#97F1AE', '#77E395', '#5DD27F', '#48BD6C', '#38A65C', '#2B8C4D', '#21713E', '#195530'],
  },
  { label: 'Warm', colors: ['#FEDC7F', '#FEBF5B', '#FD9D43', '#FC7034', '#F23D26', '#D91620', '#B40325', '#800026'] },
  {
    label: 'Orange',
    colors: ['#FFECAC', '#FFDE83', '#FFCE62', '#FFBD47', '#FFAC32', '#FE9B23', '#F98A19', '#F17A12'],
  },
  { label: 'Gray', colors: ['#D8DEE3', '#C2CAD1', '#AEB5BF', '#9AA0AC', '#868B98', '#737683', '#5F616D', '#4C4C57'] },
  {
    label: 'Vivid',
    colors: [
      '#8081F2',
      '#F04F94',
      '#00D77D',
      '#F69458',
      '#DB67DB',
      '#5698FF',
      '#EA6444',
      '#84D253',
      '#FFC02C',
      '#A991E1',
      '#00E2E4',
      '#EE7689',
      '#2FCDA9',
      '#FFDE0C',
      '#E198EB',
      '#00C9FF',
    ],
  },
];

export function paletteEntry(id: PaletteId): PaletteMenuEntry {
  return PALETTE_MENU.find((p) => p.id === id) ?? PALETTE_MENU[1];
}

/** Three vertical colour bars, the palette's mini swatch. */
export const PaletteSwatch = ({ palette }: { palette: PaletteId }) => {
  const styles = useStyles2(getStyles);
  return (
    <span className={styles.swatch} aria-hidden>
      {paletteEntry(palette).swatch.map((c, i) => (
        <span key={i} className={styles.cell} style={{ background: c }} />
      ))}
    </span>
  );
};

const getStyles = () => ({
  swatch: css({
    display: 'inline-flex',
    gap: 1,
    borderRadius: 3,
    overflow: 'hidden',
    verticalAlign: 'middle',
    flexShrink: 0,
  }),
  cell: css({
    display: 'inline-block',
    width: 6,
    height: 13,
  }),
});
