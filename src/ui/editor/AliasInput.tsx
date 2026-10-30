import React, { useRef, useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { getEditorColors, ROW_HEIGHT } from './styles';

export interface AliasInputProps {
  alias?: string;
  /** Undefined clears the alias. */
  onChange: (alias: string | undefined) => void;
}

/** "as…" button that turns into an `as [alias] ×` box; Enter or blur saves, Esc cancels, an empty value clears. */
export const AliasInput = ({ alias, onChange }: AliasInputProps) => {
  const styles = useStyles2(getStyles);
  const [draft, setDraft] = useState<string>();
  // Enter and Esc unmount the input; a blur fired by that must not save (again).
  const closed = useRef(false);

  const edit = () => {
    closed.current = false;
    setDraft(alias ?? '');
  };
  const save = () => {
    if (draft === undefined || closed.current) {
      return;
    }
    closed.current = true;
    const value = draft.trim();
    setDraft(undefined);
    if (value !== (alias ?? '')) {
      onChange(value === '' ? undefined : value);
    }
  };

  if (draft === undefined && !alias) {
    return (
      <button
        type="button"
        className={styles.empty}
        aria-label="Set alias"
        title="Set an alias for the legend"
        onClick={edit}
      >
        as…
      </button>
    );
  }
  return (
    <span className={styles.box}>
      <span className={styles.as}>as</span>
      {draft !== undefined ? (
        <input
          className={styles.input}
          value={draft}
          autoFocus
          placeholder="alias"
          aria-label="Alias"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              save();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              closed.current = true;
              setDraft(undefined);
            }
          }}
        />
      ) : (
        <>
          <button type="button" className={styles.text} aria-label={`Alias ${alias}`} title="Edit alias" onClick={edit}>
            {alias}
          </button>
          <button type="button" className={styles.clear} aria-label="Remove alias" onClick={() => onChange(undefined)}>
            <Icon name="times" />
          </button>
        </>
      )}
    </span>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  const field = {
    height: ROW_HEIGHT - 2,
    border: 'none',
    background: 'transparent',
    color: theme.colors.text.primary,
    font: 'inherit',
  };
  return {
    empty: css({
      height: ROW_HEIGHT,
      padding: theme.spacing(0, 1),
      border: '1px solid transparent',
      borderRadius: theme.shape.radius.default,
      background: 'transparent',
      color: theme.colors.text.secondary,
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      '&:hover': { color: theme.colors.text.primary, background: theme.colors.action.hover },
    }),
    box: css({
      display: 'inline-flex',
      alignItems: 'stretch',
      height: ROW_HEIGHT,
      border: `1px solid ${theme.colors.border.medium}`,
      background: theme.colors.background.primary,
      '&:focus-within': { borderColor: theme.colors.primary.border },
    }),
    as: css({
      display: 'inline-flex',
      alignItems: 'center',
      padding: theme.spacing(0, 1),
      background: colors.labelBg,
      color: theme.colors.text.secondary,
    }),
    input: css(field, {
      width: 140,
      padding: theme.spacing(0, 1),
      outline: 'none',
    }),
    text: css(field, {
      maxWidth: 160,
      minWidth: 60,
      padding: theme.spacing(0, 1),
      textAlign: 'left',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      cursor: 'text',
    }),
    clear: css(field, {
      display: 'inline-flex',
      alignItems: 'center',
      padding: theme.spacing(0, 0.75),
      borderLeft: `1px solid ${theme.colors.border.medium}`,
      color: theme.colors.text.secondary,
      cursor: 'pointer',
      '&:hover': { color: theme.colors.text.primary },
    }),
  };
};
