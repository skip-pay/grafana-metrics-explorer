import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { createDataFrame, dateTime, FieldType, LoadingState, PanelData } from '@grafana/data';
import { PanelRendererProps } from '@grafana/runtime';
import { PanelContext, SeriesVisibilityChangeMode } from '@grafana/ui';

import { ChartModel } from '../engine';
import { ChartArea, MIN_CHART_HEIGHT, MIN_TILE_HEIGHT, splitColumns } from './ChartArea';

const mockRendered: Array<{ props: PanelRendererProps; context: PanelContext }> = [];

jest.mock('@grafana/runtime', () => {
  const { usePanelContext } = jest.requireActual('@grafana/ui');
  return {
    PanelRenderer: (props: PanelRendererProps) => {
      mockRendered.push({ props, context: usePanelContext() });
      return <div data-testid="panel" />;
    },
  };
});

const chart = (title: string, names: string[]): ChartModel => {
  const t = dateTime(0);
  const data: PanelData = {
    state: LoadingState.Done,
    timeRange: { from: t, to: t, raw: { from: t, to: t } },
    series: names.map((name) =>
      createDataFrame({
        fields: [
          { name: 'time', type: FieldType.time, values: [1] },
          { name: 'value', type: FieldType.number, values: [1], config: { displayName: name } },
        ],
      })
    ),
  };
  return { title, pluginId: 'timeseries', data, options: {}, fieldConfig: { defaults: {}, overrides: [] } };
};

const props = {
  title: 'avg:cpu{*}',
  charts: [] as ChartModel[],
  split: false,
  loading: false,
  errors: [] as string[],
  warnings: [] as string[],
  empty: false,
  width: 1000,
  height: 600,
  timeZone: 'utc',
  onChangeTimeRange: jest.fn(),
};

const lastRendered = () => mockRendered[mockRendered.length - 1];

describe('ChartArea', () => {
  beforeEach(() => {
    mockRendered.length = 0;
  });

  it('asks for a metric while no query has one', () => {
    render(<ChartArea {...props} empty />);
    expect(screen.getByText('Pick a metric to start')).toBeInTheDocument();
    expect(screen.queryByText('avg:cpu{*}')).not.toBeInTheDocument();
  });

  it('says "No data" for a finished run without series', () => {
    render(<ChartArea {...props} charts={[chart('', [])]} />);
    expect(screen.getByText('No data')).toBeInTheDocument();
  });

  it('shows no "No data" while loading or failing', () => {
    const { rerender } = render(<ChartArea {...props} loading />);
    expect(screen.queryByText('No data')).not.toBeInTheDocument();
    rerender(<ChartArea {...props} errors={['boom', 'second']} warnings={['careful']} />);
    expect(screen.queryByText('No data')).not.toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
    expect(screen.getByText('careful')).toBeInTheDocument();
  });

  it('renders one chart filling the area in its own panel context', () => {
    render(<ChartArea {...props} charts={[chart('', ['a', 'b'])]} />);
    expect(screen.getByText('avg:cpu{*}')).toBeInTheDocument();
    const { props: rendered, context } = lastRendered();
    expect(rendered).toMatchObject({ pluginId: 'timeseries', width: 1000 - 18, height: 600 - 18, timeZone: 'utc' });
    expect(rendered.onChangeTimeRange).toBe(props.onChangeTimeRange);
    expect(context.eventsScope).toBe('mx');
  });

  it('never makes a chart shorter than the minimum', () => {
    render(<ChartArea {...props} height={100} charts={[chart('', ['a'])]} />);
    expect(lastRendered().props.height).toBe(MIN_CHART_HEIGHT);
  });

  it('isolates a series on a legend click and shows all again on a second click', () => {
    render(<ChartArea {...props} charts={[chart('', ['a', 'b'])]} />);
    act(() => lastRendered().context.onToggleSeriesVisibility!('a', SeriesVisibilityChangeMode.ToggleSelection));
    const overrides = lastRendered().props.fieldConfig?.overrides ?? [];
    expect(overrides).toHaveLength(1);
    expect(overrides[0].matcher.options).toMatchObject({ names: ['a'] });

    act(() => lastRendered().context.onToggleSeriesVisibility!('a', SeriesVisibilityChangeMode.ToggleSelection));
    expect(lastRendered().props.fieldConfig?.overrides).toEqual([]);
  });

  it('forgets hidden series when the chart shows other series', () => {
    const { rerender } = render(<ChartArea {...props} charts={[chart('', ['a', 'b'])]} />);
    act(() => lastRendered().context.onToggleSeriesVisibility!('a', SeriesVisibilityChangeMode.ToggleSelection));
    rerender(<ChartArea {...props} charts={[chart('', ['a', 'c'])]} />);
    expect(lastRendered().props.fieldConfig?.overrides).toEqual([]);
  });

  it('lays split charts out in a grid of tiles titled by the tag value', () => {
    const charts = ['env:a', 'env:b', 'env:c', 'env:d'].map((t) => chart(t, ['x']));
    render(<ChartArea {...props} split splitKey="env" width={1200} charts={charts} />);
    expect(screen.getAllByTestId('panel')).toHaveLength(4);
    expect(screen.getByText('c')).toHaveAttribute('title', 'env:c');
    // Inner size 1182 x 582: 3 columns and 2 rows, minus the gaps and the tile titles.
    const widths = mockRendered.slice(-4).map((r) => r.props.width);
    expect(new Set(widths)).toEqual(new Set([Math.floor((1182 - 2 * 8) / 3)]));
    expect(lastRendered().props.height).toBe(Math.floor((582 - 8) / 2) - 22);
  });

  it('keeps split tiles at the minimum height and leaves room for the scrollbar', () => {
    const charts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => chart(`env:${t}`, ['x']));
    render(<ChartArea {...props} split width={800} charts={charts} />);
    expect(lastRendered().props.height).toBe(MIN_TILE_HEIGHT);
    expect(lastRendered().props.width).toBe(Math.floor((782 - 16 - 8) / 2));
  });

  it('stacks the tiles of a split by query in one column', () => {
    const charts = ['avg:cpu{*}', 'avg:mem{*}'].map((t) => chart(t, ['x']));
    render(<ChartArea {...props} split stacked width={1200} charts={charts} />);
    expect(screen.getByText('avg:mem{*}')).toBeInTheDocument();
    // Inner size 1182 x 582: 1 column and 2 rows.
    expect(lastRendered().props.width).toBe(1182);
    expect(lastRendered().props.height).toBe(Math.floor((582 - 8) / 2) - 22);
  });

  it('uses 3 columns, 1 or 2 on narrow widths, never more than charts', () => {
    expect(splitColumns(400, 12)).toBe(1);
    expect(splitColumns(700, 12)).toBe(2);
    expect(splitColumns(1200, 12)).toBe(3);
    expect(splitColumns(2000, 12)).toBe(3);
    expect(splitColumns(2000, 1)).toBe(1);
  });
});
