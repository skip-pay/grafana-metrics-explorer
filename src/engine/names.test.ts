import { isGrouped, RowNaming, seriesName } from './names';

const ungrouped: RowNaming = { keys: [], ungroupedName: 'avg:m{*}', label: 'a', aliased: false };
const grouped: RowNaming = {
  keys: ['host', 'env'],
  ungroupedName: 'avg:m{*} by {host,env}',
  label: 'a',
  aliased: false,
};
const aliased: RowNaming = { keys: ['host'], ungroupedName: 'cpu', label: 'cpu', aliased: true };
const formula: RowNaming = { keys: ['host'], ungroupedName: 'a / b * 100', label: 'a / b * 100', aliased: false };

describe('series names', () => {
  it('ungrouped: the row name (text form or alias)', () => {
    expect(seriesName(ungrouped, {})).toBe('avg:m{*}');
    expect(seriesName({ ...ungrouped, ungroupedName: 'my alias', aliased: true }, {})).toBe('my alias');
    expect(seriesName(ungrouped, {}, { prefix: true })).toBe('avg:m{*}');
  });

  it('grouped: tag values in group-by order', () => {
    expect(seriesName(grouped, { env: 'prod', host: 'web-1' })).toBe('web-1, prod');
  });

  it('a missing label is N/A, an empty one is ""', () => {
    expect(seriesName(grouped, { env: 'prod' })).toBe('N/A, prod');
    expect(seriesName(grouped, { env: '', host: 'web-1' })).toBe('web-1, ""');
  });

  it('prefixes the letter when several rows share the chart', () => {
    expect(seriesName(grouped, { env: 'prod', host: 'web-1' }, { prefix: true })).toBe('a · web-1, prod');
  });

  it('an aliased grouped row always carries its alias', () => {
    expect(seriesName(aliased, { host: 'web-1' })).toBe('cpu · web-1');
    expect(seriesName(aliased, { host: 'web-1' }, { prefix: true })).toBe('cpu · web-1');
  });

  it('a formula prefixes its expression', () => {
    expect(seriesName(formula, { host: 'web-1' })).toBe('web-1');
    expect(seriesName(formula, { host: 'web-1' }, { prefix: true })).toBe('a / b * 100 · web-1');
  });

  it('leaves out the split key, falling back to the row name', () => {
    expect(seriesName(grouped, { env: 'prod', host: 'web-1' }, { exclude: 'env' })).toBe('web-1');
    expect(seriesName({ ...grouped, keys: ['env'] }, { env: 'prod' }, { exclude: 'env' })).toBe(
      'avg:m{*} by {host,env}'
    );
    expect(isGrouped({ ...grouped, keys: ['env'] }, 'env')).toBe(false);
    expect(isGrouped(grouped, 'env')).toBe(true);
    expect(isGrouped(ungrouped)).toBe(false);
  });
});
