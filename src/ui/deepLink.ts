import { isValidLabelKey, parseQueryText } from '../compile';
import { validateFormula } from '../engine';
import { defaultState, LETTERS, MAX_QUERIES, newFormula, newQuery } from '../model/defaults';
import { ExplorerState, FormulaQuery, MetricInfo, MetricQuery } from '../model/types';
import { DISPLAY_TYPES, LinkParams, VISUALIZATIONS } from '../model/url';

export interface LinkState {
  state: ExplorerState;
  /** Names every parameter value that could not be read; undefined when all of them were. */
  warning?: string;
}

/**
 * The state a readable link describes: a query row per `q` in the text form of the raw mode, lettered a, b, c…
 * in order, a formula per `f` (the query rows are then hidden), and `viz`, `display` and `split`. Values that do
 * not parse are left out and named in the warning; everything else is kept.
 */
export function stateFromLink(link: LinkParams, metrics: MetricInfo[]): LinkState {
  const defaults = defaultState();
  const invalid: string[] = [];
  const skip = (param: string, value: string, reason: string) => {
    invalid.push(`${param}=${value} (${reason})`);
  };

  const queries: MetricQuery[] = [];
  (link.q ?? []).forEach((text, i) => {
    const parsed = i < MAX_QUERIES ? parseQueryText(text, metrics) : { error: `at most ${MAX_QUERIES} queries` };
    if ('error' in parsed) {
      skip('q', text, parsed.error);
    } else {
      // The letter follows the position, so a formula never points at another row when an earlier `q` fails.
      queries.push({ ...newQuery({ queries: [] }), ...parsed, letter: LETTERS[i] });
    }
  });

  const letters = queries.map((q) => q.letter);
  const formulas: FormulaQuery[] = [];
  for (const text of link.f ?? []) {
    const error = text.trim() === '' ? 'empty formula' : validateFormula(text, letters);
    if (error) {
      skip('f', text, error);
    } else {
      formulas.push({ ...newFormula({ formulas }), expression: text });
    }
  }

  /** The first value of a single-valued parameter, if it is valid. */
  const single = (param: 'viz' | 'display' | 'split', valid: (v: string) => boolean, reason: string) => {
    const value = link[param]?.[0];
    if (value === undefined || valid(value)) {
      return value;
    }
    skip(param, value, reason);
    return undefined;
  };
  const viz = single('viz', (v) => includes(VISUALIZATIONS, v), `not one of ${VISUALIZATIONS.join(', ')}`);
  const display = single('display', (v) => includes(DISPLAY_TYPES, v), `not one of ${DISPLAY_TYPES.join(', ')}`);
  const split = single('split', isValidLabelKey, 'not a tag key');

  const state: ExplorerState = {
    ...defaults,
    viz: viz && includes(VISUALIZATIONS, viz) ? viz : defaults.viz,
    queries: queries.length === 0 ? defaults.queries : queries.map((q) => ({ ...q, hidden: formulas.length > 0 })),
    formulas,
    display: display && includes(DISPLAY_TYPES, display) ? { ...defaults.display, display } : defaults.display,
    split: split ? { ...defaults.split, key: split } : defaults.split,
  };
  return invalid.length === 0 ? { state } : { state, warning: `Ignored link parameters: ${invalid.join('; ')}.` };
}

function includes<T extends string>(values: readonly T[], value: string): value is T {
  return values.includes(value as T);
}
