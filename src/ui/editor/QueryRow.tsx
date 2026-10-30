import React, { useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, Tooltip, useStyles2 } from '@grafana/ui';

import { Catalog, TimeWindow } from '../../catalog';
import { newFunctionCall } from '../../compile';
import { aggregatorsForKind, newId, withMetric } from '../../model/defaults';
import { FunctionCall, MetricInfo, MetricQuery, ResolvedMetric } from '../../model/types';
import { AggregatorSelect } from './AggregatorSelect';
import { AliasInput } from './AliasInput';
import { ColorOverride } from './ColorOverride';
import { CountMode, CountModifierSelect } from './CountModifierSelect';
import { FunctionSegments } from './FunctionSegments';
import { GroupByField } from './GroupByField';
import { LetterBadge } from './LetterBadge';
import { MetricPicker } from './MetricPicker';
import { ModifyMenu } from './ModifyMenu';
import { RawQueryInput } from './RawQueryInput';
import { getEditorColors, getEditorStyles, ROW_HEIGHT } from './styles';
import { TagFilterField } from './TagFilterField';
import { isCounterKind } from './utils';

export interface QueryRowProps {
  query: MetricQuery;
  /** Catalogue entry of `query.metric`, if known. */
  metricInfo?: MetricInfo;
  /** `query.metric` resolved (label keys, refined kind); undefined while resolving or without a metric. */
  resolved?: ResolvedMetric;
  /** Every metric of the catalogue; empty while loading. */
  metrics: MetricInfo[];
  metricsLoading?: boolean;
  catalog: Catalog;
  timeWindow: TimeWindow;
  /** Why the query cannot be deleted (the only query, or used by a formula); undefined allows it. */
  deleteBlocked?: string;
  onChange: (patch: Partial<MetricQuery>) => void;
  onRemove: () => void;
  /** Compile warnings or a row error, shown under the row. */
  warnings?: string[];
}

const CLOUDWATCH_HINT = 'Each dimension set is a separate series — filter by dimensions to avoid double counting.';
/** Left edge of the function line: under the metric field (badge + "Metrics" segment). */
const FUNCTIONS_INDENT = ROW_HEIGHT + 84;

/**
 * One query row: `a | Metrics | <metric> | from <tags> | <agg> by <keys> | as count | Σ Modify`, with
 * `</>`, colour, alias and delete on the right. Applied functions form a second line under the row.
 */
export const QueryRow = ({
  query,
  metricInfo,
  resolved,
  metrics,
  metricsLoading,
  catalog,
  timeWindow,
  deleteBlocked,
  onChange,
  onRemove,
  warnings,
}: QueryRowProps) => {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [raw, setRaw] = useState(false);

  const kind = resolved?.kind ?? metricInfo?.kind;
  const counter = isCounterKind(kind);
  const countModifiers = query.functions.filter(isCountModifier);
  const countMode: CountMode = countModifiers.some((f) => f.name === 'as_rate') ? 'rate' : 'count';
  // Counters show as_count/as_rate in the "as" segment instead of as function segments.
  const shownFunctions = counter ? query.functions.filter((f) => !isCountModifier(f)) : query.functions;

  const withPicked = (name: string): MetricQuery => {
    const picked = metrics.find((m) => m.name === name);
    return name === query.metric ? query : withMetric(query, name, picked?.kind ?? 'gauge');
  };
  const pickMetric = (name: string) => {
    const next = withPicked(name);
    onChange({ metric: next.metric, spaceAgg: next.spaceAgg, functions: next.functions });
  };
  const groupByTag = (name: string, key: string) => {
    const next = withPicked(name);
    const groupBy = next.groupBy.includes(key) ? next.groupBy : [...next.groupBy, key];
    onChange({ metric: next.metric, spaceAgg: next.spaceAgg, functions: next.functions, groupBy });
  };

  const setCountMode = (mode: CountMode) => {
    const name = mode === 'rate' ? 'as_rate' : 'as_count';
    const existing = countModifiers[0];
    const functions = existing
      ? query.functions
          .filter((f) => !isCountModifier(f) || f === existing)
          .map((f) => (f === existing ? { ...f, name } : f))
      : [...query.functions, { id: newId(), name, args: [] }];
    onChange({ functions });
  };

  const addFunction = (name: string) => onChange({ functions: [...query.functions, newFunctionCall(name)] });
  const modify = <ModifyMenu onAdd={addFunction} />;

  return (
    <div className={styles.wrapper} data-testid={`query-row-${query.letter}`}>
      <div className={styles.row}>
        <div className={styles.query}>
          <LetterBadge
            letter={query.letter}
            hidden={query.hidden}
            onToggle={() => onChange({ hidden: !query.hidden })}
          />
          <span className={editorStyles.segment} title="Data source">
            Metrics
            <Icon name="angle-down" className={editorStyles.caret} />
          </span>
          {raw ? (
            <RawQueryInput
              query={query}
              metricInfo={metricInfo}
              metrics={metrics}
              onApply={(patch) => {
                onChange(patch);
                setRaw(false);
              }}
              onCancel={() => setRaw(false)}
            />
          ) : (
            <>
              <MetricPicker
                value={query.metric}
                metrics={metrics}
                loading={metricsLoading}
                onChange={pickMetric}
                onGroupBy={groupByTag}
                catalog={catalog}
                timeWindow={timeWindow}
              />
              {kind === 'cloudwatch' && (
                <Tooltip content={CLOUDWATCH_HINT}>
                  <span className={styles.hint} aria-label={CLOUDWATCH_HINT}>
                    <Icon name="info-circle" />
                  </span>
                </Tooltip>
              )}
              <span className={styles.group}>
                <span className={editorStyles.label}>from</span>
                <TagFilterField
                  filters={query.filters}
                  resolved={resolved}
                  catalog={catalog}
                  timeWindow={timeWindow}
                  metric={query.metric}
                  onChange={(filters) => onChange({ filters })}
                />
              </span>
              <span className={styles.group}>
                <AggregatorSelect
                  value={query.spaceAgg}
                  options={aggregatorsForKind(kind ?? 'gauge')}
                  onChange={(spaceAgg) => onChange({ spaceAgg })}
                />
                <GroupByField
                  groupBy={query.groupBy}
                  resolved={resolved}
                  onChange={(groupBy) => onChange({ groupBy })}
                />
              </span>
              {counter && (
                <span className={styles.group}>
                  <CountModifierSelect value={countMode} onChange={setCountMode} />
                </span>
              )}
              {shownFunctions.length === 0 && <span className={cx(styles.modify, styles.modifyInline)}>{modify}</span>}
            </>
          )}
        </div>
        <div className={styles.actions}>
          <Tooltip content={raw ? 'Edit with formatting and suggestions' : 'Edit raw query'}>
            <button
              type="button"
              className={cx(editorStyles.iconButton, raw && editorStyles.iconButtonActive)}
              aria-label="Edit query as text"
              aria-pressed={raw}
              onClick={() => setRaw(!raw)}
            >
              {raw ? <Icon name="sliders-v-alt" /> : '</>'}
            </button>
          </Tooltip>
          <ColorOverride
            color={query.color}
            grouped={query.groupBy.length > 0}
            onChange={(color) => onChange({ color })}
          />
          <AliasInput alias={query.alias} onChange={(alias) => onChange({ alias })} />
          <DeleteButton label="Delete query" blocked={deleteBlocked} onClick={onRemove} />
        </div>
      </div>
      {!raw && shownFunctions.length > 0 && (
        <div className={styles.functions}>
          <span className={styles.connector} aria-hidden />
          <FunctionSegments
            functions={shownFunctions}
            onChange={(functions) => onChange({ functions: counter ? [...countModifiers, ...functions] : functions })}
          />
          <span className={styles.modify}>{modify}</span>
        </div>
      )}
      {warnings?.map((warning) => (
        <div key={warning} className={editorStyles.rowWarning}>
          {warning}
        </div>
      ))}
    </div>
  );
};

interface DeleteButtonProps {
  label: string;
  /** Reason the row cannot be deleted; shown as the tooltip of the disabled button. */
  blocked?: string;
  onClick: () => void;
}

/** The persistent ⊗ at the right end of a row. */
export const DeleteButton = ({ label, blocked, onClick }: DeleteButtonProps) => {
  const editorStyles = useStyles2(getEditorStyles);
  return (
    <Tooltip content={blocked ?? label}>
      {/* The span keeps the tooltip working while the button is disabled. */}
      <span>
        <button
          type="button"
          className={editorStyles.iconButton}
          aria-label={label}
          disabled={blocked !== undefined}
          onClick={onClick}
        >
          <Icon name="times-circle" />
        </button>
      </span>
    </Tooltip>
  );
};

function isCountModifier(f: FunctionCall): boolean {
  return f.name === 'as_count' || f.name === 'as_rate';
}

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    wrapper: css({
      display: 'flex',
      flexDirection: 'column',
    }),
    row: css({
      display: 'flex',
      alignItems: 'flex-start',
      gap: theme.spacing(1),
    }),
    query: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      rowGap: theme.spacing(0.5),
      flex: '1 1 auto',
      minWidth: 0,
      // Joined segments: neighbours share one border.
      '& > * + *': { marginLeft: -1 },
    }),
    // A label and its field wrap to the next line together.
    group: css({
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: '100%',
      '& > * + *': { marginLeft: -1 },
    }),
    hint: css({
      display: 'inline-flex',
      alignItems: 'center',
      height: ROW_HEIGHT,
      padding: theme.spacing(0, 0.75),
      border: `1px solid ${theme.colors.border.medium}`,
      background: colors.metricBg,
      color: theme.colors.text.secondary,
    }),
    modify: css({
      display: 'inline-flex',
      '& > button': { borderRadius: theme.shape.radius.default },
    }),
    // Beats the joined-segment margin of the row.
    modifyInline: css({
      marginLeft: `${theme.spacing(1)} !important`,
    }),
    actions: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(0.5),
      height: ROW_HEIGHT,
      flexShrink: 0,
    }),
    functions: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      rowGap: theme.spacing(0.5),
      columnGap: theme.spacing(1),
      marginTop: theme.spacing(0.5),
      paddingLeft: FUNCTIONS_INDENT - 12,
    }),
    connector: css({
      width: 8,
      height: 1,
      marginRight: -4,
      background: theme.colors.border.medium,
    }),
  };
};
