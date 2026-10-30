import { PaletteId } from '../model/types';
import {
  assignColors,
  interpolate,
  isHexColor,
  isPaletteId,
  naturalCompare,
  orderSeries,
  PALETTES,
  seriesColor,
  stableHash,
} from './palette';
import { series } from './testFixtures';

const IDS: PaletteId[] = [
  'consistent',
  'classic',
  'cool',
  'warm',
  'purple',
  'orange',
  'gray',
  'red',
  'green',
  'blue',
  'vivid',
];
const SCALES = IDS.filter((id) => !['consistent', 'classic', 'vivid'].includes(id));

describe('palettes', () => {
  it('defines every palette in menu order with hex colours and a three-colour swatch', () => {
    expect(Object.keys(PALETTES)).toEqual(IDS);
    expect(Object.values(PALETTES).map((p) => p.label)).toEqual([
      'Consistent',
      'Classic',
      'Cool',
      'Warm',
      'Purple',
      'Orange',
      'Gray',
      'Red',
      'Green',
      'Blue',
      'Vivid',
    ]);
    for (const id of IDS) {
      expect(PALETTES[id].colors.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
      expect(new Set(PALETTES[id].colors).size).toBe(PALETTES[id].colors.length);
      expect(PALETTES[id].swatch).toHaveLength(3);
      expect(PALETTES[id].swatch.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    }
  });

  it('classic is the six-colour cycle starting at #3598ec; vivid has 16 colours', () => {
    expect(PALETTES.classic.colors).toEqual(['#3598ec', '#5d4ebe', '#efc328', '#7ea9fa', '#a58dff', '#fcd779']);
    expect(PALETTES.vivid.colors).toHaveLength(16);
    expect(PALETTES.vivid.colors.slice(0, 3)).toEqual(['#8081f2', '#f04f94', '#00d77d']);
    expect(PALETTES.consistent.colors).toBe(PALETTES.vivid.colors);
  });

  it('a single classic series is #3598ec', () => {
    expect(seriesColor('classic', 0, 1, 'avg:m{*}')).toBe('#3598ec');
  });

  it('classic and vivid cycle by index, adjacent series always differ', () => {
    const colors = Array.from({ length: 13 }, (_, i) => seriesColor('classic', i, 13, `s${i}`));
    expect(colors.slice(0, 6)).toEqual(PALETTES.classic.colors);
    expect(colors[6]).toBe(colors[0]);
    expect(colors.every((c, i) => i === 0 || c !== colors[i - 1])).toBe(true);
    expect(seriesColor('vivid', 17, 20, 'x')).toBe(PALETTES.vivid.colors[1]);
  });

  it('consistent hashes the name into the vivid colours', () => {
    const a = seriesColor('consistent', 0, 3, 'web-1');
    expect(seriesColor('consistent', 2, 9, 'web-1')).toBe(a);
    expect(PALETTES.vivid.colors).toContain(a);
    expect(stableHash('web-1')).toBe(stableHash('web-1'));
    expect(stableHash('web-1')).not.toBe(stableHash('web-2'));
    // FNV-1a reference values.
    expect(stableHash('')).toBe(0x811c9dc5);
    expect(stableHash('a')).toBe(0xe40c292c);
  });

  it('scales interpolate light to dark over the series count; one series gets the middle shade', () => {
    const blue = PALETTES.blue.colors;
    expect([0, 1].map((i) => seriesColor('blue', i, 2, 'x'))).toEqual([blue[0], blue[7]]);
    expect(seriesColor('blue', 0, 1, 'x')).toBe(interpolate(blue, 0.5));
    const many = Array.from({ length: 21 }, (_, i) => seriesColor('cool', i, 21, 'x'));
    expect(new Set(many).size).toBe(21);
    expect(many[0]).toBe('#cfecca');
    expect(many[20]).toBe('#084081');
    for (const id of SCALES) {
      expect(PALETTES[id].swatch).toEqual([
        PALETTES[id].colors[7],
        interpolate(PALETTES[id].colors, 0.5),
        PALETTES[id].colors[0],
      ]);
    }
  });

  it('interpolates in RGB between the stops', () => {
    expect(interpolate(['#000000', '#ffffff'], 0.5)).toBe('#808080');
    expect(interpolate(['#000000', '#ff0000', '#ffffff'], 0.75)).toBe('#ff8080');
    expect(interpolate(['#123456'], 0.3)).toBe('#123456');
    expect(interpolate(['#000000', '#ffffff'], 2)).toBe('#ffffff');
  });

  it('is deterministic', () => {
    for (const id of IDS) {
      const run = () => Array.from({ length: 10 }, (_, i) => seriesColor(id, i, 10, `n${i}`));
      expect(run()).toEqual(run());
    }
  });
});

describe('colour overrides', () => {
  const item = (name: string, row: string, override?: string) => ({ name, row, override });

  it('a hex override colours its series; the palette continues over the others', () => {
    expect(assignColors([item('a', 'a', '#ff0000'), item('b', 'b'), item('c', 'c')], 'classic')).toEqual([
      '#ff0000',
      '#3598ec',
      '#5d4ebe',
    ]);
  });

  it("a palette override spreads over its row's series", () => {
    const colors = assignColors(
      [item('x', 'a', 'blue'), item('y', 'b'), item('z', 'a', 'blue'), item('w', 'a', 'blue')],
      'classic'
    );
    const blue = PALETTES.blue.colors;
    expect(colors).toEqual([blue[0], '#3598ec', interpolate(blue, 0.5), blue[7]]);
  });

  it('ignores an override that is neither a hex colour nor a palette', () => {
    expect(assignColors([item('a', 'a', 'pink')], 'classic')).toEqual(['#3598ec']);
    expect(isHexColor('#abc')).toBe(true);
    expect(isHexColor('#abcd')).toBe(false);
    expect(isPaletteId('vivid')).toBe(true);
    expect(isPaletteId('toString')).toBe(false);
  });
});

describe('ordering', () => {
  const items = [
    { name: 'host:web-10', series: series([1, 1]) },
    { name: 'host:web-2', series: series([5, null]) },
    { name: 'host:Web-3', series: series([3, 3]) },
    { name: 'host:none', series: series([null, null]) },
  ];
  const names = (orderBy: 'tags' | 'values', reverse: boolean) =>
    orderSeries(items, { orderBy, reverse }, (i) => i).map((i) => i.name);

  it('tags: natural, case-insensitive order by name', () => {
    expect(names('tags', false)).toEqual(['host:none', 'host:web-2', 'host:Web-3', 'host:web-10']);
    expect(names('tags', true)).toEqual(['host:web-10', 'host:Web-3', 'host:web-2', 'host:none']);
  });

  it('values: mean descending, series without data last; reverse flips', () => {
    expect(names('values', false)).toEqual(['host:web-2', 'host:Web-3', 'host:web-10', 'host:none']);
    expect(names('values', true)).toEqual(['host:none', 'host:web-10', 'host:Web-3', 'host:web-2']);
  });

  it('naturalCompare orders numbers numerically', () => {
    expect(['a10', 'a9', 'a1'].sort(naturalCompare)).toEqual(['a1', 'a9', 'a10']);
  });
});
