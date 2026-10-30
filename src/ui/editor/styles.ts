import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';

/** Height of a query row and of every segment in it (Grafana's medium control height). */
export const ROW_HEIGHT = 32;
/** Blue of visible letter badges and highlighted list rows. */
export const QUERY_BLUE = '#006BC2';
const QUERY_BLUE_DARK = '#2a72c4';

/** Tints of the editor; the dark values are equivalent tints of the light ones. */
export const getEditorColors = (theme: GrafanaTheme2) => {
  const dark = theme.isDark;
  return {
    metricBg: dark ? 'rgba(250, 220, 80, 0.12)' : '#FFFFCC',
    groupBg: dark ? 'rgba(240, 100, 170, 0.14)' : '#FFE6F5',
    groupChipBorder: dark ? 'rgba(240, 100, 170, 0.45)' : '#F2BDDD',
    labelBg: dark ? theme.colors.background.secondary : '#E2E5ED',
    pillBg: dark ? 'rgba(80, 160, 230, 0.18)' : '#EAF6FC',
    pillKey: dark ? theme.colors.text.primary : '#1C2B34',
    pillOp: dark ? '#F075D0' : '#C2129D',
    pillValue: dark ? '#8FB8FF' : '#0C3472',
    match: dark ? '#5C5220' : '#FFF5BA',
    matchText: dark ? '#FFEAA0' : '#1C2B34',
    active: dark ? QUERY_BLUE_DARK : QUERY_BLUE,
    activeText: '#FFFFFF',
    badge: dark ? QUERY_BLUE_DARK : QUERY_BLUE,
    badgeHidden: dark ? 'rgba(204, 204, 220, 0.14)' : '#E2E5ED',
    badgeHiddenText: dark ? theme.colors.text.secondary : 'rgba(28, 43, 52, 0.5)',
    tagChipBg: dark ? 'rgba(80, 160, 230, 0.18)' : '#EAF6FC',
    tagChipText: dark ? '#8FB8FF' : QUERY_BLUE,
    hintBg: dark ? 'rgba(240, 80, 100, 0.28)' : '#FBD6DB',
  };
};

export const getEditorStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  const segment = css({
    display: 'inline-flex',
    alignItems: 'center',
    height: ROW_HEIGHT,
    padding: theme.spacing(0, 1),
    border: `1px solid ${theme.colors.border.medium}`,
    borderRadius: 0,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    fontSize: theme.typography.body.fontSize,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  });
  return {
    segment,
    segmentButton: css(segment, {
      cursor: 'pointer',
      fontFamily: 'inherit',
      '&:hover': { background: theme.colors.action.hover },
      '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: -2 },
    }),
    label: css(segment, {
      background: colors.labelBg,
      color: theme.colors.text.secondary,
    }),
    mark: css({
      background: colors.match,
      color: colors.matchText,
      fontWeight: theme.typography.fontWeightBold,
      padding: 0,
    }),
    caret: css({
      marginLeft: theme.spacing(0.5),
      color: theme.colors.text.secondary,
    }),
    popoverHeader: css({
      display: 'flex',
      justifyContent: 'space-between',
      gap: theme.spacing(1),
      padding: theme.spacing(1, 1.5, 0.5),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
    }),
    popoverError: css({
      padding: theme.spacing(0, 1.5, 0.5),
      color: theme.colors.error.text,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    negation: css({
      color: colors.pillOp,
      fontWeight: theme.typography.fontWeightBold,
      marginRight: 2,
    }),
    rowError: css({
      color: theme.colors.error.text,
      fontSize: theme.typography.bodySmall.fontSize,
      margin: theme.spacing(0.25, 0, 0.5, `${ROW_HEIGHT + 8}px`),
    }),
    rowWarning: css({
      color: theme.colors.warning.text,
      fontSize: theme.typography.bodySmall.fontSize,
      margin: theme.spacing(0.25, 0, 0.5, `${ROW_HEIGHT + 8}px`),
    }),
    /** Square icon button on the right of a row (`</>`, palette, delete). */
    iconButton: css({
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 28,
      height: 28,
      padding: theme.spacing(0, 0.5),
      border: '1px solid transparent',
      borderRadius: theme.shape.radius.default,
      background: 'transparent',
      color: theme.colors.text.secondary,
      fontFamily: theme.typography.fontFamilyMonospace,
      fontSize: theme.typography.bodySmall.fontSize,
      cursor: 'pointer',
      '&:hover': { color: theme.colors.text.primary, background: theme.colors.action.hover },
      '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: -2 },
      '&:disabled': { cursor: 'not-allowed', opacity: 0.4, pointerEvents: 'none' },
    }),
    iconButtonActive: css({
      color: colors.activeText,
      background: colors.active,
      '&:hover': { color: colors.activeText, background: colors.active },
    }),
  };
};
