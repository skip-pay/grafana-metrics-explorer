import React from 'react';

import { SpaceAgg } from '../../model/types';
import { MenuSelect } from '../MenuSelect';

export interface AggregatorSelectProps {
  value: SpaceAgg;
  options: SpaceAgg[];
  onChange: (agg: SpaceAgg) => void;
}

/** The compact "avg by" segment; the menu lists the space aggregators the metric kind offers. */
export const AggregatorSelect = ({ value, options, onChange }: AggregatorSelectProps) => {
  const choices = options.includes(value) ? options : [value, ...options];
  return (
    <MenuSelect
      variant="segment"
      hideCaret
      value={value}
      options={choices.map((agg) => ({ value: agg, label: `${agg} by` }))}
      onChange={onChange}
      ariaLabel={`Space aggregation: ${value}`}
    />
  );
};
