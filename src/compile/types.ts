import { FunctionCall, MetricInfo, ResolvedMetric } from '../model/types';

export interface FunctionParam {
  name: string;
  kind: 'number' | 'enum' | 'string';
  options?: Array<string | number>;
  default: string | number;
}

export interface FunctionDef {
  name: string;
  category: string;
  label: string;
  description: string;
  params: FunctionParam[];
  stage: 'modifier' | 'post';
  /** Post functions: PromQL wrapper usable while the chain is still server side. */
  promql?: (inner: string, args: Array<number | string>, ctx: { stepSec: number }) => string;
  /** Post functions: key of the client implementation in the engine (the function name). */
  client?: string;
  formulaOnly?: boolean;
}

export type FillMethod = 'null' | 'zero' | 'linear' | 'last';

export interface CompiledQuery {
  letter: string;
  refId: string;
  expr: string;
  stepSec: number;
  windowSec: number;
  /** Post functions that run on the client, in order, after the PromQL result. */
  clientChain: FunctionCall[];
  fill?: { method: FillMethod; limitSec: number };
  textForm: string;
  warnings: string[];
  /** Group-by keys as run: the query's own plus the split key on a timeseries, none for a query value. */
  groupBy: string[];
  /**
   * Grouped queries only: `expr` limited to the GROUP_LIMIT groups with the highest value over the range, for the
   * runner to send instead of `expr` when the estimated group count is above that limit.
   */
  cappedExpr?: string;
  /** Reason the query is not run (no metric, an unknown tag key…), shown to the user; `expr` is then empty. */
  skip?: string;
  /** The metric is not resolved yet, so the kind is provisional; the runner should wait for resolve() and recompile. */
  unresolved?: boolean;
}

export interface CompiledFormula {
  id: string;
  refLetter: string;
  expression: string;
  alias?: string;
  hidden: boolean;
}

export interface CompiledPlan {
  stepSec: number;
  queries: CompiledQuery[];
  formulas: CompiledFormula[];
  title: string;
  errors: string[];
}

export interface CompileContext {
  /** ms epoch */
  range: { from: number; to: number };
  widthPx: number;
  metrics: Record<string, ResolvedMetric | MetricInfo | undefined>;
  maxRangeHours: number;
}
