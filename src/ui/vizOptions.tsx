import React, { ReactNode } from 'react';

import { Visualization } from '../model/types';
import { MenuSelectOption } from './MenuSelect';

/** 22×16 grey pictogram drawn in the current text colour. */
const Pictogram = ({ children }: { children: ReactNode }) => (
  <svg width={22} height={16} viewBox="0 0 22 16" fill="none" stroke="currentColor" aria-hidden>
    {children}
  </svg>
);

const ICONS: Record<Visualization, ReactNode> = {
  timeseries: (
    <Pictogram>
      <path d="M1 15h20" />
      <path d="M2 12l4-5 3 3 4-7 3 6 4-3" strokeLinejoin="round" />
    </Pictogram>
  ),
  queryvalue: (
    <Pictogram>
      <rect x="1.5" y="2.5" width="19" height="11" rx="1" />
      <text x="11" y="11" fontSize="7" textAnchor="middle" fill="currentColor" stroke="none">
        3.14
      </text>
    </Pictogram>
  ),
  table: (
    <Pictogram>
      <path d="M1 2.5h20M1 6.5h20M1 10h20M1 13.5h20M8 2.5v11" />
    </Pictogram>
  ),
  heatmap: (
    <Pictogram>
      <g stroke="none" fill="currentColor">
        <rect x="1" y="2" width="6" height="4" opacity="0.3" />
        <rect x="8" y="2" width="6" height="4" opacity="0.7" />
        <rect x="15" y="2" width="6" height="4" opacity="0.5" />
        <rect x="1" y="7" width="6" height="4" opacity="0.8" />
        <rect x="8" y="7" width="6" height="4" opacity="0.4" />
        <rect x="15" y="7" width="6" height="4" opacity="0.9" />
        <rect x="1" y="12" width="6" height="3" opacity="0.5" />
        <rect x="8" y="12" width="6" height="3" opacity="1" />
        <rect x="15" y="12" width="6" height="3" opacity="0.3" />
      </g>
    </Pictogram>
  ),
  distribution: (
    <Pictogram>
      <path d="M1 15h20" />
      <g stroke="none" fill="currentColor">
        <rect x="2" y="12" width="2.5" height="3" />
        <rect x="5" y="9" width="2.5" height="6" />
        <rect x="8" y="4" width="2.5" height="11" />
        <rect x="11" y="2" width="2.5" height="13" />
        <rect x="14" y="7" width="2.5" height="8" />
        <rect x="17" y="11" width="2.5" height="4" />
      </g>
    </Pictogram>
  ),
  toplist: (
    <Pictogram>
      <g stroke="none" fill="currentColor">
        <rect x="1" y="1.5" width="20" height="2.5" />
        <rect x="1" y="5.5" width="15" height="2.5" />
        <rect x="1" y="9.5" width="10" height="2.5" />
        <rect x="1" y="13.5" width="6" height="2.5" />
      </g>
    </Pictogram>
  ),
  barchart: (
    <Pictogram>
      <path d="M1 15h20" />
      <g stroke="none" fill="currentColor">
        <rect x="3" y="6" width="3" height="9" />
        <rect x="8" y="9" width="3" height="6" />
        <rect x="13" y="3" width="3" height="12" />
        <rect x="18" y="8" width="2.5" height="7" />
      </g>
    </Pictogram>
  ),
  piechart: (
    <Pictogram>
      <circle cx="11" cy="8" r="5.5" strokeWidth="3" />
      <path d="M11 2.5V8l4.5 3" strokeWidth="1" />
    </Pictogram>
  ),
};

/** The visualizations we implement, in menu order, each with its pictogram and a one-line subtitle. */
export const VIZ_OPTIONS: Array<MenuSelectOption<Visualization>> = (
  [
    ['timeseries', 'Timeseries', 'Display metrics over time'],
    ['queryvalue', 'Query Value', 'Highlight the value of a metric query'],
    ['table', 'Table', 'Display columns of aggregated data grouped by tag keys'],
    ['heatmap', 'Heatmap', 'Show the distribution of the values over time as coloured cells'],
    ['distribution', 'Distribution', 'Graph how often each value occurs'],
    ['toplist', 'Top List', 'Show an ordered ranking of tags by a metric'],
    ['barchart', 'Bar Chart', 'Compare data across different tag values'],
    ['piechart', 'Pie Chart', 'Display the groups with their proportions'],
  ] as Array<[Visualization, string, string]>
).map(([value, label, description]) => ({ value, label, description, icon: ICONS[value] }));
