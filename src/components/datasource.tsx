import React from 'react';
import { StandardEditorProps } from '@grafana/data';
import { DataSourcePicker, getDataSourceSrv } from '@grafana/runtime';

// Filtering by plugin id rather than by type keeps Grafana's built-in datasource out of the lists.
const PROMETHEUS = 'prometheus';

/**
 * The datasource the panel queries: the configured uid while it names a Prometheus datasource (an imported
 * dashboard can carry one from another instance), else the instance's default datasource when it is a Prometheus
 * one, else the first Prometheus datasource; undefined when there is none.
 */
export function resolveDatasourceUid(configured: string | undefined): string | undefined {
  /* eslint-disable @typescript-eslint/no-deprecated -- the replacements exist only in @grafana/runtime/unstable */
  const srv = getDataSourceSrv();
  if (configured && srv.getInstanceSettings(configured)?.type === PROMETHEUS) {
    return configured;
  }
  const fallback = srv.getInstanceSettings(null);
  if (fallback?.type === PROMETHEUS) {
    return fallback.uid;
  }
  return srv.getList({ pluginId: PROMETHEUS })[0]?.uid;
  /* eslint-enable @typescript-eslint/no-deprecated */
}

/** Panel option editor for `datasourceUid`: Prometheus datasources only; clearing it falls back to the default. */
export const DatasourceEditor = ({ value, onChange }: StandardEditorProps<string>) => (
  <DataSourcePicker
    current={value || null}
    pluginId={PROMETHEUS}
    noDefault
    placeholder="Default Prometheus datasource"
    onChange={(ds) => onChange(ds.uid)}
    onClear={() => onChange('')}
  />
);
