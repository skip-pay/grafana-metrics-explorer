import { MetricInfo, MetricKind } from '../../model/types';

/** True when `text` has an unclosed `(`, so a comma typed now belongs to an `IN (…)` list. */
export function insideParens(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    }
  }
  return depth > 0;
}

/** Splits on commas outside parentheses: `a:1, k IN (x,y)` → [`a:1`, `k IN (x,y)`]; parts are trimmed, empty ones dropped. */
export function splitOutsideParens(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') {
      depth++;
    } else if (ch === ')' && depth > 0) {
      depth--;
    }
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

export function isCounterKind(kind: MetricKind | undefined): boolean {
  return kind === 'delta_counter' || kind === 'cumulative_counter';
}

/** Human unit of a metric, or undefined for unit-less ones. */
export function unitText(metric: MetricInfo): string | undefined {
  if (metric.unitLabel) {
    return metric.unitLabel;
  }
  return metric.unit && metric.unit !== 'short' ? metric.unit : undefined;
}

export function preventDefault(e: { preventDefault: () => void }) {
  e.preventDefault();
}
