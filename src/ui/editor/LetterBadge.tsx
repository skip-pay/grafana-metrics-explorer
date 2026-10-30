import React from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { getEditorColors, ROW_HEIGHT } from './styles';

export interface LetterBadgeProps {
  letter: string;
  hidden: boolean;
  onToggle: () => void;
  variant?: 'query' | 'formula';
}

/** The row's letter (or → for a formula): blue while shown, grey while hidden; a click toggles. */
export const LetterBadge = ({ letter, hidden, onToggle, variant = 'query' }: LetterBadgeProps) => {
  const styles = useStyles2(getStyles);
  const subject = variant === 'formula' ? 'formula' : `query ${letter}`;
  return (
    <button
      type="button"
      className={cx(styles.badge, hidden && styles.hidden)}
      aria-pressed={!hidden}
      aria-label={hidden ? `Show ${subject}` : `Hide ${subject}`}
      title={hidden ? `Show ${subject}` : `Hide ${subject} (it still feeds formulas)`}
      onClick={onToggle}
    >
      {variant === 'formula' ? <Icon name="arrow-right" /> : letter}
    </button>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    badge: css({
      width: ROW_HEIGHT,
      height: ROW_HEIGHT,
      flexShrink: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 0,
      border: 'none',
      borderRadius: `${theme.shape.radius.default} 0 0 ${theme.shape.radius.default}`,
      background: colors.badge,
      color: '#fff',
      fontSize: theme.typography.body.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
      cursor: 'pointer',
      '&:hover': { filter: 'brightness(1.1)' },
      '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: 1 },
    }),
    hidden: css({
      background: colors.badgeHidden,
      color: colors.badgeHiddenText,
    }),
  };
};
