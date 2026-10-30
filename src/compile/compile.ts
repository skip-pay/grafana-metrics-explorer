import { formulaError } from '../engine/formula';
import { ExplorerState, FunctionCall, MetricQuery } from '../model/types';
import { filtersToMatchers, isValidLabelKey } from './filters';
import { getFunction, isDottedModifier, normalizeArgs, timeshiftOffsetSec } from './functions';
import { buildTemplate, capGroups, isResolved, RollupAgg, TemplateInput } from './promql';
import { cadenceSec, chooseStep } from './step';
import { renderQueryText } from './text';
import { CompileContext, CompiledFormula, CompiledPlan, CompiledQuery, FillMethod } from './types';

const HOUR_MS = 3600_000;
const METRIC_NAME = /^[A-Za-z_:][A-Za-z0-9_:]*$/;

interface Modifiers {
  countMode: 'as_count' | 'as_rate';
  rollupAgg?: RollupAgg;
  rollupSec?: number;
  fill?: { method: FillMethod; limitSec: number };
  offsetSec: number;
  warnings: string[];
}

/** Modifiers apply to the query wherever they sit in the list; the last one of a kind wins, timeshifts add up. */
function readModifiers(functions: FunctionCall[]): Modifiers {
  const mods: Modifiers = { countMode: 'as_count', offsetSec: 0, warnings: [] };
  for (const call of functions) {
    const def = getFunction(call.name);
    if (!def || def.stage !== 'modifier') {
      continue;
    }
    const { args, error } = normalizeArgs(def, call.args);
    if (error) {
      mods.warnings.push(error);
    }
    switch (call.name) {
      case 'as_count':
      case 'as_rate':
        mods.countMode = call.name;
        break;
      case 'rollup':
        mods.rollupAgg = args[0] as RollupAgg;
        // 0 (or less) keeps the automatic interval.
        mods.rollupSec = Number(args[1]) > 0 ? Math.round(Number(args[1])) : undefined;
        break;
      case 'fill':
        mods.fill = { method: args[0] as FillMethod, limitSec: Number(args[1]) };
        break;
      default:
        mods.offsetSec += timeshiftOffsetSec({ ...call, args }) ?? 0;
    }
  }
  return mods;
}

/** Group-by keys as run: the split key joins them on timeseries, a query value has none. */
function effectiveGroupBy(q: MetricQuery, state: ExplorerState): string[] {
  if (state.viz === 'queryvalue') {
    return [];
  }
  const split = state.viz === 'timeseries' ? state.split.key : null;
  return split && !q.groupBy.includes(split) ? [...q.groupBy, split] : q.groupBy;
}

function compileQuery(
  q: MetricQuery,
  state: ExplorerState,
  ctx: CompileContext,
  stepSec: number,
  rangeSec: number
): CompiledQuery {
  const info = ctx.metrics[q.metric];
  const groupBy = effectiveGroupBy(q, state);
  const out: CompiledQuery = {
    letter: q.letter,
    refId: q.letter,
    expr: '',
    stepSec,
    windowSec: stepSec,
    clientChain: [],
    textForm: renderQueryText(q, info),
    warnings: [],
    groupBy,
  };
  const skip = (reason: string): CompiledQuery => ({ ...out, expr: '', clientChain: [], skip: reason });

  if (q.metric === '') {
    return skip('Choose a metric');
  }
  if (!isResolved(info)) {
    out.unresolved = true;
  }
  if (!METRIC_NAME.test(q.metric)) {
    return skip(`Invalid metric name "${q.metric}"`);
  }
  for (const key of [...q.filters.map((f) => f.key), ...groupBy]) {
    if (!isValidLabelKey(key)) {
      return skip(`Invalid tag key "${key}"`);
    }
  }
  if (isResolved(info)) {
    const unknown = q.filters.find((f) => !info.labelKeys.includes(f.key));
    if (unknown) {
      return skip(`Tag \`${unknown.key}\` does not exist on \`${q.metric}\``);
    }
  }
  if (q.filters.some((f) => f.op === 'neq' && f.values[0] === '*')) {
    return skip('Filtering on a missing tag (!key:*) is not supported');
  }

  const mods = readModifiers(q.functions);
  out.warnings.push(...mods.warnings);
  if (mods.fill) {
    out.fill = mods.fill;
  }
  const input: TemplateInput = {
    name: q.metric,
    info,
    matchers: filtersToMatchers(q.filters),
    spaceAgg: q.spaceAgg,
    groupBy,
    countMode: mods.countMode,
    rollupAgg: mods.rollupAgg,
    offsetSec: mods.offsetSec,
    stepSec,
  };
  const template = buildTemplate(input);
  if ('skip' in template) {
    return skip(template.skip);
  }
  out.warnings.push(...template.warnings);
  // The ranking evaluates the same template once over the whole range.
  const rank = groupBy.length > 0 ? buildTemplate({ ...input, stepSec: rangeSec, atEnd: true }) : undefined;

  // Post functions stay in PromQL until the first one without a PromQL form; the rest run on the client.
  let expr = template.expr;
  let capped = rank && 'expr' in rank ? capGroups(template.expr, rank.expr) : undefined;
  let serverSide = true;
  for (const call of q.functions) {
    const def = getFunction(call.name);
    if (!def) {
      out.warnings.push(`Unknown function ${call.name}() is ignored`);
      continue;
    }
    if (def.stage !== 'post') {
      continue;
    }
    if (def.formulaOnly) {
      out.warnings.push(`${call.name}() can only be used in formulas`);
      continue;
    }
    const { args, error } = normalizeArgs(def, call.args);
    if (error) {
      out.warnings.push(error);
    }
    if (serverSide && def.promql) {
      expr = def.promql(expr, args, { stepSec });
      capped = capped && def.promql(capped, args, { stepSec });
    } else {
      serverSide = false;
      out.clientChain.push({ ...call, args });
    }
  }
  out.expr = expr;
  if (capped) {
    out.cappedExpr = capped;
  }
  return out;
}

/**
 * One visible row: its text form with only the in-query modifiers (no wrapping functions), or the formula; more
 * rows: the bare metric names and formula expressions. Aliases never appear; invalid formulas are left out.
 */
function title(state: ExplorerState, ctx: CompileContext): string {
  const letters = state.queries.map((q) => q.letter);
  const queries = state.queries.filter((q) => !q.hidden && q.metric !== '');
  const formulas = state.formulas
    .filter((f) => !f.hidden && f.expression.trim() !== '' && formulaError(f.expression, letters) === null)
    .map((f) => f.expression.trim());
  if (queries.length === 1 && formulas.length === 0) {
    const q = queries[0];
    return renderQueryText(
      { ...q, functions: q.functions.filter((f) => isDottedModifier(f.name)) },
      ctx.metrics[q.metric]
    );
  }
  return [...queries.map((q) => q.metric), ...formulas].join(', ');
}

/** Compiles the explorer state into one PromQL range query per row with a shared step. */
export function compile(state: ExplorerState, ctx: CompileContext): CompiledPlan {
  const rangeMs = ctx.range.to - ctx.range.from;
  const withMetric = state.queries.filter((q) => q.metric !== '');
  const cadences = withMetric.map((q) => cadenceSec(ctx.metrics[q.metric]));
  const baseStep = chooseStep(rangeMs, state.viz, state.display.display, cadences);
  // An explicit rollup interval above the step sets the step; every query shares the largest so formulas align.
  const stepSec = Math.max(baseStep, ...withMetric.map((q) => readModifiers(q.functions).rollupSec ?? 0));

  const formulas: CompiledFormula[] = state.formulas.map((f, i) => ({
    id: f.id,
    refLetter: `f${i + 1}`,
    expression: f.expression,
    ...(f.alias !== undefined ? { alias: f.alias } : {}),
    hidden: f.hidden,
  }));
  if (rangeMs > ctx.maxRangeHours * HOUR_MS) {
    return {
      stepSec,
      queries: [],
      formulas,
      title: title(state, ctx),
      errors: [`Time range is limited to ${ctx.maxRangeHours} h. Choose a shorter range.`],
    };
  }
  return {
    stepSec,
    queries: state.queries.map((q) => compileQuery(q, state, ctx, stepSec, Math.round(rangeMs / 1000))),
    formulas,
    title: title(state, ctx),
    errors: [],
  };
}
