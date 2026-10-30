import { TagFilter } from '../model/types';

const LABEL_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidLabelKey(key: string): boolean {
  return LABEL_KEY.test(key);
}

/** A PromQL string literal. */
export function promString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function escapeRegex(value: string): string {
  return value.replace(/[\\.+*?()|[\]{}^$]/g, '\\$&');
}

/** `*` alone means "has the tag"; elsewhere `*` matches any run of characters. */
function wildcardRegex(value: string): string {
  return value === '*' ? '.+' : value.split('*').map(escapeRegex).join('.*');
}

// OpenObserve anchors an alternation per branch (`a|b` runs as `^a|b$`), so every emitted regex is grouped.
const group = (parts: string[]) => `(?:${parts.join('|')})`;

/** PromQL label matchers (`k="v"`, `k=~"(?:a|b)"`…) for the "from" chips; same-key `eq` chips are ORed. */
export function filtersToMatchers(filters: TagFilter[]): string[] {
  const eqByKey = new Map<string, string[]>();
  for (const f of filters) {
    if (f.op === 'eq') {
      eqByKey.set(f.key, [...(eqByKey.get(f.key) ?? []), f.values[0]]);
    }
  }
  const out: string[] = [];
  const done = new Set<string>();
  for (const f of filters) {
    const value = f.values[0] ?? '';
    switch (f.op) {
      case 'eq': {
        if (done.has(f.key)) {
          break;
        }
        done.add(f.key);
        const values = eqByKey.get(f.key)!;
        out.push(
          values.length === 1 && !values[0].includes('*')
            ? `${f.key}=${promString(values[0])}`
            : `${f.key}=~${promString(group(values.map(wildcardRegex)))}`
        );
        break;
      }
      case 'neq':
        out.push(
          value.includes('*')
            ? `${f.key}!~${promString(group([wildcardRegex(value)]))}`
            : `${f.key}!=${promString(value)}`
        );
        break;
      case 'in':
        out.push(`${f.key}=~${promString(group(f.values.map(escapeRegex)))}`);
        break;
      case 'not_in':
        out.push(`${f.key}!~${promString(group(f.values.map(escapeRegex)))}`);
        break;
    }
  }
  return out;
}

const BOOLEAN = /\s(AND|OR)\s/;

function needsQuotes(value: string): boolean {
  return value === '' || value !== value.trim() || /[,{}()"\\]/.test(value) || BOOLEAN.test(value);
}

/** A tag value as written in the text form, double-quoted when it holds a separator. */
export function quoteValue(value: string): string {
  return needsQuotes(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

export function filterToText(f: TagFilter): string {
  switch (f.op) {
    case 'eq':
      return `${f.key}:${quoteValue(f.values[0] ?? '')}`;
    case 'neq':
      return `!${f.key}:${quoteValue(f.values[0] ?? '')}`;
    case 'in':
      return `${f.key} IN (${f.values.map(quoteValue).join(',')})`;
    case 'not_in':
      return `${f.key} NOT IN (${f.values.map(quoteValue).join(',')})`;
  }
}

/** The scope between the braces of the text form; no filter is `*` (everywhere). */
export function renderScope(filters: TagFilter[]): string {
  return filters.length === 0 ? '*' : filters.map(filterToText).join(',');
}

/** Splits at `sep` outside double quotes and parentheses. */
export function splitTopLevel(text: string, sep = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        quoted = false;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
    } else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A trimmed value, unquoted when it is a double-quoted string. */
function parseValue(raw: string): string | { error: string } {
  const text = raw.trim();
  if (!text.startsWith('"')) {
    return text.includes('"') ? { error: `Unexpected quote in ${text}` } : text;
  }
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      out += text[++i];
    } else if (c === '"') {
      return i === text.length - 1 ? out : { error: `Unexpected text after the quoted value ${text}` };
    } else {
      out += c;
    }
  }
  return { error: `Unterminated quote in ${text}` };
}

const IN_FORM = /^([^\s:!]+)\s+(NOT\s+IN|IN)\s*\(([\s\S]*)\)$/i;

/** One chip: `k:v`, `!k:v`, `k:v*`, `k:*`, `k IN (a,b)`, `k NOT IN (a,b)`. */
export function parseFilterText(text: string): TagFilter | { error: string } {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { error: 'Empty filter' };
  }
  const inForm = IN_FORM.exec(trimmed);
  if (inForm) {
    const [, key, op, list] = inForm;
    if (!isValidLabelKey(key)) {
      return { error: `Invalid tag key "${key}"` };
    }
    const values: string[] = [];
    for (const part of splitTopLevel(list)) {
      const value = parseValue(part);
      if (typeof value !== 'string') {
        return value;
      }
      if (value === '') {
        return { error: `Empty value in ${trimmed}` };
      }
      values.push(value);
    }
    return { key, op: /^not/i.test(op) ? 'not_in' : 'in', values };
  }
  const negated = trimmed.startsWith('!');
  const body = negated ? trimmed.slice(1).trimStart() : trimmed;
  const colon = body.indexOf(':');
  if (colon < 0) {
    return { error: `Expected key:value, got "${trimmed}"` };
  }
  const key = body.slice(0, colon).trim();
  if (!isValidLabelKey(key)) {
    return { error: `Invalid tag key "${key}"` };
  }
  const value = parseValue(body.slice(colon + 1));
  if (typeof value !== 'string') {
    return value;
  }
  if (value === '') {
    return { error: `Missing value for "${key}"` };
  }
  if (negated && value === '*') {
    return { error: `!${key}:* (tag absent) is not supported` };
  }
  return { key, op: negated ? 'neq' : 'eq', values: [value] };
}

/** The filters of a scope (`*`, empty, or comma-separated chips); boolean AND/OR scopes are rejected. */
export function parseScopeText(scope: string): TagFilter[] | { error: string } {
  const text = scope.trim();
  if (text === '' || text === '*') {
    return [];
  }
  const filters: TagFilter[] = [];
  for (const part of splitTopLevel(text)) {
    if (/^\s*\$/.test(part)) {
      return { error: 'Template variables are not supported' };
    }
    if (BOOLEAN.test(part.replace(/"(?:[^"\\]|\\.)*"/g, '""')) || /^\s*NOT\s/.test(part)) {
      return { error: 'Boolean scopes (AND, OR, NOT) are not supported; separate filters with commas' };
    }
    const filter = parseFilterText(part);
    if ('error' in filter) {
      return filter;
    }
    filters.push(filter);
  }
  return filters;
}
