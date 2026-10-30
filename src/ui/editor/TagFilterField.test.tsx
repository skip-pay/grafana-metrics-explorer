import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { Catalog, TagPair } from '../../catalog';
import { FilterItem, ResolvedMetric } from '../../model/types';
import { TagFilterField } from './TagFilterField';

jest.mock('../../catalog', () => ({
  isLowPriorityKey: (key: string) => key === 'instance_id',
  // Substring search over `key:value`; a leading `!` is stripped and re-applied, as the real one does.
  searchTags: (query: string, pairs: Array<{ key: string; value: string }>, limit = 100) => {
    const negated = query.startsWith('!');
    const q = negated ? query.slice(1) : query;
    return pairs
      .map((pair) => ({ pair, at: `${pair.key}:${pair.value}`.indexOf(q) }))
      .filter(({ at }) => at >= 0)
      .slice(0, limit)
      .map(({ pair, at }) => ({ pair, negated, score: 1, ranges: [[at, at + q.length]] }));
  },
}));

const resolved: ResolvedMetric = {
  name: 'http_requests_total',
  kind: 'delta_counter',
  streams: {},
  temporality: { delta: true, cumulative: false },
  labelKeys: ['environment', 'path'],
  hasInstanceId: true,
  nativeIntervalSec: 20,
};

const PAIRS: TagPair[] = [
  { key: 'environment', value: 'prod' },
  { key: 'environment', value: 'staging' },
  { key: 'path', value: '/orders' },
];

function setup(initial: FilterItem[] = []) {
  const onChange = jest.fn();
  // The first batch arrives through onProgress, the rest with the promise.
  const tagPairs = jest.fn((_m: unknown, _f: unknown, _r: unknown, onProgress?: (pairs: TagPair[]) => void) => {
    onProgress?.(PAIRS.slice(0, 1));
    return Promise.resolve(PAIRS);
  });
  const catalog = { tagPairs } as unknown as Catalog;
  const Harness = () => {
    const [filters, setFilters] = useState(initial);
    return (
      <TagFilterField
        filters={filters}
        resolved={resolved}
        catalog={catalog}
        metric={resolved.name}
        timeWindow={{ from: 0, to: 3_600_000 }}
        onChange={(next) => {
          setFilters(next);
          onChange(next);
        }}
      />
    );
  };
  render(<Harness />);
  const input = screen.getByRole('combobox', { name: 'Filter tags' });
  return { input, onChange, tagPairs };
}

const chipTexts = () => screen.queryAllByTestId('chip').map((c) => c.textContent);
const options = () => screen.queryAllByRole('option').map((o) => o.textContent?.replace('↵', ''));

async function focus(input: HTMLElement) {
  await act(async () => input.focus());
}

// Chip changes refetch the narrowed pairs; async act lets that promise settle inside act.
async function press(input: HTMLElement, key: string) {
  await act(async () => fireEvent.keyDown(input, { key }));
}

describe('TagFilterField', () => {
  it('loads tag pairs progressively on focus and adds a picked suggestion', async () => {
    const { input, onChange, tagPairs } = setup();
    await focus(input);
    expect(tagPairs).toHaveBeenCalledTimes(1);
    expect(tagPairs.mock.calls[0][2]).toEqual({ from: 0, to: 3_600_000 });
    // An empty field lists keys with the fewest values first.
    expect(options()).toEqual(['path:/orders', 'environment:prod', 'environment:staging']);

    fireEvent.change(input, { target: { value: 'stag' } });
    expect(options()).toEqual(['environment:staging']);
    await press(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'eq', values: ['staging'] }]);
    expect(input).toHaveValue('');
    expect(chipTexts()).toEqual(['environment:staging']);
  });

  it('turns a leading ! into an exclusion', async () => {
    const { input, onChange } = setup();
    await focus(input);
    fireEvent.change(input, { target: { value: '!prod' } });
    expect(options()).toEqual(['!environment:prod']);
    await press(input, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'neq', values: ['prod'] }]);
    // The `!` sits in front of the pill.
    expect(chipTexts()).toEqual(['environment:prod']);
    expect(screen.getByTestId('chip').previousSibling).toHaveTextContent('!');
  });

  it('commits typed text on comma and marks an unknown key red', async () => {
    const { input, onChange } = setup();
    await focus(input);
    fireEvent.change(input, { target: { value: 'team:web' } });
    expect(options()).toEqual(['Add filter team:web']);
    fireEvent.keyDown(input, { key: ',' });
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'team', op: 'eq', values: ['web'] }]);
    const chip = screen.getByTestId('chip');
    expect(chip).toHaveAttribute('data-invalid', 'true');
  });

  it('commits typed text on Enter once the list is closed and shows parse errors', async () => {
    const { input, onChange } = setup();
    await focus(input);
    fireEvent.change(input, { target: { value: 'path' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Expected key:value, got "path"')).toBeInTheDocument();
    expect(input).toHaveValue('path');
  });

  it('removes the last chip with Backspace on an empty input', async () => {
    const { input, onChange } = setup([
      { key: 'environment', op: 'eq', values: ['prod'] },
      { key: 'path', op: 'neq', values: ['/health'] },
    ]);
    await focus(input);
    await press(input, 'Backspace');
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'eq', values: ['prod'] }]);
    expect(chipTexts()).toEqual(['environment:prod']);

    fireEvent.change(input, { target: { value: 'x' } });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('removes a chip with its × and edits it on click', async () => {
    const { input, onChange } = setup([
      { key: 'environment', op: 'eq', values: ['prod'] },
      { key: 'path', op: 'eq', values: ['/orders'] },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Remove path:/orders' }));
    expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'eq', values: ['prod'] }]);

    await act(async () => fireEvent.click(screen.getByTestId('chip')));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(input).toHaveValue('environment:prod');
    expect(input).toHaveFocus();
  });

  it('splits a pasted list into chips', async () => {
    const { input, onChange } = setup();
    await focus(input);
    await act(async () =>
      fireEvent.paste(input, { clipboardData: { getData: () => 'environment:prod, !path:/health,bogus' } })
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { key: 'environment', op: 'eq', values: ['prod'] },
      { key: 'path', op: 'neq', values: ['/health'] },
    ]);
    expect(input).toHaveValue('bogus');
    expect(screen.getByText('Expected key:value, got "bogus"')).toBeInTheDocument();
  });

  it('does not suggest pairs that are already chips', async () => {
    const { input } = setup([{ key: 'environment', op: 'eq', values: ['prod'] }]);
    await focus(input);
    expect(options()).toEqual(['path:/orders', 'environment:staging']);
  });

  describe('boolean filters', () => {
    const type = (input: HTMLElement, value: string) => fireEvent.change(input, { target: { value } });

    it('suggests terms for the token after "(", AND, OR and NOT', async () => {
      const { input } = setup();
      await focus(input);
      type(input, '(');
      expect(options()).toEqual(['path:/orders', 'environment:prod', 'environment:staging']);
      type(input, '(path:/orders OR stag');
      expect(options()).toEqual(['environment:staging']);
      type(input, 'path:/orders AND NOT (pro');
      expect(options()).toEqual(['environment:prod']);
    });

    it('keeps editing when a pick leaves a group open and offers ")", AND and OR after a term', async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, '(stag');
      await press(input, 'Enter');
      expect(input).toHaveValue('(environment:staging ');
      expect(onChange).not.toHaveBeenCalled();
      expect(options()).toEqual([')', 'AND', 'OR']);

      await press(input, 'ArrowDown');
      await press(input, 'ArrowDown');
      await press(input, 'Enter');
      expect(input).toHaveValue('(environment:staging OR ');
      type(input, '(environment:staging OR prod');
      await press(input, 'Enter');
      expect(input).toHaveValue('(environment:staging OR environment:prod ');

      // ")" closes the last open group, so the pick commits the chip.
      await press(input, 'Enter');
      expect(onChange).toHaveBeenLastCalledWith([
        {
          op: 'or',
          items: [
            { key: 'environment', op: 'eq', values: ['staging'] },
            { key: 'environment', op: 'eq', values: ['prod'] },
          ],
        },
      ]);
      expect(input).toHaveValue('');
      expect(chipTexts()).toEqual(['(environment:staging OR environment:prod)']);
    });

    it('offers the operators matching a typed prefix and commits an OR at the top level as one chip', async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, 'environment:prod ');
      expect(options().slice(0, 3)).toEqual(['Add filter environment:prod', 'AND', 'OR']);
      type(input, 'environment:prod O');
      expect(options()[0]).toBe('OR');
      await press(input, 'Enter');
      expect(input).toHaveValue('environment:prod OR ');

      type(input, 'environment:prod OR /ord');
      await press(input, 'Enter');
      expect(onChange).toHaveBeenLastCalledWith([
        {
          op: 'or',
          items: [
            { key: 'environment', op: 'eq', values: ['prod'] },
            { key: 'path', op: 'eq', values: ['/orders'] },
          ],
        },
      ]);
    });

    it("suggests the key's values inside IN (…) and closes the list after a known value", async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, 'environment IN (');
      expect(options()).toEqual(['prod', 'staging']);
      type(input, 'environment NOT IN (prod, ');
      expect(options()).toEqual(['staging']);
      type(input, 'environment IN (st');
      expect(options()).toEqual(['staging', ')']);

      await press(input, 'Enter');
      expect(input).toHaveValue('environment IN (staging');
      expect(onChange).not.toHaveBeenCalled();
      expect(options()).toEqual([')']);
      await press(input, 'Enter');
      expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'in', values: ['staging'] }]);
    });

    it('keeps an IN list inside a group open after a value pick', async () => {
      const { input } = setup();
      await focus(input);
      type(input, '(path:/orders OR environment IN (pr');
      await press(input, 'Enter');
      expect(input).toHaveValue('(path:/orders OR environment IN (prod');
      await press(input, 'Enter');
      expect(input).toHaveValue('(path:/orders OR environment IN (prod) ');
      expect(options().slice(0, 3)).toEqual([')', 'AND', 'OR']);
    });

    it('commits with Enter after a complete expression and a space, and types on to a pair after a group', async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, '(path:/a OR path:/b) ');
      await press(input, 'Enter');
      expect(onChange).toHaveBeenLastCalledWith([
        {
          op: 'or',
          items: [
            { key: 'path', op: 'eq', values: ['/a'] },
            { key: 'path', op: 'eq', values: ['/b'] },
          ],
        },
      ]);

      type(input, '(path:/a OR path:/b) AND environment:stag');
      expect(options()[0]).toBe('environment:staging');
      await press(input, 'Enter');
      expect(onChange).toHaveBeenLastCalledWith([
        expect.objectContaining({ op: 'or' }),
        { key: 'environment', op: 'eq', values: ['staging'] },
      ]);
    });

    it('commits a typed expression with Enter, one chip per top-level AND item', async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, 'environment:prod AND (path:/a OR path:/b)');
      expect(options()[0]).toBe('Add filter environment:prod AND (path:/a OR path:/b)');
      await press(input, 'Enter');
      expect(onChange).toHaveBeenLastCalledWith([
        { key: 'environment', op: 'eq', values: ['prod'] },
        {
          op: 'or',
          items: [
            { key: 'path', op: 'eq', values: ['/a'] },
            { key: 'path', op: 'eq', values: ['/b'] },
          ],
        },
      ]);
      expect(chipTexts()).toEqual(['environment:prod', '(path:/a OR path:/b)']);
    });

    it('does not commit on a comma inside parentheses, and shows the error of unbalanced text', async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, '(environment:prod');
      fireEvent.keyDown(input, { key: ',' });
      expect(onChange).not.toHaveBeenCalled();
      fireEvent.keyDown(input, { key: 'Escape' });
      await press(input, 'Enter');
      expect(onChange).not.toHaveBeenCalled();
      expect(screen.getByText('Missing ")"')).toBeInTheDocument();
      expect(input).toHaveValue('(environment:prod');
    });

    it('shows a group as one chip, marks an unknown key in it and edits its text on click', async () => {
      const { input, onChange } = setup([
        {
          op: 'or',
          negated: true,
          items: [
            { key: 'environment', op: 'eq', values: ['prod'] },
            { key: 'path', op: 'neq', values: ['/health'] },
          ],
        },
        {
          op: 'or',
          items: [
            { key: 'team', op: 'eq', values: ['web'] },
            { key: 'path', op: 'eq', values: ['/x'] },
          ],
        },
      ]);
      expect(chipTexts()).toEqual(['NOT (environment:prod OR !path:/health)', '(team:web OR path:/x)']);
      expect(screen.getAllByTestId('chip').map((c) => c.getAttribute('data-invalid'))).toEqual([null, 'true']);

      await act(async () => fireEvent.click(screen.getAllByTestId('chip')[0]));
      expect(input).toHaveValue('NOT (environment:prod OR !path:/health)');
      expect(onChange).toHaveBeenLastCalledWith([
        {
          op: 'or',
          items: [
            { key: 'team', op: 'eq', values: ['web'] },
            { key: 'path', op: 'eq', values: ['/x'] },
          ],
        },
      ]);
      await press(input, 'Enter');
      expect(chipTexts()).toEqual(['(team:web OR path:/x)', 'NOT (environment:prod OR !path:/health)']);
    });

    describe('at a caret before the end', () => {
      // Types `value` with the caret right after `before`, as typing in the middle of the text does.
      const typeAt = (input: HTMLElement, before: string, after: string) =>
        fireEvent.change(input, {
          target: { value: before + after, selectionStart: before.length, selectionEnd: before.length },
        });

      it('suggests for the token at the caret in a group chip being edited and commits the group', async () => {
        const group: FilterItem = {
          op: 'or',
          items: [
            { key: 'environment', op: 'eq', values: ['prod'] },
            { key: 'path', op: 'eq', values: ['/orders'] },
          ],
        };
        const { input, onChange } = setup([group]);
        await act(async () => fireEvent.click(screen.getByTestId('chip')));
        expect(input).toHaveValue('(environment:prod OR path:/orders)');
        typeAt(input, '(environment:prod OR path:/orders OR stag', ')');
        expect(options()).toEqual(['environment:staging']);
        await press(input, 'Enter');
        expect(onChange).toHaveBeenLastCalledWith([
          { op: 'or', items: [...group.items, { key: 'environment', op: 'eq', values: ['staging'] }] },
        ]);
      });

      it('suggests inside "()" after the caret moved back', async () => {
        const { input, onChange } = setup();
        await focus(input);
        type(input, '()');
        (input as HTMLInputElement).setSelectionRange(1, 1);
        fireEvent.keyUp(input, { key: 'ArrowLeft' });
        expect(options()).toEqual(['path:/orders', 'environment:prod', 'environment:staging']);
        typeAt(input, '(stag', ')');
        expect(options()).toEqual(['environment:staging']);
        await press(input, 'Enter');
        expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'eq', values: ['staging'] }]);
      });

      it('suggests values in a closed IN list and then adds the whole text', async () => {
        const { input, onChange } = setup();
        await focus(input);
        typeAt(input, 'environment IN (st', ')');
        expect(options()).toEqual(['staging', 'Add filter environment IN (st)']);
        await press(input, 'Enter');
        fireEvent.keyUp(input, { key: 'Enter' });
        expect(input).toHaveValue('environment IN (staging)');
        expect((input as HTMLInputElement).selectionStart).toBe('environment IN (staging'.length);
        expect(options()).toEqual(['Add filter environment IN (staging)']);
        await press(input, 'Enter');
        expect(onChange).toHaveBeenLastCalledWith([{ key: 'environment', op: 'in', values: ['staging'] }]);
      });

      it('replaces only the token before the caret and keeps the rest', async () => {
        const { input, onChange } = setup();
        await focus(input);
        typeAt(input, 'environment:stag', ' OR path:/orders');
        expect(options()[0]).toBe('environment:staging');
        await press(input, 'Enter');
        expect(onChange).toHaveBeenLastCalledWith([
          {
            op: 'or',
            items: [
              { key: 'environment', op: 'eq', values: ['staging'] },
              { key: 'path', op: 'eq', values: ['/orders'] },
            ],
          },
        ]);

        typeAt(input, '(path:/orders OR pro', ' AND (environment:staging OR path:/x)');
        await press(input, 'Enter');
        expect(input).toHaveValue('(path:/orders OR environment:prod AND (environment:staging OR path:/x)');
        expect(options().slice(0, 3)).toEqual([')', 'AND', 'OR']);
      });

      it('does not commit on a comma inside a closed group', async () => {
        const { input, onChange } = setup();
        await focus(input);
        typeAt(input, '(environment:prod', ')');
        fireEvent.keyDown(input, { key: ',' });
        expect(onChange).not.toHaveBeenCalled();
      });
    });

    it('inserts a pasted list into typed text instead of splitting it into chips', async () => {
      const { input, onChange } = setup();
      await focus(input);
      type(input, '(environment:prod OR ');
      const pasted = 'path:/orders, environment:staging';
      expect(fireEvent.paste(input, { clipboardData: { getData: () => pasted } })).toBe(true);
      expect(onChange).not.toHaveBeenCalled();
      expect(input).toHaveValue('(environment:prod OR ');
    });

    it('narrows suggestions by the top-level terms only', async () => {
      const { input, tagPairs } = setup([
        { key: 'environment', op: 'eq', values: ['prod'] },
        {
          op: 'or',
          items: [
            { key: 'path', op: 'eq', values: ['/a'] },
            { key: 'path', op: 'eq', values: ['/b'] },
          ],
        },
      ]);
      await focus(input);
      expect(tagPairs.mock.calls[0][1]).toEqual([{ key: 'environment', op: 'eq', values: ['prod'] }]);
    });
  });
});
