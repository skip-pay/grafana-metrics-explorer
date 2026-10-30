import React, { useMemo, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { isNoiseKey } from '../../catalog';
import { ResolvedMetric } from '../../model/types';
import { ChipInput, ChipModel } from './ChipInput';
import { Highlight } from './Highlight';
import { getEditorColors, getEditorStyles } from './styles';
import { SuggestionItem } from './SuggestionList';

export interface GroupByFieldProps {
  groupBy: string[];
  resolved?: ResolvedMetric;
  onChange: (groupBy: string[]) => void;
}

interface KeyMatch {
  key: string;
  ranges: Array<[number, number]>;
}

/** The "by" field: label-key chips; internal keys stay behind "Show all tags". */
export const GroupByField = ({ groupBy, resolved, onChange }: GroupByFieldProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [text, setText] = useState('');
  const [showAll, setShowAll] = useState(false);

  const keys = resolved?.labelKeys;
  const metric = resolved?.name ?? '';
  const { matches, hiddenCount } = useMemo(() => {
    const all = (keys ?? []).filter((k) => !groupBy.includes(k));
    const visible = showAll ? all : all.filter((k) => !isNoiseKey(k, metric));
    return { matches: rankKeys(text, visible), hiddenCount: all.length - visible.length };
  }, [keys, metric, groupBy, showAll, text]);

  const suggestions: SuggestionItem[] = matches.map((m) => ({
    id: m.key,
    content: <Highlight text={m.key} ranges={m.ranges} />,
  }));

  const add = (added: string[]) => {
    const next = [...groupBy];
    for (const key of added) {
      if (key !== '' && !next.includes(key)) {
        next.push(key);
      }
    }
    if (next.length !== groupBy.length) {
      onChange(next);
    }
    setText('');
  };

  const chips: ChipModel[] = groupBy.map((key) => {
    const unknown = keys !== undefined && !keys.includes(key);
    return {
      id: key,
      content: key,
      label: key,
      invalid: unknown,
      tooltip: unknown && resolved ? `Tag \`${key}\` does not exist on \`${resolved.name}\`` : undefined,
    };
  });

  const footer =
    hiddenCount > 0 || showAll ? (
      <button type="button" className={styles.toggle} onClick={() => setShowAll(!showAll)}>
        <Icon name={showAll ? 'eye-slash' : 'eye'} size="sm" />
        {showAll ? 'Hide internal tags' : `Show all tags (${hiddenCount} hidden)`}
      </button>
    ) : undefined;

  return (
    <ChipInput
      className={styles.field}
      chips={chips}
      text={text}
      onTextChange={setText}
      suggestions={suggestions}
      onPick={(index) => add([matches[index].key])}
      onCommit={(value) => add(value.split(',').map((k) => k.trim()))}
      onRemoveChip={(index) => onChange(groupBy.filter((_, j) => j !== index))}
      onEditChip={(index) => {
        setText(groupBy[index]);
        onChange(groupBy.filter((_, j) => j !== index));
      }}
      onClear={() => {
        setText('');
        onChange([]);
      }}
      onPasteText={(pasted) => {
        if (!pasted.includes(',')) {
          return false;
        }
        add(pasted.split(',').map((k) => k.trim()));
        return true;
      }}
      placeholder="(everything)"
      ariaLabel="Group by tags"
      popoverWidth={300}
      testId="group-by-field"
      chipVariant="group"
      listVariant="strong"
      visibleRows={8}
      header={<div className={editorStyles.popoverHeader}>Group by</div>}
      footer={footer}
      emptyText={resolved ? 'No more tags' : 'Pick a metric to get tag suggestions'}
    />
  );
};

/** Keys matching the typed text (separator-insensitive): exact, prefix, token prefix, then substring; stable otherwise. */
function rankKeys(text: string, keys: string[]): KeyMatch[] {
  const query = normalize(text.trim());
  if (query === '') {
    return keys.map((key) => ({ key, ranges: [] }));
  }
  const scored: Array<KeyMatch & { tier: number; index: number }> = [];
  keys.forEach((key, index) => {
    const name = normalize(key);
    const at = name.indexOf(query);
    if (at < 0) {
      return;
    }
    const tier = name === query ? 0 : at === 0 ? 1 : name[at - 1] === '_' ? 2 : 3;
    scored.push({ key, ranges: [[at, at + query.length]], tier, index });
  });
  scored.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return scored.map(({ key, ranges }) => ({ key, ranges }));
}

/** Lower case with `.`, `-` and spaces as `_`; keeps the length, so match offsets stay valid. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[.\- ]/g, '_');
}

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    field: css({
      background: colors.groupBg,
    }),
    toggle: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      width: '100%',
      padding: theme.spacing(1, 1.5),
      border: 'none',
      borderTop: `1px solid ${theme.colors.border.weak}`,
      background: 'transparent',
      color: theme.colors.text.link,
      fontSize: theme.typography.bodySmall.fontSize,
      textAlign: 'left',
      cursor: 'pointer',
      '&:hover': { background: theme.colors.action.hover },
    }),
  };
};
