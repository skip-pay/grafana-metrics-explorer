import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { Catalog, TagPair } from '../../catalog';
import { ResolvedMetric, TagFilter } from '../../model/types';
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

jest.mock('../../compile', () => ({
  parseFilterText: (text: string) => {
    const negated = text.startsWith('!');
    const body = negated ? text.slice(1) : text;
    const colon = body.indexOf(':');
    if (colon <= 0 || colon === body.length - 1) {
      return { error: `Expected key:value, got "${text}"` };
    }
    return { key: body.slice(0, colon), op: negated ? 'neq' : 'eq', values: [body.slice(colon + 1)] };
  },
  filterToText: (f: { key: string; op: string; values: string[] }) =>
    `${f.op === 'neq' ? '!' : ''}${f.key}:${f.values[0]}`,
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

function setup(initial: TagFilter[] = []) {
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
});
