import React, { useState } from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, Dropdown, Menu, useStyles2 } from '@grafana/ui';

import { SPLIT_LIMITS } from '../model/defaults';
import { Reducer, SplitOptions } from '../model/types';
import { getEditorColors } from './editor/styles';
import { MenuSelect, MenuSelectOption } from './MenuSelect';

interface Props {
  split: SplitOptions;
  /** Tag keys of the queried metrics; undefined hides the split controls (non-timeseries charts). */
  keys?: string[];
  onChange: (patch: Partial<SplitOptions>) => void;
  onCopyLink: () => void;
  onCopyPromql?: () => void;
  exploreUrl?: string;
}

type Mode = 'none' | 'tags';

const ORDER_OPTIONS: Array<MenuSelectOption<SplitOptions['order']>> = [
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom' },
];
const LIMIT_OPTIONS: Array<MenuSelectOption<number>> = SPLIT_LIMITS.map((n) => ({ value: n, label: String(n) }));
const SORT_OPTIONS: Array<MenuSelectOption<Reducer>> = (['avg', 'max', 'min', 'sum'] as Reducer[]).map((r) => ({
  value: r,
  label: r,
}));

/** `Split by: None ▾` (one graph per tag value when set) with the Share menu at the right end. */
export const SplitBar = ({ split, keys, onChange, onCopyLink, onCopyPromql, exploreUrl }: Props) => {
  const styles = useStyles2(getStyles);
  const [shareOpen, setShareOpen] = useState(false);
  const allKeys = keys && split.key && !keys.includes(split.key) ? [split.key, ...keys] : keys;
  const modes: Array<MenuSelectOption<Mode>> = [
    { value: 'none', label: 'None' },
    {
      value: 'tags',
      label: 'Tags',
      description: allKeys?.length ? 'One graph per tag value' : 'Pick a metric with tags first',
      disabled: !allKeys?.length,
    },
  ];
  const keyOptions: Array<MenuSelectOption<string>> = (allKeys ?? []).map((k) => ({ value: k, label: k }));

  const shareMenu = (
    <Menu>
      <Menu.Item label="Copy link" icon="link" onClick={onCopyLink} />
      <Menu.Item label="Copy PromQL" icon="copy" disabled={!onCopyPromql} onClick={onCopyPromql} />
      <Menu.Item label="Open in Explore" icon="compass" disabled={!exploreUrl} url={exploreUrl} target="_blank" />
    </Menu>
  );

  return (
    <div className={styles.wrapper}>
      <div className={styles.line}>
        {allKeys && (
          <MenuSelect
            variant="bordered"
            label="Split by:"
            value={split.key ? 'tags' : 'none'}
            options={modes}
            onChange={(mode) => onChange({ key: mode === 'tags' ? allKeys[0] : null })}
          />
        )}
        <span className={styles.spacer} />
        <Dropdown overlay={shareMenu} placement="bottom-end" onVisibleChange={setShareOpen}>
          <Button variant="secondary" fill="outline" icon="upload" aria-expanded={shareOpen}>
            Share
          </Button>
        </Dropdown>
      </div>
      {allKeys && split.key && (
        <div className={styles.line}>
          <span className={styles.caption}>One graph per</span>
          <MenuSelect
            variant="bordered"
            ariaLabel="One graph per"
            value={split.key}
            options={keyOptions}
            onChange={(key) => onChange({ key })}
            className={styles.key}
          />
          <span className={styles.caption}>Limit to</span>
          <span className={styles.joined}>
            <MenuSelect
              variant="bordered"
              ariaLabel="Limit order"
              value={split.order}
              options={ORDER_OPTIONS}
              onChange={(order) => onChange({ order })}
            />
            <MenuSelect
              variant="bordered"
              ariaLabel="Limit"
              value={split.limit}
              options={LIMIT_OPTIONS}
              onChange={(limit) => onChange({ limit })}
            />
          </span>
          <span className={styles.caption}>Sort by</span>
          <MenuSelect
            variant="bordered"
            ariaLabel="Sort by"
            value={split.sortBy}
            options={SORT_OPTIONS}
            onChange={(sortBy) => onChange({ sortBy })}
          />
        </div>
      )}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    wrapper: css({
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1),
    }),
    line: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing(1),
    }),
    spacer: css({
      flex: '1 1 auto',
    }),
    caption: css({
      color: theme.colors.text.primary,
      whiteSpace: 'nowrap',
    }),
    key: css({
      background: colors.groupBg,
    }),
    joined: css({
      display: 'inline-flex',
      '& > button + button': { marginLeft: -1 },
    }),
  };
};
