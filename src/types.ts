export interface PanelOptions {
  /** Uid of a Prometheus datasource; empty picks one (see resolveDatasourceUid). */
  datasourceUid: string;
  maxRangeHours: number;
}
