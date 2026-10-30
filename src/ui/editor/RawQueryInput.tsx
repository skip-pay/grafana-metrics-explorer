import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

import { parseQueryText, renderQueryText } from '../../compile';
import { MetricInfo, MetricQuery } from '../../model/types';
import { ROW_HEIGHT } from './styles';

export interface RawQueryInputProps {
  query: MetricQuery;
  /** Info of the query's current metric, for rendering its text form. */
  metricInfo?: MetricInfo;
  metrics: MetricInfo[];
  onApply: (patch: Partial<MetricQuery>) => void;
  onCancel: () => void;
}

/** The `</>` mode: the query as text, e.g. `sum:m{env:prod} by {path}.as_count()`; Enter applies, Esc cancels. */
export const RawQueryInput = ({ query, metricInfo, metrics, onApply, onCancel }: RawQueryInputProps) => {
  const styles = useStyles2(getStyles);
  const [text, setText] = useState(() => renderQueryText(query, metricInfo));
  const [error, setError] = useState<string>();

  const apply = () => {
    const parsed = parseQueryText(text, metrics);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    onApply(parsed);
  };

  return (
    <div className={styles.wrapper}>
      <input
        className={styles.input}
        value={text}
        autoFocus
        aria-label="Query text"
        aria-invalid={error !== undefined}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setText(e.target.value);
          setError(undefined);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : (
        <div className={styles.hint}>Enter to apply, Esc to cancel</div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  wrapper: css({
    display: 'flex',
    flexDirection: 'column',
    flex: '1 1 320px',
    minWidth: 0,
  }),
  input: css({
    height: ROW_HEIGHT,
    padding: theme.spacing(0, 1),
    border: `1px solid ${theme.colors.border.medium}`,
    background: theme.colors.background.primary,
    color: theme.colors.text.primary,
    fontFamily: theme.typography.fontFamilyMonospace,
    fontSize: theme.typography.bodySmall.fontSize,
    outline: 'none',
    '&:focus': { borderColor: theme.colors.primary.border },
    '&[aria-invalid="true"]': { borderColor: theme.colors.error.border },
  }),
  error: css({
    color: theme.colors.error.text,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.25),
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    marginTop: theme.spacing(0.25),
  }),
});
