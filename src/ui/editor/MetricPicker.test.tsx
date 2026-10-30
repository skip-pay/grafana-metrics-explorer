import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { Catalog } from '../../catalog';
import { MetricInfo, ResolvedMetric } from '../../model/types';
import { MetricPicker } from './MetricPicker';

jest.mock('../../catalog', () => ({
  isNoiseKey: (key: string) => key === 'le',
  sortLabelKeys: (keys: string[]) => [...keys].sort(),
  // Substring search with one highlight range, enough to drive the component.
  searchMetrics: (query: string, metrics: Array<{ name: string }>, limit = 100) =>
    metrics
      .filter((m) => m.name.includes(query))
      .slice(0, limit)
      .map((metric) => {
        const at = metric.name.indexOf(query);
        return { metric, score: 1, ranges: [[at, at + query.length]] };
      }),
}));

const metrics: MetricInfo[] = [
  { name: 'http_requests_total', kind: 'delta_counter', streams: {}, help: 'Requests received' },
  { name: 'http_requests_errors_total', kind: 'delta_counter', streams: {} },
  { name: 'go_goroutines', kind: 'gauge', streams: {} },
  {
    name: 'amazonaws_com_aws_ecs_cpuutilization',
    kind: 'cloudwatch',
    streams: {},
    unit: 'percent',
    unitLabel: 'Percent',
  },
];

function setup(props: Partial<React.ComponentProps<typeof MetricPicker>> = {}) {
  const onChange = jest.fn();
  const onGroupBy = jest.fn();
  render(<MetricPicker value="" metrics={metrics} onChange={onChange} onGroupBy={onGroupBy} {...props} />);
  const input = screen.getByRole('combobox', { name: 'Metric' });
  act(() => input.focus());
  return { input, onChange, onGroupBy };
}

const optionNames = () => screen.queryAllByRole('option').map((o) => o.textContent);
const activeOption = () => screen.getAllByRole('option').find((o) => o.getAttribute('aria-selected') === 'true');

describe('MetricPicker', () => {
  it('lists plain metric names alphabetically when nothing is typed, CloudWatch last', () => {
    setup();
    expect(optionNames()).toEqual([
      'go_goroutines',
      'http_requests_errors_total',
      'http_requests_total',
      'amazonaws_com_aws_ecs_cpuutilization',
    ]);
  });

  it('opens on the current metric among its alphabetical neighbours', () => {
    const { input } = setup({ value: 'http_requests_total' });
    expect(input).toHaveValue('http_requests_total');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    expect(activeOption()).toHaveTextContent('http_requests_total');
  });

  it('moves with the arrows and accepts with Enter', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'requests' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(activeOption()).toHaveTextContent('http_requests_errors_total');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()).toHaveTextContent('http_requests_total');
    expect(input).toHaveAttribute('aria-activedescendant', activeOption()?.id);

    // Wraps around at both ends.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(activeOption()).toHaveTextContent('http_requests_errors_total');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(activeOption()).toHaveTextContent('http_requests_total');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('http_requests_total');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('highlights the matched part of the name', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'gorout' } });
    expect(screen.getByText('gorout').tagName).toBe('MARK');
  });

  it('accepts with Tab only after typing', () => {
    const { input, onChange } = setup();
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onChange).not.toHaveBeenCalled();

    act(() => input.focus());
    fireEvent.change(input, { target: { value: 'go_' } });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(onChange).toHaveBeenCalledWith('go_goroutines');
  });

  it('closes on Escape without changing the metric and shows the value again', () => {
    const { input, onChange } = setup({ value: 'go_goroutines' });
    fireEvent.change(input, { target: { value: 'sp' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue('go_goroutines');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('picks with the mouse', () => {
    const { onChange } = setup();
    fireEvent.mouseEnter(screen.getAllByRole('option')[1]);
    expect(activeOption()).toHaveTextContent('http_requests_errors_total');
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(onChange).toHaveBeenCalledWith('http_requests_errors_total');
  });

  it('takes a typed name that is not in the catalogue', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'not_listed_metric' } });
    expect(screen.getByText('No matching results')).toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('not_listed_metric');
  });

  it('previews unit, type and the tag keys with their value counts; a tag click groups by it', async () => {
    jest.useFakeTimers();
    try {
      const resolved: ResolvedMetric = {
        ...metrics[3],
        temporality: { delta: false, cumulative: false },
        labelKeys: ['dimensions_clustername', 'dimensions_servicename', 'empty', 'le'],
        hasInstanceId: false,
        nativeIntervalSec: 60,
      };
      const values: Record<string, string[]> = {
        dimensions_clustername: ['a', 'b'],
        dimensions_servicename: ['x', 'y', 'z'],
        empty: [],
      };
      const resolve = jest.fn().mockResolvedValue(resolved);
      const labelValues = jest.fn(async (_m: unknown, key: string) => values[key] ?? []);
      const catalog = { resolve, labelValues } as unknown as Catalog;
      const { onGroupBy } = setup({ catalog, timeWindow: { from: 0, to: 3_600_000 } });
      fireEvent.mouseEnter(screen.getAllByRole('option')[3]);

      const preview = screen.getByTestId('metric-preview');
      expect(preview).toHaveTextContent('amazonaws_com_aws_ecs_cpuutilization');
      expect(preview).toHaveTextContent('unit: percent│type: CloudWatch');
      expect(preview).toHaveTextContent('Loading tags…');
      expect(resolve).not.toHaveBeenCalled();

      await act(async () => {
        jest.advanceTimersByTime(200);
      });
      expect(resolve).toHaveBeenCalledWith('amazonaws_com_aws_ecs_cpuutilization', { from: 0, to: 3_600_000 });
      // Most values first; keys without values and noise keys are left out.
      const chips = screen.getAllByRole('button', { name: /^dimensions_/ });
      expect(chips.map((c) => c.textContent)).toEqual(['dimensions_servicename (3)', 'dimensions_clustername (2)']);
      expect(labelValues).not.toHaveBeenCalledWith(resolved, 'le', [], expect.anything());
      expect(preview).toHaveTextContent('Click a tag to group by');

      fireEvent.click(chips[1]);
      expect(onGroupBy).toHaveBeenCalledWith('amazonaws_com_aws_ecs_cpuutilization', 'dimensions_clustername');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    } finally {
      jest.useRealTimers();
    }
  });
});
