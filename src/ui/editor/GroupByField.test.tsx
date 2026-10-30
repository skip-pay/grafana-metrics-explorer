import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { ResolvedMetric } from '../../model/types';
import { GroupByField } from './GroupByField';

jest.mock('../../catalog', () => ({
  isNoiseKey: (key: string) => ['instance_id', 'start_time'].includes(key),
}));

const resolved: ResolvedMetric = {
  name: 'http_requests_total',
  kind: 'delta_counter',
  streams: {},
  temporality: { delta: true, cumulative: false },
  labelKeys: ['environment', 'http_method', 'instance_id', 'path', 'start_time'],
  hasInstanceId: true,
  nativeIntervalSec: 20,
};

function setup(initial: string[] = []) {
  const onChange = jest.fn();
  const Harness = () => {
    const [groupBy, setGroupBy] = useState(initial);
    return (
      <GroupByField
        groupBy={groupBy}
        resolved={resolved}
        onChange={(next) => {
          setGroupBy(next);
          onChange(next);
        }}
      />
    );
  };
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Group by tags' });
  act(() => input.focus());
  return { input, onChange };
}

const options = () => screen.queryAllByRole('option').map((o) => o.textContent?.replace('↵', ''));

describe('GroupByField', () => {
  it('suggests label keys without internal ones until "Show all tags"', () => {
    setup(['path']);
    expect(options()).toEqual(['environment', 'http_method']);
    fireEvent.click(screen.getByRole('button', { name: 'Show all tags (2 hidden)' }));
    expect(options()).toEqual(['environment', 'http_method', 'instance_id', 'start_time']);
  });

  it('ranks prefix matches first and treats separators alike', () => {
    const { input } = setup();
    fireEvent.change(input, { target: { value: 'http-m' } });
    expect(options()).toEqual(['http_method']);
    // `m` starts a token of http_method but sits inside environment.
    fireEvent.change(input, { target: { value: 'm' } });
    expect(options()).toEqual(['http_method', 'environment']);
  });

  it('adds the highlighted key and removes the last one with Backspace', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'pa' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['path']);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('accepts typed and pasted keys, unknown ones as red chips', () => {
    const { input, onChange } = setup();
    fireEvent.change(input, { target: { value: 'region' } });
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenLastCalledWith(['region']);
    expect(screen.getByTestId('chip')).toHaveAttribute('data-invalid', 'true');

    fireEvent.paste(input, { clipboardData: { getData: () => 'environment, path' } });
    expect(onChange).toHaveBeenLastCalledWith(['region', 'environment', 'path']);
  });
});
