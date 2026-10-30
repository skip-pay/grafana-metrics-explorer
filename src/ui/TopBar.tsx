import React from 'react';
import { css } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { ToolbarButton, useStyles2 } from '@grafana/ui';

import { Visualization } from '../model/types';
import { MenuSelect } from './MenuSelect';
import { VIZ_OPTIONS } from './vizOptions';

interface Props {
  viz: Visualization;
  onVizChange: (viz: Visualization) => void;
  showPromql: boolean;
  onTogglePromql: () => void;
}

/** `Visualization: [icon] Timeseries ▾` on the left, the PromQL drawer toggle on the right. */
export const TopBar = ({ viz, onVizChange, showPromql, onTogglePromql }: Props) => {
  const styles = useStyles2(getStyles);
  return (
    <div className={styles.bar}>
      <MenuSelect
        variant="bordered"
        label="Visualization:"
        value={viz}
        options={VIZ_OPTIONS}
        onChange={onVizChange}
        menuWidth={420}
      />
      <ToolbarButton
        icon="brackets-curly"
        variant={showPromql ? 'active' : 'default'}
        aria-pressed={showPromql}
        tooltip="Show the PromQL of every query"
        onClick={onTogglePromql}
      >
        PromQL
      </ToolbarButton>
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => ({
  bar: css({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    // Grafana's panel menu appears in the top right corner on hover.
    paddingRight: theme.spacing(4),
  }),
});
