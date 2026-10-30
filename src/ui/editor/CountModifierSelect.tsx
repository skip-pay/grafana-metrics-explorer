import React from 'react';
import { useStyles2 } from '@grafana/ui';

import { MenuSelect } from '../MenuSelect';
import { getEditorStyles } from './styles';

export type CountMode = 'count' | 'rate';

export interface CountModifierSelectProps {
  value: CountMode;
  onChange: (mode: CountMode) => void;
}

/** The "as count" segment of counter metrics, switching between as_count() and as_rate(). */
export const CountModifierSelect = ({ value, onChange }: CountModifierSelectProps) => {
  const styles = useStyles2(getEditorStyles);
  return (
    <>
      <span className={styles.label}>as</span>
      <MenuSelect
        variant="segment"
        hideCaret
        value={value}
        options={[
          { value: 'count', label: 'count', description: 'Total per interval' },
          { value: 'rate', label: 'rate', description: 'Per second' },
        ]}
        onChange={onChange}
        ariaLabel={`Counter mode: ${value}`}
      />
    </>
  );
};
