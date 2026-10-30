import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';

import { ModifyMenu } from './ModifyMenu';

jest.mock('../../compile', () => {
  const fn = (name: string, label: string, category: string, description: string, extra = {}) => ({
    name,
    label,
    category,
    description,
    params: [],
    stage: 'post',
    ...extra,
  });
  return {
    FUNCTIONS: [
      fn('abs', 'Absolute value', 'Arithmetic', 'The absolute value'),
      fn('log2', 'Log2', 'Arithmetic', 'Base-2 logarithm'),
      fn('rollup', 'Rollup', 'Rollup', 'Time aggregation', {
        stage: 'modifier',
        params: [{ name: 'agg', kind: 'enum', options: ['avg', 'sum'], default: 'avg' }],
      }),
      fn('as_count', 'As count', 'Count', 'Counters only', { stage: 'modifier' }),
      fn('count_nonzero', 'Count non-zero', 'Count', 'Non-zero series'),
      fn('pow', 'Power', 'Formula', 'Power', { formulaOnly: true }),
    ],
    CATEGORY_ORDER: ['Arithmetic', 'Rollup', 'Count'],
    QUICK_PICKS: ['rollup', 'abs'],
  };
});

function open() {
  const onAdd = jest.fn();
  render(<ModifyMenu onAdd={onAdd} />);
  fireEvent.click(screen.getByRole('button', { name: 'Modify' }));
  return { onAdd, search: screen.getByRole('textbox', { name: 'Search functions' }) };
}

const items = (label: string) =>
  within(screen.getByRole('menu', { name: label }))
    .queryAllByRole('menuitem')
    .map((i) => i.textContent);

describe('ModifyMenu', () => {
  it('starts with the quick picks and a link to every function', () => {
    const { onAdd } = open();
    // as_count lives in the row's "as" segment and pow only in formulas.
    expect(items('Functions')).toEqual(['Rollup', 'Absolute value', 'View all 4 functions']);
    expect(screen.getByTestId('modify-menu')).toHaveTextContent('Time aggregation');

    fireEvent.click(screen.getByRole('menuitem', { name: 'Absolute value' }));
    expect(onAdd).toHaveBeenCalledWith('abs');
    expect(screen.queryByTestId('modify-menu')).not.toBeInTheDocument();
  });

  it('lists the categories in order and previews a hovered function', () => {
    const { onAdd } = open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'View all 4 functions' }));
    expect(items('Categories')).toEqual(['Back', 'Arithmetic', 'Rollup', 'Count']);
    expect(items('Arithmetic')).toEqual(['Absolute value', 'Log2']);

    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: 'Rollup' }));
    fireEvent.mouseEnter(within(screen.getByRole('menu', { name: 'Rollup' })).getByRole('menuitem'));
    const preview = screen.getByTestId('modify-menu');
    expect(preview).toHaveTextContent('Time aggregation');
    expect(preview).toHaveTextContent('agg:one of avg, sum (default avg)');

    fireEvent.click(within(screen.getByRole('menu', { name: 'Rollup' })).getByRole('menuitem'));
    expect(onAdd).toHaveBeenCalledWith('rollup');
  });

  it('walks the categories with the keyboard', () => {
    const { onAdd, search } = open();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(items('Categories')).toContain('Count');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowRight' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('rollup');
  });

  it('filters by search and adds the active match on Enter', () => {
    const { onAdd, search } = open();
    fireEvent.change(search, { target: { value: 'log' } });
    expect(items('Functions')).toEqual(['Log2Arithmetic']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('log2');
  });

  it('says when nothing matches and closes on Escape', () => {
    const { search } = open();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matching functions')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByTestId('modify-menu')).not.toBeInTheDocument();
  });
});
