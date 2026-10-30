import React, { useMemo } from 'react';
import { PanelProps } from '@grafana/data';
import { Alert } from '@grafana/ui';

import { PanelOptions } from '../types';
import { Explorer } from '../ui/Explorer';
import { resolveDatasourceUid } from './datasource';

type Props = PanelProps<PanelOptions>;

export const MetricsExplorerPanel = ({
  width,
  height,
  timeRange,
  timeZone,
  onChangeTimeRange,
  options,
  eventBus,
}: Props) => {
  const datasourceUid = useMemo(() => resolveDatasourceUid(options.datasourceUid), [options.datasourceUid]);
  if (!datasourceUid) {
    return (
      <div style={{ width, height, padding: 8 }}>
        <Alert severity="info" title="No Prometheus datasource">
          The explorer queries a Prometheus datasource. Add one under Connections → Data sources.
        </Alert>
      </div>
    );
  }
  return (
    <Explorer
      width={width}
      height={height}
      timeRange={timeRange}
      timeZone={timeZone}
      onChangeTimeRange={onChangeTimeRange}
      options={{ ...options, datasourceUid }}
      eventBus={eventBus}
    />
  );
};
