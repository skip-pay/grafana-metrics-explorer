import { PanelPlugin } from '@grafana/data';

import { DatasourceEditor } from './components/datasource';
import { MetricsExplorerPanel } from './components/MetricsExplorerPanel';
import { PanelOptions } from './types';

export const plugin = new PanelPlugin<PanelOptions>(MetricsExplorerPanel).setPanelOptions((builder) =>
  builder
    .addCustomEditor({
      id: 'datasourceUid',
      path: 'datasourceUid',
      name: 'Datasource',
      description: 'Prometheus datasource the explorer queries; empty picks the default Prometheus datasource',
      editor: DatasourceEditor,
      defaultValue: '',
    })
    .addNumberInput({
      path: 'maxRangeHours',
      name: 'Max time range (hours)',
      description: 'Longer dashboard time ranges are refused instead of queried',
      defaultValue: 24,
    })
);
