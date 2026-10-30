export type SpaceAgg = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'p50' | 'p75' | 'p90' | 'p95' | 'p99';
export type TimeAgg = 'avg' | 'sum' | 'min' | 'max' | 'count' | 'last';
export type Reducer = 'avg' | 'sum' | 'min' | 'max' | 'last';

/** How a metric is stored, which decides the PromQL template. */
export type MetricKind =
  | 'gauge'               // plain gauge (incl. scraped/OTel gauges)
  | 'delta_counter'       // counter with aggregation_temporality=DELTA series (OTel delta export)
  | 'cumulative_counter'  // counter with only cumulative series (e.g. scraped *_total)
  | 'distribution'        // histogram: <m>_bucket/_count/_sum[/_min/_max]
  | 'cloudwatch';         // CloudWatch metric-stream summary: <m>{quantile="0"|"1"} + <m>_sum + <m>_count

export interface MetricStreams {
  base?: string;   // the bare stream, if it exists
  bucket?: string; count?: string; sum?: string; min?: string; max?: string;
}

export interface MetricInfo {
  name: string;               // logical name shown to the user
  kind: MetricKind;           // inferred from names + metadata; refined by resolve()
  streams: MetricStreams;
  unit?: string;              // Grafana unit id, e.g. 'percent', 's', 'ms', 'bytes', 'short'
  unitLabel?: string;         // human axis label, e.g. 'Percent', 'Seconds'
  help?: string;
  metadataType?: string;      // raw /api/v1/metadata type
}

export interface ResolvedMetric extends MetricInfo {
  temporality: { delta: boolean; cumulative: boolean };  // from aggregation_temporality values
  labelKeys: string[];        // all label keys of the relevant stream(s), sorted, without __name__
  hasInstanceId: boolean;
  nativeIntervalSec: number;  // export or scrape interval in seconds, detected on resolve; steps are its multiples
}

export type FilterOp = 'eq' | 'neq' | 'in' | 'not_in';
/** One term of the "from" field. eq/neq carry exactly one value which may contain `*` wildcards;
 *  `key:*` (has tag) is eq with value '*'. */
export interface TagFilter { key: string; op: FilterOp; values: string[] }
/** A parenthesised group of the "from" field: its items joined by AND or OR, the whole negated by NOT. */
export interface FilterGroup { op: 'and' | 'or'; negated?: boolean; items: FilterItem[] }
/** One chip of the "from" field; a query's filters are ANDed. */
export type FilterItem = TagFilter | FilterGroup;

export interface FunctionCall { id: string; name: string; args: Array<number | string> }

export interface MetricQuery {
  kind: 'query';
  id: string;                 // stable id for React keys
  letter: string;             // 'a', 'b', ... (assigned on creation, never reused while the row exists)
  hidden: boolean;            // letter badge toggle; hidden queries still feed formulas
  metric: string;             // logical metric name, '' until chosen
  filters: FilterItem[];
  spaceAgg: SpaceAgg;
  groupBy: string[];
  functions: FunctionCall[];  // modifiers (rollup, as_count, as_rate, fill, timeshift…) and functions, in UI order
  alias?: string;
  color?: string;             // per-query override: a hex colour (ungrouped) or a PaletteId (grouped)
}

export interface FormulaQuery {
  kind: 'formula';
  id: string;
  expression: string;         // e.g. 'a / b * 100', 'top(a, 10, "mean", "desc")'
  hidden: boolean;
  alias?: string;
}

export type Visualization =
  | 'timeseries' | 'queryvalue' | 'table' | 'heatmap' | 'distribution' | 'toplist' | 'barchart' | 'piechart';
export type DisplayType = 'lines' | 'bars' | 'areas';
export type LineStyle = 'solid' | 'dashed' | 'dotted';
export type Stroke = 'thin' | 'normal' | 'thick';
export type PaletteId =
  | 'consistent' | 'classic' | 'cool' | 'warm' | 'purple' | 'orange' | 'gray' | 'red' | 'green' | 'blue' | 'vivid';

export interface DisplayOptions {
  display: DisplayType;
  showLabels: boolean;
  lineStyle: LineStyle;
  stroke: Stroke;
  palette: PaletteId;
  orderBy: 'tags' | 'values';
  reverse: boolean;
}

export interface SplitOptions {
  key: string | null;
  limit: number;                // 6, 12, 24, 48
  order: 'top' | 'bottom';
  sortBy: Reducer;              // ranks the split values
}

export interface ExplorerState {
  v: 1;
  viz: Visualization;
  queries: MetricQuery[];       // at least one
  formulas: FormulaQuery[];
  display: DisplayOptions;
  split: SplitOptions;
  reducer: Reducer;             // toplist / queryvalue / table
  toplistLimit: number;         // 10, 25, 50, 100
}

/** Aggregated result series, the unit the engine works on. */
export interface Series {
  refLetter: string;            // query letter, or 'f1', 'f2'… for formulas
  labels: Record<string, string>;  // group-by labels only
  times: number[];              // ms epoch, ascending, shared grid within one plan
  values: Array<number | null>;
  name: string;                 // legend name
  unit?: string;
}
