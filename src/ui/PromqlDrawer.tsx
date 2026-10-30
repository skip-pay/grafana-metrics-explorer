import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { ClipboardButton, useStyles2 } from '@grafana/ui';

import { CompiledPlan } from '../compile';

interface Props {
  plan?: CompiledPlan;
}

/** The PromQL each row runs, with what is computed in the browser afterwards. */
export const PromqlDrawer = ({ plan }: Props) => {
  const styles = useStyles2(getStyles);
  const queries = plan?.queries ?? [];
  const formulas = plan?.formulas ?? [];
  return (
    <div className={styles.drawer} aria-label="PromQL">
      <div className={styles.header}>
        <span>PromQL</span>
        {plan && plan.queries.length > 0 && <span className={styles.note}>step {plan.stepSec}s</span>}
      </div>
      {queries.length === 0 && formulas.length === 0 && <div className={styles.note}>Nothing to run yet.</div>}
      {queries.map((q) => (
        <div key={q.refId} className={styles.row}>
          <span className={styles.badge}>{q.letter}</span>
          <div className={styles.text}>
            {q.skip ? (
              <span className={styles.note}>Not run: {q.skip}</span>
            ) : (
              <code className={styles.expr}>{q.expr}</code>
            )}
            {q.clientChain.length > 0 && (
              <span className={styles.note}>
                then in the browser: {q.clientChain.map((f) => `${f.name}()`).join(', ')}
              </span>
            )}
          </div>
          {!q.skip && q.expr !== '' && (
            <ClipboardButton
              getText={() => q.expr}
              size="sm"
              variant="secondary"
              fill="text"
              icon="copy"
              aria-label={`Copy the PromQL of ${q.letter}`}
            />
          )}
        </div>
      ))}
      {formulas.map((f) => (
        <div key={f.id} className={styles.row}>
          <span className={styles.badge}>ƒ</span>
          <div className={styles.text}>
            <code className={styles.expr}>{f.expression}</code>
            <span className={styles.note}>computed in the browser</span>
          </div>
        </div>
      ))}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  drawer: css({
    maxHeight: 220,
    overflowY: 'auto',
    padding: theme.spacing(1),
    border: `1px solid ${theme.colors.border.weak}`,
    borderRadius: theme.shape.radius.default,
    background: theme.colors.background.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  header: css({
    display: 'flex',
    gap: theme.spacing(1),
    alignItems: 'baseline',
    marginBottom: theme.spacing(0.5),
    fontWeight: theme.typography.fontWeightMedium,
  }),
  row: css({
    display: 'flex',
    alignItems: 'flex-start',
    gap: theme.spacing(1),
    padding: theme.spacing(0.5, 0),
    borderTop: `1px solid ${theme.colors.border.weak}`,
  }),
  badge: css({
    flexShrink: 0,
    width: 20,
    height: 20,
    lineHeight: '20px',
    textAlign: 'center',
    borderRadius: 2,
    background: theme.colors.background.canvas,
    color: theme.colors.text.secondary,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  text: css({
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  }),
  expr: css({
    fontFamily: theme.typography.fontFamilyMonospace,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    background: 'none',
    padding: 0,
    border: 'none',
  }),
  note: css({
    color: theme.colors.text.secondary,
  }),
});
