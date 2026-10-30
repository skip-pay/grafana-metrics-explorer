import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

import { validateFormula } from '../../engine';
import { FormulaQuery } from '../../model/types';
import { AliasInput } from './AliasInput';
import { LetterBadge } from './LetterBadge';
import { DeleteButton } from './QueryRow';
import { getEditorStyles, ROW_HEIGHT } from './styles';

export interface FormulaRowProps {
  formula: FormulaQuery;
  /** Letters of the query rows the expression may reference. */
  letters: string[];
  onChange: (patch: Partial<FormulaQuery>) => void;
  onRemove: () => void;
  /** Evaluation error from the engine, shown when the expression itself is valid. */
  error?: string;
}

/** A formula row: → badge (hide/show), the expression validated as you type, alias and delete. */
export const FormulaRow = ({ formula, letters, onChange, onRemove, error }: FormulaRowProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const invalid = formula.expression.trim() === '' ? null : validateFormula(formula.expression, letters);
  const message = invalid ?? error;

  return (
    <div className={styles.wrapper} data-testid="formula-row">
      <div className={styles.row}>
        <LetterBadge
          letter="→"
          variant="formula"
          hidden={formula.hidden}
          onToggle={() => onChange({ hidden: !formula.hidden })}
        />
        <input
          className={styles.expression}
          value={formula.expression}
          placeholder="Formula, eg. 2*a"
          aria-label="Formula expression"
          aria-invalid={invalid !== null}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onChange({ expression: e.target.value })}
        />
        <div className={styles.actions}>
          <AliasInput alias={formula.alias} onChange={(alias) => onChange({ alias })} />
          <DeleteButton label="Delete formula" onClick={onRemove} />
        </div>
      </div>
      {message && (
        <div className={editorStyles.rowError} role="alert">
          {message}
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({
    display: 'flex',
    flexDirection: 'column',
  }),
  row: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1),
    minHeight: ROW_HEIGHT,
    // The badge joins the expression box.
    '& > button:first-child': { marginRight: `-${theme.spacing(1)}` },
  }),
  expression: css({
    flex: '1 1 320px',
    minWidth: 0,
    maxWidth: 720,
    height: ROW_HEIGHT,
    padding: theme.spacing(0, 1),
    border: `1px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    font: 'inherit',
    outline: 'none',
    '&:focus': { borderColor: theme.colors.primary.border },
    '&[aria-invalid="true"]': { borderColor: theme.colors.error.border },
    '&::placeholder': { color: theme.colors.text.secondary, opacity: 1 },
  }),
  actions: css({
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(0.5),
    marginLeft: 'auto',
  }),
});
