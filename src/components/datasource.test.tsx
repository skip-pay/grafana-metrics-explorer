import React from 'react';
import { render, screen } from '@testing-library/react';
import { DataSourceInstanceSettings, getDefaultTimeRange, PanelProps, StandardEditorProps } from '@grafana/data';
import { DataSourcePickerProps, getDataSourceSrv } from '@grafana/runtime';

import { PanelOptions } from '../types';
import { DatasourceEditor, resolveDatasourceUid } from './datasource';
import { MetricsExplorerPanel } from './MetricsExplorerPanel';

const mockPicker = jest.fn((_: DataSourcePickerProps) => <div data-testid="picker" />);

jest.mock('@grafana/runtime', () => ({
  getDataSourceSrv: jest.fn(),
  DataSourcePicker: (props: DataSourcePickerProps) => mockPicker(props),
}));
jest.mock('../ui/Explorer', () => ({
  Explorer: ({ options }: { options: PanelOptions }) => <div data-testid="explorer">{options.datasourceUid}</div>,
}));

const ds = (uid: string, type: string) => ({ uid, type, meta: { id: type } }) as DataSourceInstanceSettings;
const prometheus = [ds('prom-1', 'prometheus'), ds('prom-2', 'prometheus')];

const setDatasources = (fallback: DataSourceInstanceSettings | undefined, all: DataSourceInstanceSettings[]) => {
  const srv = {
    getInstanceSettings: jest.fn((uid: string | null) => (uid === null ? fallback : all.find((d) => d.uid === uid))),
    getList: jest.fn(({ pluginId }: { pluginId: string }) => all.filter((d) => d.meta.id === pluginId)),
  };
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the code under test uses it, see datasource.tsx
  (getDataSourceSrv as jest.Mock).mockReturnValue(srv);
  return srv;
};

describe('resolveDatasourceUid', () => {
  it('keeps a configured Prometheus uid', () => {
    const srv = setDatasources(prometheus[0], prometheus);
    expect(resolveDatasourceUid('prom-2')).toBe('prom-2');
    expect(srv.getList).not.toHaveBeenCalled();
  });

  it('falls back when the configured uid is missing or not a Prometheus datasource', () => {
    setDatasources(prometheus[0], [ds('logs', 'loki'), ...prometheus]);
    expect(resolveDatasourceUid('from-another-instance')).toBe('prom-1');
    expect(resolveDatasourceUid('logs')).toBe('prom-1');
  });

  it('takes the default datasource when it is a Prometheus one', () => {
    const srv = setDatasources(prometheus[1], prometheus);
    expect(resolveDatasourceUid('')).toBe('prom-2');
    expect(srv.getInstanceSettings).toHaveBeenCalledWith(null);
  });

  it('takes the first Prometheus datasource when the default is of another type', () => {
    setDatasources(ds('logs', 'loki'), [ds('logs', 'loki'), ...prometheus]);
    expect(resolveDatasourceUid(undefined)).toBe('prom-1');
  });

  it('finds nothing without a Prometheus datasource', () => {
    setDatasources(ds('logs', 'loki'), [ds('logs', 'loki')]);
    expect(resolveDatasourceUid('')).toBeUndefined();
  });
});

describe('MetricsExplorerPanel', () => {
  const renderPanel = (datasourceUid: string) =>
    render(
      <MetricsExplorerPanel
        {...({
          width: 800,
          height: 600,
          timeRange: getDefaultTimeRange(),
          timeZone: 'utc',
        } as PanelProps<PanelOptions>)}
        options={{ datasourceUid, maxRangeHours: 24 }}
      />
    );

  it('runs the explorer on the resolved datasource', () => {
    setDatasources(prometheus[0], prometheus);
    renderPanel('');
    expect(screen.getByTestId('explorer')).toHaveTextContent('prom-1');
  });

  it('explains that a Prometheus datasource is needed when there is none', () => {
    setDatasources(undefined, []);
    renderPanel('');
    expect(screen.queryByTestId('explorer')).not.toBeInTheDocument();
    expect(screen.getByText('No Prometheus datasource')).toBeInTheDocument();
  });
});

describe('DatasourceEditor', () => {
  it('offers Prometheus datasources and stores the uid, empty when cleared', () => {
    const onChange = jest.fn();
    const props = { value: '', onChange } as unknown as StandardEditorProps<string>;
    const { rerender } = render(<DatasourceEditor {...props} />);
    const picker = mockPicker.mock.lastCall![0];
    expect(picker).toMatchObject({ current: null, pluginId: 'prometheus', noDefault: true });

    picker.onChange(prometheus[1]);
    expect(onChange).toHaveBeenLastCalledWith('prom-2');
    picker.onClear!();
    expect(onChange).toHaveBeenLastCalledWith('');

    rerender(<DatasourceEditor {...props} value="prom-1" />);
    expect(mockPicker.mock.lastCall![0].current).toBe('prom-1');
  });
});
