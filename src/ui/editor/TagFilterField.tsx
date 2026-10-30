import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { Catalog, isLowPriorityKey, searchTags, TagMatch, TagPair, TimeWindow } from '../../catalog';
import { filterToText, parseFilterText } from '../../compile';
import { ResolvedMetric, TagFilter } from '../../model/types';
import { ChipInput, ChipModel } from './ChipInput';
import { Highlight } from './Highlight';
import { getEditorColors, getEditorStyles } from './styles';
import { SuggestionItem } from './SuggestionList';
import { splitOutsideParens } from './utils';

export interface TagFilterFieldProps {
  filters: TagFilter[];
  resolved?: ResolvedMetric;
  catalog: Catalog;
  timeWindow: TimeWindow;
  onChange: (filters: TagFilter[]) => void;
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
];

type Option = { kind: 'pair'; match: TagMatch } | { kind: 'custom'; filter: TagFilter; text: string };

interface PairsState {
  key: string;
  pairs: TagPair[];
  done: boolean;
}

/** The "from" field: `key:value` chips with progressive suggestions from the catalogue. */
export const TagFilterField = ({ filters, resolved, catalog, timeWindow, onChange, metric }: TagFilterFieldProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [showSyntax, setShowSyntax] = useState(false);
  const [pairsState, setPairsState] = useState<PairsState>({ key: '', pairs: [], done: false });
  const requested = useRef('');

  const labelKeys = resolved?.labelKeys;
  // Suggestions are narrowed by the chips that can match (OpenObserve ignores unknown keys anyway).
  const narrowing = useMemo(
    () => (labelKeys ? filters.filter((f) => labelKeys.includes(f.key)) : []),
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
  const options = useMemo(() => buildOptions(text, pairs, filters), [text, pairs, filters]);

  const suggestions: SuggestionItem[] = options.map((option, i) =>
    option.kind === 'pair'
      ? {
          id: `${option.match.negated ? '!' : ''}${option.match.pair.key}:${option.match.pair.value}`,
          content: (
            <>
              {option.match.negated && <span className={editorStyles.negation}>!</span>}
              <Highlight text={`${option.match.pair.key}:${option.match.pair.value}`} ranges={option.match.ranges} />
            </>
          ),
        }
      : {
          id: `custom-${i}`,
          content: (
            <span className={styles.custom}>
              Add filter <code>{option.text}</code>
            </span>
          ),
        }
  );

  const add = (added: TagFilter[]) => {
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
    setText('');
    setError(undefined);
  };

  const pick = (index: number) => {
    const option = options[index];
    if (!option) {
      return;
    }
    if (option.kind === 'custom') {
      add([option.filter]);
      return;
    }
    const { pair, negated } = option.match;
    add([{ key: pair.key, op: negated ? 'neq' : 'eq', values: [pair.value] }]);
  };

  const commit = (value: string) => {
    const parsed = parseFilterText(value);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    add([parsed]);
  };

  const paste = (pasted: string) => {
    const parts = splitOutsideParens(pasted);
    if (parts.length < 2) {
      return false;
    }
    const valid: TagFilter[] = [];
    const invalid: string[] = [];
    let firstError: string | undefined;
    for (const part of parts) {
      const parsed = parseFilterText(part);
      if ('error' in parsed) {
        invalid.push(part);
        firstError ??= parsed.error;
      } else {
        valid.push(parsed);
      }
    }
    add(valid);
    if (invalid.length > 0) {
      setText(invalid.join(', '));
      setError(firstError);
    }
    return true;
  };

  const chips: ChipModel[] = filters.map((f, i) => {
    const unknown = labelKeys !== undefined && !labelKeys.includes(f.key);
    return {
      id: `${i}:${JSON.stringify(f)}`,
      prefix: f.op === 'neq' ? <span className={editorStyles.negation}>!</span> : undefined,
      content: <FilterChipContent filter={f} />,
      label: chipLabel(f),
      invalid: unknown,
      tooltip: unknown && resolved ? `Tag \`${f.key}\` does not exist on \`${resolved.name}\`` : undefined,
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
      suggestions={suggestions}
      onPick={pick}
      onCommit={commit}
      onRemoveChip={(index) => onChange(filters.filter((_, j) => j !== index))}
      onEditChip={(index) => {
        setText(filterToText(filters[index]));
        setError(undefined);
        onChange(filters.filter((_, j) => j !== index));
      }}
      onClear={() => {
        setText('');
        setError(undefined);
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

/**
 * Suggestions for the typed text: ranked `key:value` pairs without the ones already chosen, plus an
 * "Add filter" row when the text is a valid filter of its own (first for wildcards and IN lists, last otherwise).
 */
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

function buildOptions(text: string, pairs: TagPair[], filters: TagFilter[]): Option[] {
  const query = text.trim();
  const negated = query.startsWith('!');
  const used = new Set(filters.filter((f) => f.op === 'eq' || f.op === 'neq').map(chipLabel));
  const textOf = (m: TagMatch) => `${m.negated ? '!' : ''}${m.pair.key}:${m.pair.value}`;
  const matches =
    query === '' || query === '!'
      ? byFewestValues(pairs)
          .slice(0, MAX_SUGGESTIONS + used.size)
          .map((pair) => ({ pair, negated, score: 0, ranges: [] }))
      : searchTags(query, pairs, MAX_SUGGESTIONS + used.size);
  const options: Option[] = matches
    .filter((m) => !used.has(textOf(m)))
    .slice(0, MAX_SUGGESTIONS)
    .map((match) => ({ kind: 'pair', match }));
  if (query !== '' && query !== '!' && !matches.some((m) => textOf(m) === query)) {
    const parsed = parseFilterText(query);
    if (!('error' in parsed) && !used.has(chipLabel(parsed))) {
      const custom: Option = { kind: 'custom', filter: parsed, text: query };
      if (/[*(]/.test(query)) {
        options.unshift(custom);
      } else {
        options.push(custom);
      }
    }
  }
  return options;
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
