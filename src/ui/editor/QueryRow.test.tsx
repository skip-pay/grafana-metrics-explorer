import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { Catalog } from '../../catalog';
import { MetricInfo, MetricQuery } from '../../model/types';
import { QueryRow } from './QueryRow';

jest.mock('../../catalog', () => ({
  searchMetrics: (query: string, metrics: Array<{ name: string }>) =>
    metrics.filter((m) => m.name.includes(query)).map((metric) => ({ metric, score: 1, ranges: [] })),
  searchTags: () => [],
  isNoiseKey: () => false,
}));

jest.mock('../../compile', () => ({
  // The "from" field parses filters for real.
  ...jest.requireActual('../../compile/filters'),
  FUNCTIONS: [
    { name: 'abs', label: 'Absolute value', category: 'Arithmetic', description: '', params: [], stage: 'post' },
  ],
  CATEGORY_ORDER: ['Arithmetic'],
  QUICK_PICKS: ['abs'],
  getFunction: (name: string) => ({ name, label: name, category: 'Count', description: '', params: [], stage: 'post' }),
  newFunctionCall: (name: string) => ({ id: `new-${name}`, name, args: [] }),
  renderFunctionCall: (call: { name: string }) => `${call.name}()`,
  renderQueryText: (q: { spaceAgg: string; metric: string }) => `${q.spaceAgg}:${q.metric}{*}`,
  parseQueryText: (text: string) =>
    text.startsWith('max:') ? { spaceAgg: 'max', metric: text.slice(4, -3) } : { error: 'Unknown aggregator' },
}));

const metrics: MetricInfo[] = [
  { name: 'http_requests_total', kind: 'delta_counter', streams: {} },
  { name: 'system_cpu_user', kind: 'gauge', streams: {}, unit: 'percent' },
];

const baseQuery: MetricQuery = {
  kind: 'query',
  id: 'q1',
  letter: 'a',
  hidden: false,
  metric: '',
  filters: [],
  spaceAgg: 'avg',
  groupBy: [],
  functions: [],
};

function setup(query: Partial<MetricQuery> = {}, deleteBlocked?: string) {
  const props = {
    onChange: jest.fn(),
    onRemove: jest.fn(),
  };
  const q = { ...baseQuery, ...query };
  render(
    <QueryRow
      query={q}
      metricInfo={metrics.find((m) => m.name === q.metric)}
      metrics={metrics}
      catalog={{} as Catalog}
      timeWindow={{ from: 0, to: 3_600_000 }}
      deleteBlocked={deleteBlocked}
      {...props}
    />
  );
  return props;
}

describe('QueryRow', () => {
  it('applies the kind defaults when a counter metric is picked', () => {
    const { onChange } = setup();
    const input = screen.getByRole('combobox', { name: 'Metric' });
    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'requests' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({
      metric: 'http_requests_total',
      spaceAgg: 'sum',
      functions: [expect.objectContaining({ name: 'as_count', args: [] })],
    });
  });

  it('shows count modifiers of counters in the "as" segment, other functions after it', () => {
    const asCount = { id: 'c', name: 'as_count', args: [] };
    const abs = { id: 'x', name: 'abs', args: [] };
    const { onChange } = setup({ metric: 'http_requests_total', spaceAgg: 'sum', functions: [asCount, abs] });
    const segments = screen.getAllByTestId('function-segment');
    expect(segments.map((p) => p.textContent)).toEqual(['abs']);
    // Σ Modify follows the function segments.
    expect(segments[0].nextElementSibling).toContainElement(screen.getByRole('button', { name: 'Modify' }));

    fireEvent.click(screen.getByRole('button', { name: 'Counter mode: count' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^rate/ }));
    expect(onChange).toHaveBeenLastCalledWith({ functions: [{ ...asCount, name: 'as_rate' }, abs] });
  });

  it('shows count modifiers as function segments for other kinds', () => {
    setup({ metric: 'system_cpu_user', functions: [{ id: 'c', name: 'as_count', args: [] }] });
    expect(screen.queryByRole('button', { name: /Counter mode/ })).not.toBeInTheDocument();
    expect(screen.getAllByTestId('function-segment').map((p) => p.textContent)).toEqual(['as_count']);
  });

  it('adds a function from the quick picks of Σ Modify', () => {
    const { onChange } = setup({ metric: 'system_cpu_user' });
    fireEvent.click(screen.getByRole('button', { name: 'Modify' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Absolute value' }));
    expect(onChange).toHaveBeenCalledWith({ functions: [{ id: 'new-abs', name: 'abs', args: [] }] });
  });

  it('edits the query as text in raw mode', () => {
    const { onChange } = setup({ metric: 'system_cpu_user' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit query as text' }));
    const text = screen.getByRole('textbox', { name: 'Query text' });
    expect(text).toHaveValue('avg:system_cpu_user{*}');

    fireEvent.change(text, { target: { value: 'p42:system_cpu_user{*}' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown aggregator');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.change(text, { target: { value: 'max:system_cpu_user{*}' } });
    fireEvent.keyDown(text, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith({ spaceAgg: 'max', metric: 'system_cpu_user' });
    expect(screen.queryByRole('textbox', { name: 'Query text' })).not.toBeInTheDocument();
  });

  it('toggles visibility and deletes unless blocked', () => {
    const { onChange, onRemove } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Hide query a' }));
    expect(onChange).toHaveBeenCalledWith({ hidden: true });
    expect(screen.queryByRole('button', { name: /Clone/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete query' }));
    expect(onRemove).toHaveBeenCalled();
  });

  it('disables delete while a formula uses the query', () => {
    const { onRemove } = setup({}, 'Query used in other formulas');
    const remove = screen.getByRole('button', { name: 'Delete query' });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('offers the aggregators of the metric kind', () => {
    const { onChange } = setup({ metric: 'http_requests_total', spaceAgg: 'sum' });
    fireEvent.click(screen.getByRole('button', { name: 'Space aggregation: sum' }));
    expect(screen.getAllByRole('menuitemradio').map((i) => i.textContent)).toEqual([
      'sum by',
      'avg by',
      'max by',
      'min by',
    ]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'max by' }));
    expect(onChange).toHaveBeenCalledWith({ spaceAgg: 'max' });
  });

  it('overrides the colour of an ungrouped query and the palette of a grouped one', () => {
    const { onChange } = setup({ metric: 'system_cpu_user' });
    fireEvent.click(screen.getByRole('button', { name: 'Color override' }));
    fireEvent.click(screen.getByRole('button', { name: 'Vivid #8081F2' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: '#8081F2' });
  });

  it('offers palettes and a reset for a grouped query', () => {
    const { onChange } = setup({ metric: 'system_cpu_user', groupBy: ['host'], color: 'warm' });
    fireEvent.click(screen.getByRole('button', { name: 'Palette override' }));
    expect(screen.getByRole('menuitemradio', { name: 'Warm' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Cool' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: 'cool' });

    fireEvent.click(screen.getByRole('button', { name: 'Palette override' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onChange).toHaveBeenLastCalledWith({ color: undefined });
  });
});
