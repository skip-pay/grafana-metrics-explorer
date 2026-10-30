import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { Catalog, isLowPriorityKey, searchTags, TagMatch, TagPair, TimeWindow } from '../../catalog';
import { filterTerms, filterToText, isFilterGroup, parseScopeText, quoteValue, topLevelFilters } from '../../compile';
import { FilterGroup, FilterItem, ResolvedMetric, TagFilter } from '../../model/types';
import { ChipInput, ChipModel } from './ChipInput';
import { Highlight } from './Highlight';
import { getEditorColors, getEditorStyles } from './styles';
import { SuggestionItem } from './SuggestionList';
import { splitOutsideParens } from './utils';

export interface TagFilterFieldProps {
  filters: FilterItem[];
  resolved?: ResolvedMetric;
  catalog: Catalog;
  timeWindow: TimeWindow;
  onChange: (filters: FilterItem[]) => void;
  /** The chosen metric; tells "no metric yet" apart from "still resolving" in the empty list. */
  metric?: string;
}

const MAX_SUGGESTIONS = 100;
const VISIBLE_ROWS = 8;
const MINUTE = 60_000;

/** The scope syntax the field accepts, shown under "Syntax help". */
const SYNTAX: Array<[string, string]> = [
  ['key:value', 'the tag has this value'],
  ['!key:value', 'the tag does not have this value'],
  ['key:val*', 'wildcard match'],
  ['key IN (a,b)', 'any of the values'],
  ['key NOT IN (a,b)', 'none of the values'],
  ['a:1, b:2', 'comma = AND (the same key twice matches either value)'],
  ['a:1 OR b:2', 'either filter'],
  ['NOT (a:1 OR b:2)', 'neither; NOT binds tighter than AND, AND than OR'],
  ['a:1 AND (b:2 OR c:3)', 'parentheses group filters'],
];

/** A term for the token, a value of an IN list, an operator, or the whole text as typed. */
type Option =
  | { kind: 'pair'; match: TagMatch }
  | { kind: 'value'; value: string; ranges: Array<[number, number]> }
  | { kind: 'keyword'; keyword: string }
  | { kind: 'custom'; text: string };

interface PairsState {
  key: string;
  pairs: TagPair[];
  done: boolean;
}

/**
 * The "from" field: one chip per top-level filter, a term or a group, with progressive suggestions from the
 * catalogue for the token being typed.
 */
export const TagFilterField = ({ filters, resolved, catalog, timeWindow, onChange, metric }: TagFilterFieldProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [showSyntax, setShowSyntax] = useState(false);
  const [pairsState, setPairsState] = useState<PairsState>({ key: '', pairs: [], done: false });
  const requested = useRef('');

  const labelKeys = resolved?.labelKeys;
  // Suggestions are narrowed by the term chips that can match (OpenObserve ignores unknown keys anyway).
  const narrowing = useMemo(
    () => (labelKeys ? topLevelFilters(filters).filter((f) => labelKeys.includes(f.key)) : []),
    [filters, labelKeys]
  );
  // Minute buckets keep a moving relative range from refetching on every refresh.
  const from = Math.floor(timeWindow.from / MINUTE) * MINUTE;
  const to = Math.ceil(timeWindow.to / MINUTE) * MINUTE;
  const requestKey = resolved ? JSON.stringify([resolved.name, narrowing, from, to]) : '';

  useEffect(() => {
    if (!open || !resolved || requested.current === requestKey) {
      return;
    }
    requested.current = requestKey;
    const key = requestKey;
    const accept = (pairs: TagPair[], done: boolean) =>
      setPairsState((prev) => {
        if (prev.key === key) {
          return { key, pairs: mergePairs(prev.pairs, pairs), done: prev.done || done };
        }
        return requested.current === key ? { key, pairs: mergePairs([], pairs), done } : prev;
      });
    catalog
      .tagPairs(resolved, narrowing, { from, to }, (pairs) => accept(pairs, false))
      .then(
        (pairs) => accept(pairs, true),
        () => {
          if (requested.current === key) {
            requested.current = '';
          }
          accept([], true);
        }
      );
  }, [open, resolved, requestKey, catalog, narrowing, from, to]);

  const current = pairsState.key === requestKey;
  const pairs = useMemo(() => (current ? pairsState.pairs : []), [current, pairsState.pairs]);
  const loading = resolved !== undefined && (!current || !pairsState.done);
  const options = useMemo(() => buildOptions(text, caret, pairs, filters), [text, caret, pairs, filters]);

  const suggestions: SuggestionItem[] = options.map((option, i) => {
    switch (option.kind) {
      case 'pair':
        return {
          id: `${option.match.negated ? '!' : ''}${option.match.pair.key}:${option.match.pair.value}`,
          content: (
            <>
              {option.match.negated && <span className={editorStyles.negation}>!</span>}
              <Highlight text={`${option.match.pair.key}:${option.match.pair.value}`} ranges={option.match.ranges} />
            </>
          ),
        };
      case 'value':
        return { id: `value-${option.value}`, content: <Highlight text={option.value} ranges={option.ranges} /> };
      case 'keyword':
        return {
          id: `keyword-${option.keyword}`,
          content: <span className={cx(styles.keyword, editorStyles.negation)}>{option.keyword}</span>,
        };
      case 'custom':
        return {
          id: `custom-${i}`,
          content: (
            <span className={styles.custom}>
              Add filter <code>{option.text}</code>
            </span>
          ),
        };
    }
  });

  /** Puts `value` in the input with the caret at `at`, by default the end. */
  const edit = (value: string, at = value.length) => {
    setText(value);
    setCaret(at);
    setError(undefined);
  };

  const add = (added: FilterItem[]) => {
    const seen = new Set(filters.map((f) => JSON.stringify(f)));
    const fresh = added.filter((f) => {
      const id = JSON.stringify(f);
      if (seen.has(id)) {
        return false;
      }
      seen.add(id);
      return true;
    });
    if (fresh.length > 0) {
      onChange([...filters, ...fresh]);
    }
    edit('');
  };

  const commit = (value: string) => {
    const parsed = parseScopeText(value);
    if ('error' in parsed) {
      edit(value);
      setError(parsed.error);
      return;
    }
    add(parsed);
  };

  /**
   * Commits `head` and the text after the caret once no group or IN list is left open; until then the caret goes
   * after `head` to continue there.
   */
  const commitWhenClosed = (head: string, rest: string) => {
    if (typingAt(head + rest).open === 0) {
      commit(head + rest);
    } else {
      // The space after a complete term brings up AND, OR and ")".
      edit(`${head} ${rest.trimStart()}`, head.length + 1);
    }
  };

  /** A picked suggestion replaces the token before the caret; the text after the caret stays. */
  const pick = (index: number) => {
    const option = options[index];
    const head = text.slice(0, caret);
    const rest = text.slice(caret);
    const before = head.slice(0, typingAt(head).start);
    switch (option?.kind) {
      case 'custom':
        commit(option.text);
        return;
      case 'pair': {
        const { pair, negated } = option.match;
        const term = filterToText({ key: pair.key, op: negated ? 'neq' : 'eq', values: [pair.value] });
        commitWhenClosed(before + term, rest);
        return;
      }
      case 'value': {
        const next = before + quoteValue(option.value);
        edit(next + rest, next.length);
        return;
      }
      case 'keyword':
        if (option.keyword === ')') {
          commitWhenClosed(`${head.trimEnd()})`, rest);
        } else {
          const next = `${head.replace(/\S*$/, '')}${option.keyword} `;
          edit(next + rest.trimStart(), next.length);
        }
        return;
    }
  };

  /** A pasted list becomes chips when the field is empty; into typed text it is inserted at the caret. */
  const paste = (pasted: string) => {
    const parts = splitOutsideParens(pasted);
    if (parts.length < 2 || text.trim() !== '') {
      return false;
    }
    const valid: FilterItem[] = [];
    const invalid: string[] = [];
    let firstError: string | undefined;
    for (const part of parts) {
      const parsed = parseScopeText(part);
      if ('error' in parsed) {
        invalid.push(part);
        firstError ??= parsed.error;
      } else {
        valid.push(...parsed);
      }
    }
    add(valid);
    if (invalid.length > 0) {
      edit(invalid.join(', '));
      setError(firstError);
    }
    return true;
  };

  const chips: ChipModel[] = filters.map((item, i) => {
    const unknown = labelKeys && filterTerms([item]).find((f) => !labelKeys.includes(f.key));
    return {
      id: `${i}:${JSON.stringify(item)}`,
      prefix: !isFilterGroup(item) && item.op === 'neq' ? <span className={editorStyles.negation}>!</span> : undefined,
      content: isFilterGroup(item) ? <GroupChipContent group={item} /> : <FilterChipContent filter={item} />,
      label: isFilterGroup(item) ? filterToText(item) : chipLabel(item),
      invalid: unknown !== undefined,
      tooltip: unknown && resolved ? `Tag \`${unknown.key}\` does not exist on \`${resolved.name}\`` : undefined,
    };
  });

  const emptyText = !metric
    ? 'Pick a metric to get tag suggestions'
    : loading
      ? 'Loading tag values…'
      : text.trim()
        ? 'No suggestions found'
        : 'No tag values in this time range';

  return (
    <ChipInput
      chips={chips}
      text={text}
      onTextChange={(value) => {
        setText(value);
        setError(undefined);
      }}
      caret={caret}
      onCaretChange={setCaret}
      suggestions={suggestions}
      onPick={pick}
      onCommit={commit}
      onRemoveChip={(index) => onChange(filters.filter((_, j) => j !== index))}
      onEditChip={(index) => {
        edit(filterToText(filters[index]));
        onChange(filters.filter((_, j) => j !== index));
      }}
      onClear={() => {
        edit('');
        onChange([]);
      }}
      onPasteText={paste}
      onOpenChange={setOpen}
      placeholder="(everywhere)"
      ariaLabel="Filter tags"
      testId="tag-filter-field"
      chipVariant="filter"
      visibleRows={VISIBLE_ROWS}
      header={
        <>
          <div className={editorStyles.popoverHeader}>
            <span>Suggestions</span>
            {loading && suggestions.length > 0 && <span>Loading…</span>}
          </div>
          {error && <div className={editorStyles.popoverError}>{error}</div>}
        </>
      }
      footer={
        <div className={styles.footer}>
          {showSyntax && (
            <div className={styles.syntax}>
              {SYNTAX.map(([example, meaning]) => (
                <React.Fragment key={example}>
                  <code>{example}</code>
                  <span className={styles.meaning}>{meaning}</span>
                </React.Fragment>
              ))}
            </div>
          )}
          <button
            type="button"
            className={styles.syntaxToggle}
            aria-expanded={showSyntax}
            onClick={() => setShowSyntax(!showSyntax)}
          >
            Syntax help <Icon name={showSyntax ? 'angle-up' : 'question-circle'} size="sm" />
          </button>
        </div>
      }
      emptyText={emptyText}
    />
  );
};

const FilterChipContent = ({ filter }: { filter: TagFilter }) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const negated = filter.op === 'neq' || filter.op === 'not_in';
  return (
    <>
      <span>{filter.key}</span>
      {filter.op === 'eq' || filter.op === 'neq' ? (
        <>
          <span className={styles.separator}>:</span>
          <span className={styles.value}>{filter.values[0]}</span>
        </>
      ) : (
        <>
          <span className={cx(styles.keyword, editorStyles.negation)}>{negated ? ' NOT IN ' : ' IN '}</span>
          <span className={styles.value}>({filter.values.join(', ')})</span>
        </>
      )}
    </>
  );
};

/** A group as its text, with the operators styled and each term as in its own chip. */
const GroupChipContent = ({ group }: { group: FilterGroup }) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const keyword = cx(styles.keyword, editorStyles.negation);
  return (
    <>
      {group.negated && <span className={keyword}>NOT </span>}
      {'('}
      {group.items.map((item, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className={keyword}>{` ${group.op.toUpperCase()} `}</span>}
          {isFilterGroup(item) ? (
            <GroupChipContent group={item} />
          ) : (
            <>
              {item.op === 'neq' && <span className={editorStyles.negation}>!</span>}
              <FilterChipContent filter={item} />
            </>
          )}
        </React.Fragment>
      ))}
      {')'}
    </>
  );
};

function chipLabel(f: TagFilter): string {
  switch (f.op) {
    case 'eq':
      return `${f.key}:${f.values[0]}`;
    case 'neq':
      return `!${f.key}:${f.values[0]}`;
    case 'in':
      return `${f.key} IN (${f.values.join(',')})`;
    case 'not_in':
      return `${f.key} NOT IN (${f.values.join(',')})`;
  }
}

function pairId(pair: TagPair): string {
  return `${pair.key}\u0000${pair.value}`;
}

/** Union of two pair lists, keeping the first list's order; works for cumulative and incremental progress. */
function mergePairs(existing: TagPair[], added: TagPair[]): TagPair[] {
  const seen = new Set(existing.map(pairId));
  const merged = [...existing];
  for (const pair of added) {
    const id = pairId(pair);
    if (!seen.has(id)) {
      seen.add(id);
      merged.push(pair);
    }
  }
  return merged;
}

/** Keys with few values first (environment before path), low-priority keys last; values keep their order. */
function byFewestValues(pairs: TagPair[]): TagPair[] {
  const counts = new Map<string, number>();
  pairs.forEach((p) => counts.set(p.key, (counts.get(p.key) ?? 0) + 1));
  const rank = (key: string) => [isLowPriorityKey(key) ? 1 : 0, counts.get(key) ?? 0];
  return pairs
    .map((pair, i) => ({ pair, i }))
    .sort((a, b) => {
      const [x, y] = [rank(a.pair.key), rank(b.pair.key)];
      return x[0] - y[0] || x[1] - y[1] || a.pair.key.localeCompare(b.pair.key) || a.i - b.i;
    })
    .map(({ pair }) => pair);
}

interface Typing {
  /** Start of the token being typed: after the last "(", ",", AND, OR or NOT, or at a closed group or IN list. */
  start: number;
  /** Groups and IN lists left open. */
  open: number;
  /** The token is a value of this key's `key IN (` list. */
  inKey?: string;
  /** Values already in that list. */
  listed: string[];
}

const KEYWORD = /^(?:AND|OR|NOT)(?=[\s(])/;
const IN_LIST = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s+(?:NOT\s+)?IN\s*$/i;

function unquote(value: string): string {
  return value.startsWith('"') ? value.slice(1, value.length > 1 && value.endsWith('"') ? -1 : undefined) : value;
}

/** Where the token being typed at the end of `text` starts, following the scope grammar. */
function typingAt(text: string): Typing {
  const frames: Array<{ start: number; inKey?: string; listed: string[] }> = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\') {
        i++;
      } else if (c === '"') {
        quoted = false;
      }
      continue;
    }
    const token = text.slice(start, i);
    const frame = frames[frames.length - 1];
    const fresh = token.trim() === '';
    const keyword = frame?.inKey === undefined && (fresh || /\s$/.test(token)) ? KEYWORD.exec(text.slice(i))?.[0] : '';
    if (c === '"') {
      quoted = true;
    } else if (c === '(') {
      const list = IN_LIST.exec(token);
      if (list || fresh) {
        frames.push({ start, inKey: list?.[1], listed: [] });
        start = i + 1;
      }
    } else if (c === ')' && frame) {
      // A closed group or IN list is one operand, typed from where it started.
      frames.pop();
      start = frame.start;
    } else if (c === ',') {
      if (frame?.inKey !== undefined) {
        frame.listed.push(unquote(token.trim()));
      }
      start = i + 1;
    } else if (keyword && (keyword !== 'NOT' || fresh)) {
      i += keyword.length - 1;
      start = i + 1;
    }
  }
  while (/\s/.test(text.charAt(start))) {
    start++;
  }
  const frame = frames[frames.length - 1];
  return { start, open: frames.length, inKey: frame?.inKey, listed: frame?.listed ?? [] };
}

/** True when the text after the caret closes the group or IN list open at the caret. */
function closedAfter(rest: string): boolean {
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
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
    } else if (c === ')' && depth-- === 0) {
      return true;
    }
  }
  return false;
}

/** "Add filter" with the whole text, when it is a valid filter. */
function addOption(text: string): Option[] {
  const whole = text.trim();
  const parsed = parseScopeText(whole);
  return 'error' in parsed || parsed.length === 0 ? [] : [{ kind: 'custom', text: whole }];
}

/**
 * Suggestions for the token before the caret: AND, OR (and ")" in a group not closed after the caret) after a
 * complete term and a space, ranked `key:value` pairs without the ones already chosen, and an "Add filter" row when
 * the whole text is a valid filter (first after a space or when the token is a wildcard, IN list or group, last
 * otherwise). Inside `key IN (`, the key's values.
 */
function buildOptions(text: string, caret: number, pairs: TagPair[], filters: FilterItem[]): Option[] {
  const head = text.slice(0, caret);
  const typing = typingAt(head);
  const token = head.slice(typing.start);
  const closable = typing.open > 0 && !closedAfter(text.slice(caret));
  if (typing.inKey !== undefined) {
    // In a list closed after the caret, Enter adds the whole text instead of closing it.
    const done: Option[] = closable ? [{ kind: 'keyword', keyword: ')' }] : addOption(text);
    return valueOptions(typing.inKey, unquote(token.trim()), typing.listed, pairs, done);
  }
  const tail = /^([\s\S]*\S)\s+(\S*)$/.exec(token);
  // With nothing typed after the space, Enter closes the open group or commits the text.
  const finish = tail?.[2] === '';
  const keywords: Option[] =
    tail && !('error' in parseScopeText(tail[1]))
      ? (closable ? [')', 'AND', 'OR'] : ['AND', 'OR'])
          .filter((keyword) => keyword.startsWith(tail[2]))
          .map((keyword) => ({ kind: 'keyword', keyword }))
      : [];

  const query = token.trim();
  const negated = query.startsWith('!');
  const used = new Set(
    topLevelFilters(filters)
      .filter((f) => f.op === 'eq' || f.op === 'neq')
      .map(chipLabel)
  );
  const textOf = (m: TagMatch) => `${m.negated ? '!' : ''}${m.pair.key}:${m.pair.value}`;
  const matches = query.includes('(')
    ? []
    : query === '' || query === '!'
      ? byFewestValues(pairs)
          .slice(0, MAX_SUGGESTIONS + used.size)
          .map((pair) => ({ pair, negated, score: 0, ranges: [] }))
      : searchTags(query, pairs, MAX_SUGGESTIONS + used.size);
  // After a complete term, the pair it already names is left out.
  const options: Option[] = matches
    .filter((m) => !used.has(textOf(m)) && !(keywords.length > 0 && textOf(m) === query))
    .slice(0, MAX_SUGGESTIONS)
    .map((match) => ({ kind: 'pair', match }));

  const whole = text.trim();
  const named = !finish && matches.some((m) => textOf(m) === whole);
  const parsed = whole !== '' && !named ? parseScopeText(whole) : [];
  if ('error' in parsed || parsed.length === 0) {
    return [...keywords, ...options];
  }
  const single = parsed.length === 1 && !isFilterGroup(parsed[0]) ? parsed[0] : undefined;
  if (single && used.has(chipLabel(single))) {
    return [...keywords, ...options];
  }
  const custom: Option = { kind: 'custom', text: whole };
  if (finish) {
    return [custom, ...keywords, ...options];
  }
  return /[*(]/.test(query) ? [...keywords, custom, ...options] : [...keywords, ...options, custom];
}

/** Values of an IN list's key not listed yet, and `done` (")" or "Add filter"): first once the value is a known one. */
function valueOptions(key: string, value: string, listed: string[], pairs: TagPair[], done: Option[]): Option[] {
  const own = pairs.filter((p) => p.key === key);
  const offset = key.length + 1;
  const values = searchTags(`${key}:${value}`, own, MAX_SUGGESTIONS + listed.length + 1)
    .filter((m) => m.pair.value !== value && !listed.includes(m.pair.value))
    .slice(0, MAX_SUGGESTIONS)
    .map((m): Option => ({
      kind: 'value',
      value: m.pair.value,
      ranges: m.ranges.filter(([from]) => from >= offset).map(([from, to]) => [from - offset, to - offset]),
    }));
  if (value === '') {
    return values;
  }
  return own.some((p) => p.value === value) ? [...done, ...values] : [...values, ...done];
}

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    separator: css({
      color: colors.pillOp,
    }),
    value: css({
      color: colors.pillValue,
    }),
    keyword: css({
      fontWeight: theme.typography.fontWeightMedium,
      whiteSpace: 'pre',
      marginRight: 0,
    }),
    meaning: css({
      color: theme.colors.text.secondary,
    }),
    footer: css({
      display: 'flex',
      flexDirection: 'column',
      borderTop: `1px solid ${theme.colors.border.weak}`,
      background: theme.colors.background.secondary,
    }),
    syntaxToggle: css({
      alignSelf: 'flex-end',
      display: 'inline-flex',
      alignItems: 'center',
      gap: theme.spacing(0.5),
      padding: theme.spacing(0.75, 1.5),
      border: 'none',
      background: 'transparent',
      color: theme.colors.text.link,
      fontSize: theme.typography.bodySmall.fontSize,
      cursor: 'pointer',
      '&:hover': { textDecoration: 'underline' },
    }),
    syntax: css({
      display: 'grid',
      gridTemplateColumns: 'max-content 1fr',
      columnGap: theme.spacing(1.5),
      rowGap: theme.spacing(0.25),
      padding: theme.spacing(1, 1.5, 0),
      fontSize: theme.typography.bodySmall.fontSize,
      code: {
        padding: 0,
        border: 'none',
        background: 'none',
        color: theme.colors.text.primary,
        fontFamily: theme.typography.fontFamilyMonospace,
      },
    }),
    custom: css({
      color: theme.colors.text.secondary,
      '& code': {
        color: theme.colors.text.primary,
        fontFamily: theme.typography.fontFamilyMonospace,
        background: 'none',
        border: 'none',
        padding: 0,
      },
    }),
  };
};
