import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { validateFormula } from '../../engine';
import { FormulaQuery } from '../../model/types';
import { FormulaRow } from './FormulaRow';

jest.mock('../../engine', () => ({
  // Flags letters that are not query rows, like the real validator does for unknown refs.
  validateFormula: jest.fn((expression: string, letters: string[]) => {
    const unknown = (expression.match(/\b[a-z]\b/g) ?? []).find((l) => !letters.includes(l));
    return unknown ? `Unknown query ${unknown}` : null;
  }),
}));

const formula = (patch: Partial<FormulaQuery> = {}): FormulaQuery => ({
  kind: 'formula',
  id: 'f',
  expression: 'a / b * 100',
  hidden: false,
  ...patch,
});

function setup(f: FormulaQuery, error?: string) {
  const onChange = jest.fn();
  const onRemove = jest.fn();
  render(<FormulaRow formula={f} letters={['a', 'b']} onChange={onChange} onRemove={onRemove} error={error} />);
  return { onChange, onRemove, input: screen.getByRole('textbox', { name: 'Formula expression' }) };
}

describe('FormulaRow', () => {
  beforeEach(() => jest.mocked(validateFormula).mockClear());

  it('shows no error for a valid expression', () => {
    const { input } = setup(formula());
    expect(validateFormula).toHaveBeenCalledWith('a / b * 100', ['a', 'b']);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');
  });

  it('shows the validation error inline', () => {
    const { input } = setup(formula({ expression: 'a + c' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Unknown query c');
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('does not validate an empty expression', () => {
    setup(formula({ expression: '  ' }));
    expect(validateFormula).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an evaluation error only when the expression itself is valid', () => {
    setup(formula(), 'Division produced no series');
    expect(screen.getByRole('alert')).toHaveTextContent('Division produced no series');
  });

  it('reports typing, hiding and deleting', () => {
    const { input, onChange, onRemove } = setup(formula());
    fireEvent.change(input, { target: { value: 'a * 2' } });
    expect(onChange).toHaveBeenLastCalledWith({ expression: 'a * 2' });

    fireEvent.click(screen.getByRole('button', { name: 'Hide formula' }));
    expect(onChange).toHaveBeenLastCalledWith({ hidden: true });

    fireEvent.click(screen.getByRole('button', { name: 'Delete formula' }));
    expect(onRemove).toHaveBeenCalled();
  });

  it('shows a hidden formula badge as toggled off', () => {
    setup(formula({ hidden: true }));
    expect(screen.getByRole('button', { name: 'Show formula' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('sets and clears the alias', () => {
    const { onChange } = setup(formula({ alias: 'error rate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alias error rate' }));
    const alias = screen.getByRole('textbox', { name: 'Alias' });
    fireEvent.change(alias, { target: { value: '' } });
    fireEvent.keyDown(alias, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ alias: undefined });
  });
});
