import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Subject } from 'rxjs';
import { dateTime, UrlQueryMap } from '@grafana/data';
import { locationService } from '@grafana/runtime';

import { MetricInfo, ResolvedMetric } from '../model/types';
import { URL_PARAM } from '../model/url';
import { Explorer } from './Explorer';

const cpu: MetricInfo = { name: 'cpu', kind: 'gauge', streams: { base: 'cpu' }, unit: 'percent' };
const requests: MetricInfo = { name: 'requests', kind: 'delta_counter', streams: { base: 'requests' } };
const mockCatalog = {
  datasourceUid: 'ds',
  listMetrics: jest.fn(async () => [cpu, requests]),
  getMetric: jest.fn(async () => cpu),
  resolve: jest.fn(async (name: string): Promise<ResolvedMetric> => ({
    ...(name === requests.name ? requests : cpu),
    temporality: { delta: false, cumulative: false },
    labelKeys: ['env', 'start_time'],
    hasInstanceId: false,
    nativeIntervalSec: 60,
  })),
  labelValues: jest.fn(async () => []),
  tagPairs: jest.fn(async () => []),
};
const mockLocation = { search: {} as UrlQueryMap, changes: new Subject<void>() };

jest.mock('@grafana/runtime', () => ({
  locationService: {
    getSearchObject: jest.fn(() => mockLocation.search),
    partial: jest.fn((query: UrlQueryMap) => {
      const search = { ...mockLocation.search, ...query };
      mockLocation.search = Object.fromEntries(Object.entries(search).filter(([, v]) => v !== null));
      mockLocation.changes.next();
    }),
    getLocationObservable: jest.fn(() => mockLocation.changes.asObservable()),
  },
  createQueryRunner: () => ({
    get: () => new Subject(),
    run: jest.fn(),
    cancel: jest.fn(),
    destroy: jest.fn(),
  }),
  getDataSourceSrv: jest.fn(),
  getAppEvents: () => ({ publish: jest.fn() }),
  PanelRenderer: () => <div data-testid="panel" />,
}));
jest.mock('../catalog', () => ({ ...jest.requireActual('../catalog'), getCatalog: () => mockCatalog }));

const urlState = () => JSON.parse(mockLocation.search[URL_PARAM] as string);

const renderExplorer = () => {
  const t = dateTime(Date.now());
  const from = dateTime(t.valueOf() - 3600_000);
  return render(
    <Explorer
      width={1200}
      height={800}
      timeRange={{ from, to: t, raw: { from: 'now-1h', to: 'now' } }}
      timeZone="utc"
      onChangeTimeRange={jest.fn()}
      options={{ datasourceUid: 'ds', maxRangeHours: 24 }}
    />
  );
};

describe('Explorer', () => {
  beforeEach(() => {
    mockLocation.search = {};
    (locationService.partial as jest.Mock).mockClear();
    localStorage.clear();
  });

  it('renders the toolbar and the empty state, and writes the state to the URL', async () => {
    renderExplorer();
    await act(async () => {});
    expect(screen.getByText('Visualization:')).toBeInTheDocument();
    expect(screen.getByText('Timeseries')).toBeInTheDocument();
    expect(screen.getByText('Display:')).toBeInTheDocument();
    expect(screen.getByText('Split by:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
    expect(screen.getByText('Pick a metric to start')).toBeInTheDocument();
    expect(urlState().queries).toHaveLength(1);
    expect(mockCatalog.listMetrics).toHaveBeenCalled();
  });

  it('adds queries and formulas', async () => {
    renderExplorer();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /Add Query/ }));
    expect(urlState().queries.map((q: { letter: string }) => q.letter)).toEqual(['a', 'b']);
    fireEvent.click(screen.getByRole('button', { name: /Add Formula/ }));
    expect(urlState().formulas).toHaveLength(1);
  });

  it('shows the aggregation controls for a top list', async () => {
    mockLocation.search = { [URL_PARAM]: JSON.stringify({ v: 1, viz: 'toplist' }) };
    renderExplorer();
    await act(async () => {});
    expect(screen.getByText('Aggregation:')).toBeInTheDocument();
    expect(screen.getByText('Limit:')).toBeInTheDocument();
    expect(screen.queryByText('Split by:')).not.toBeInTheDocument();
    // Share stays on the split line.
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  it('lists the implemented visualizations in order', async () => {
    renderExplorer();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Visualization' }));
    const labels = [
      'Timeseries',
      'Query Value',
      'Table',
      'Heatmap',
      'Distribution',
      'Top List',
      'Bar Chart',
      'Pie Chart',
    ];
    const options = screen.getAllByRole('menuitemradio');
    expect(options).toHaveLength(labels.length);
    // Each option reads `<label> <subtitle>`.
    options.forEach((o, i) => expect(o).toHaveAccessibleName(new RegExp(`^${labels[i]} [A-Z]`)));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Pie Chart/ }));
    expect(urlState().viz).toBe('piechart');
  });

  it('turns Display pink for a visible counter and blocks deleting a query used by a formula', async () => {
    const state = {
      v: 1,
      queries: [
        { letter: 'a', metric: 'requests' },
        { letter: 'b', metric: 'cpu' },
      ],
      formulas: [{ expression: 'a * 2' }],
    };
    mockLocation.search = { [URL_PARAM]: JSON.stringify(state) };
    renderExplorer();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Display' }).className).not.toBe(
      screen.getByRole('button', { name: 'Style' }).className
    );
    const [deleteA, deleteB] = screen.getAllByRole('button', { name: 'Delete query' });
    expect(deleteA).toBeDisabled();
    expect(deleteB).toBeEnabled();
  });

  it('resolves a picked metric and offers its tag keys to split by', async () => {
    mockLocation.search = { [URL_PARAM]: JSON.stringify({ v: 1, queries: [{ letter: 'a', metric: 'cpu' }] }) };
    renderExplorer();
    await act(async () => {});
    expect(mockCatalog.resolve).toHaveBeenCalledWith('cpu', expect.anything());
    expect(screen.queryByText('Pick a metric to start')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Split by' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Query/ }));
    expect(urlState().split).toMatchObject({ byQuery: true, key: null });
    expect(screen.queryByText('One graph per')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Split by' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /^Tags/ }));
    expect(urlState().split).toMatchObject({ byQuery: false, key: 'env' });
    expect(screen.getByText('One graph per')).toBeInTheDocument();
    expect(screen.getByText('Limit to')).toBeInTheDocument();
    expect(screen.getByText('Sort by')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'One graph per' }));
    // `start_time` is a noise key and not offered.
    expect(screen.getAllByRole('menuitemradio').map((o) => o.textContent)).toEqual(['env']);
    fireEvent.click(screen.getByRole('button', { name: 'Limit order' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Bottom' }));
    expect(urlState().split).toMatchObject({ key: 'env', order: 'bottom' });
    // Lets the catalogue calls the split starts settle inside act.
    await act(async () => {});
  });

  it('opens a readable link: formulas over hidden rows, a warning for what did not parse, and mx in the URL', async () => {
    mockLocation.search = {
      q: ['sum:requests{*}.as_count()', 'avg:cpu{*}'],
      f: ['a/b*100', 'a/'],
      viz: 'timeseries',
      display: 'bars',
      from: 'now-1h',
    };
    renderExplorer();
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Show query a' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show query b' })).toBeInTheDocument();
    expect(
      screen.getAllByRole('textbox', { name: 'Formula expression' }).map((i) => (i as HTMLInputElement).value)
    ).toEqual(['a/b*100']);
    expect(screen.getByText(/Ignored link parameters: f=a\/ \(/)).toBeInTheDocument();
    expect(Object.keys(mockLocation.search).sort()).toEqual(['from', URL_PARAM]);
    expect(urlState()).toMatchObject({ display: { display: 'bars' }, formulas: [{ expression: 'a/b*100' }] });
    expect(locationService.partial).toHaveBeenCalledWith(expect.objectContaining({ q: null, f: null }), true);
  });
});
