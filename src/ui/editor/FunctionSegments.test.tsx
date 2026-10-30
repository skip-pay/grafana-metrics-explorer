import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { FunctionCall } from '../../model/types';
import { FunctionSegments } from './FunctionSegments';

jest.mock('../../compile', () => {
  const defs: Record<string, unknown> = {
    rollup: {
      name: 'rollup',
      label: 'Rollup',
      category: 'Rollup',
      description: 'Time aggregation per interval',
      stage: 'modifier',
      params: [
        { name: 'agg', kind: 'enum', options: ['avg', 'sum', 'max'], default: 'avg' },
        { name: 'seconds', kind: 'number', default: 0 },
      ],
    },
    clamp_min: {
      name: 'clamp_min',
      label: 'Clamp min',
      category: 'Exclusion',
      description: 'Raise values below the threshold',
      stage: 'post',
      params: [{ name: 'threshold', kind: 'number', default: 0 }],
    },
    abs: { name: 'abs', label: 'Absolute', category: 'Arithmetic', description: '|x|', stage: 'post', params: [] },
  };
  return { getFunction: (name: string) => defs[name] };
});

const functions: FunctionCall[] = [
  { id: '1', name: 'rollup', args: ['max'] },
  { id: '2', name: 'clamp_min', args: [5] },
  { id: '3', name: 'abs', args: [] },
];

function setup(calls = functions) {
  const onChange = jest.fn();
  render(<FunctionSegments functions={calls} onChange={onChange} />);
  return { onChange };
}

describe('FunctionSegments', () => {
  it('renders one segment per call with its parameters in place', () => {
    setup();
    expect(screen.getAllByTestId('function-segment').map((p) => p.textContent)).toEqual([
      'rollupmaxeveryseconds',
      'clamp_min',
      'abs',
    ]);
    expect(screen.getByRole('spinbutton', { name: 'threshold' })).toHaveValue(5);
    // The automatic interval is an empty field.
    expect(screen.getByRole('spinbutton', { name: 'seconds' })).toHaveValue(null);
  });

  it('edits enum params from a menu, filling defaults for missing args', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'agg' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'sum' }));
    expect(onChange).toHaveBeenLastCalledWith([{ ...functions[0], args: ['sum', 0] }, functions[1], functions[2]]);
  });

  it('edits number params and ignores non-numbers', () => {
    const { onChange } = setup();
    const input = screen.getByRole('spinbutton', { name: 'threshold' });
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '2.5' } });
    expect(onChange).toHaveBeenLastCalledWith([functions[0], { ...functions[1], args: [2.5] }, functions[2]]);
  });

  it('edits intervals as a number and a unit', () => {
    const { onChange } = setup([{ id: '1', name: 'rollup', args: ['avg', 300] }]);
    const input = screen.getByRole('spinbutton', { name: 'seconds' });
    expect(input).toHaveValue(5);
    expect(screen.getByRole('button', { name: 'seconds unit' })).toHaveTextContent('minutes');

    fireEvent.change(input, { target: { value: '10' } });
    expect(onChange).toHaveBeenLastCalledWith([{ id: '1', name: 'rollup', args: ['avg', 600] }]);

    fireEvent.click(screen.getByRole('button', { name: 'seconds unit' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'hours' }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: '1', name: 'rollup', args: ['avg', 18000] }]);
  });

  it('removes a segment with ×', () => {
    const { onChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove clamp_min' }));
    expect(onChange).toHaveBeenLastCalledWith([functions[0], functions[2]]);
  });
});
