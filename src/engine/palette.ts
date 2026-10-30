import { DisplayOptions, PaletteId, Series } from '../model/types';
import { meanOrLowest } from './series';

export interface Palette {
  label: string;
  /** Classic and Vivid cycle through these; Consistent hashes into them; the others interpolate light → dark. */
  colors: string[];
  /** Three colours for the palette menu. */
  swatch: string[];
}

const CLASSIC = ['#3598ec', '#5d4ebe', '#efc328', '#7ea9fa', '#a58dff', '#fcd779'];
const VIVID = [
  '#8081f2',
  '#f04f94',
  '#00d77d',
  '#f69458',
  '#db67db',
  '#5698ff',
  '#ea6444',
  '#84d253',
  '#ffc02c',
  '#a991e1',
  '#00e2e4',
  '#ee7689',
  '#2fcda9',
  '#ffde0c',
  '#e198eb',
  '#00c9ff',
];

/** A single-hue or multi-hue scale, light → dark; the swatch shows dark, middle and light. */
function scale(label: string, colors: string[]): Palette {
  return { label, colors, swatch: [colors[colors.length - 1], interpolate(colors, 0.5), colors[0]] };
}

/** In menu order. */
export const PALETTES: Record<PaletteId, Palette> = {
  consistent: { label: 'Consistent', colors: VIVID, swatch: ['#eb364b', '#f99d02', '#41c464'] },
  classic: { label: 'Classic', colors: CLASSIC, swatch: ['#3598ec', '#7ea9fa', '#fcd779'] },
  cool: scale('Cool', ['#cfecca', '#b3e1bc', '#8fd3be', '#67c0ca', '#43a5ca', '#2384ba', '#0c63a4', '#084081']),
  warm: scale('Warm', ['#fedc7f', '#febf5b', '#fd9d43', '#fc7034', '#f23d26', '#d91620', '#b40325', '#800026']),
  purple: scale('Purple', ['#ddcbff', '#cab0fe', '#b695fb', '#a17bf4', '#8b63e9', '#744dd6', '#5c38bc', '#442699']),
  orange: scale('Orange', ['#ffecac', '#ffde83', '#ffce62', '#ffbd47', '#ffac32', '#fe9b23', '#f98a19', '#f17a12']),
  gray: scale('Gray', ['#d8dee3', '#c2cad1', '#aeb5bf', '#9aa0ac', '#868b98', '#737683', '#5f616d', '#4c4c57']),
  red: scale('Red', ['#ffc1c1', '#fda0a0', '#fb7e7e', '#f95d5d', '#e84242', '#c92d2d', '#aa1919', '#8b0404']),
  green: scale('Green', ['#97f1ae', '#77e395', '#5dd27f', '#48bd6c', '#38a65c', '#2b8c4d', '#21713e', '#195530']),
  blue: scale('Blue', ['#a7d0ff', '#8cbafa', '#71a5f5', '#568ff0', '#4078df', '#3161c4', '#2249a9', '#13328e']),
  vivid: { label: 'Vivid', colors: VIVID, swatch: ['#00c9ff', '#84d253', '#8081f2'] },
};

export function isPaletteId(value: string): value is PaletteId {
  return Object.prototype.hasOwnProperty.call(PALETTES, value);
}

export function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

/** 32-bit FNV-1a, so `consistent` gives a series the same colour on every load. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** The colour at `t` ∈ [0, 1] along the colour stops, mixed linearly in RGB. */
export function interpolate(stops: string[], t: number): string {
  const x = Math.min(Math.max(t, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  if (i < 0) {
    return stops[0];
  }
  const a = rgb(stops[i]);
  const b = rgb(stops[i + 1]);
  const f = x - i;
  return `#${a
    .map((v, k) =>
      Math.round(v + (b[k] - v) * f)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function rgb(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * Colour of the i-th of `count` ordered series: Classic and Vivid cycle, Consistent hashes the name, the
 * scales spread the series from light to dark (a lone series gets the middle shade).
 */
export function seriesColor(palette: PaletteId, i: number, count: number, name: string): string {
  const id = isPaletteId(palette) ? palette : 'classic';
  const colors = PALETTES[id].colors;
  switch (id) {
    case 'consistent':
      return colors[stableHash(name) % colors.length];
    case 'classic':
    case 'vivid':
      return colors[i % colors.length];
    default:
      return interpolate(colors, count <= 1 ? 0.5 : i / (count - 1));
  }
}

/** A series to colour; `override` is its row's colour override, which applies to the series of `row`. */
export interface ColorItem {
  name: string;
  row: string;
  override?: string;
}

/**
 * Colours of ordered series: a hex override colours its series, a palette override spreads over the series of
 * its row, and the chart palette spreads over all the others.
 */
export function assignColors(items: ColorItem[], palette: PaletteId): string[] {
  const colors = items.map((item) => (item.override && isHexColor(item.override) ? item.override : ''));
  const sequences = new Map<string, number[]>();
  items.forEach((item, i) => {
    if (colors[i] !== '') {
      return;
    }
    const key = item.override && isPaletteId(item.override) ? `row:${item.row}` : '';
    const sequence = sequences.get(key) ?? [];
    sequence.push(i);
    sequences.set(key, sequence);
  });
  for (const [key, sequence] of sequences) {
    sequence.forEach((i, k) => {
      const item = items[i];
      colors[i] = seriesColor(key === '' ? palette : (item.override as PaletteId), k, sequence.length, item.name);
    });
  }
  return colors;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/** Orders `items` by name (natural sort) or by mean value (descending); `reverse` flips either. */
export function orderSeries<T>(
  items: T[],
  display: Pick<DisplayOptions, 'orderBy' | 'reverse'>,
  get: (item: T) => { name: string; series: Series }
): T[] {
  const sorted =
    display.orderBy === 'tags'
      ? [...items].sort((a, b) => naturalCompare(get(a).name, get(b).name))
      : [...items]
          .map((item) => ({ item, mean: meanOrLowest(get(item).series.values) }))
          .sort((a, b) => b.mean - a.mean || naturalCompare(get(a.item).name, get(b.item).name))
          .map((x) => x.item);
  return display.reverse ? sorted.reverse() : sorted;
}
