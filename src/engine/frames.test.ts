import { buildGrid, framesToSeries } from './frames';
import { emptyFrame, FROM, promFrame, promTimes, STEP, T0, TO } from './testFixtures';

describe('grid', () => {
  it('is the queried timestamps moved back one step (bucket starts)', () => {
    const grid = buildGrid(FROM, TO, STEP, []);
    expect(promTimes()).toHaveLength(11);
    expect(grid).toEqual(promTimes().map((t) => t - STEP * 1000));
    expect(grid[0]).toBe(T0 - 60000);
    expect(grid[grid.length - 1]).toBe(T0 + 9 * 60000);
  });

  it('follows the phase of the returned timestamps (UTC-offset alignment)', () => {
    const step = 7200;
    const offset = 3600 * 1000;
    const frame = promFrame('a', {}, [1], { times: [Math.floor(FROM / 7200000) * 7200000 + offset], step });
    const grid = buildGrid(FROM, FROM + 6 * 3600 * 1000, step, [frame]);
    expect(grid.every((t) => (t - offset) % (step * 1000) === 0)).toBe(true);
    expect(grid).toHaveLength(4);
  });

  it('is empty for an invalid step or range', () => {
    expect(buildGrid(FROM, TO, 0, [])).toEqual([]);
    expect(buildGrid(TO, FROM, STEP, [])).toEqual([]);
  });
});

describe('frames to series', () => {
  const grid = buildGrid(FROM, TO, STEP, []);

  it('puts every point one step earlier on the grid, missing points null', () => {
    const values = [1, 2, null, 4, 5, 6, 7, 8, 9, 10, 11];
    const [s] = framesToSeries([promFrame('a', { host: 'x' }, values)], 'a', grid, STEP);
    expect(s.times).toBe(grid);
    expect(s.values).toEqual(values);
    expect(s.labels).toEqual({ host: 'x' });
    expect(s.refLetter).toBe('a');
  });

  it('one series per frame; ungrouped frames have no labels', () => {
    const frames = [promFrame('a', { host: 'x' }, [1]), promFrame('a', { host: 'y' }, [2]), promFrame('a', {}, [3])];
    const out = framesToSeries(frames, 'a', grid, STEP);
    expect(out.map((s) => s.labels)).toEqual([{ host: 'x' }, { host: 'y' }, {}]);
    expect(out[0].values[0]).toBe(1);
  });

  it('drops __name__ and keeps explicitly empty labels', () => {
    const [s] = framesToSeries([promFrame('a', { __name__: 'm', host: '' }, [1])], 'a', grid, STEP);
    expect(s.labels).toEqual({ host: '' });
  });

  it('NaN and infinities become null', () => {
    const [s] = framesToSeries([promFrame('a', {}, [NaN, Infinity, -Infinity, 1])], 'a', grid, STEP);
    expect(s.values.slice(0, 4)).toEqual([null, null, null, 1]);
  });

  it('an empty result (frame without fields) gives no series', () => {
    expect(framesToSeries([emptyFrame('a')], 'a', grid, STEP)).toEqual([]);
  });

  it('drops points that fall off the grid', () => {
    const times = [T0 - 120000, T0, T0 + 60000];
    const [s] = framesToSeries([promFrame('a', {}, [1, 2, 3], { times })], 'a', grid, STEP);
    expect(s.values.filter((v) => v !== null)).toEqual([2, 3]);
    expect(s.values.slice(0, 2)).toEqual([2, 3]);
  });

  it('no grid, no series', () => {
    expect(framesToSeries([promFrame('a', {}, [1])], 'a', [], STEP)).toEqual([]);
  });
});
