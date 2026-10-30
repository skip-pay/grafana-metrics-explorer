import React from 'react';
import { useStyles2 } from '@grafana/ui';

import { getEditorStyles } from './styles';

export interface HighlightProps {
  text: string;
  /** [start, end) character ranges to mark; may be unsorted or overlapping. */
  ranges: Array<[number, number]>;
  className?: string;
  /** Hover text, e.g. the full name when the row is cut off. */
  title?: string;
}

export const Highlight = ({ text, ranges, className, title }: HighlightProps) => {
  const styles = useStyles2(getEditorStyles);
  return (
    <span className={className} title={title}>
      {splitByRanges(text, ranges).map((part, i) =>
        part.match ? (
          <mark key={i} className={styles.mark}>
            {part.text}
          </mark>
        ) : (
          <React.Fragment key={i}>{part.text}</React.Fragment>
        )
      )}
    </span>
  );
};

export function splitByRanges(text: string, ranges: Array<[number, number]>): Array<{ text: string; match: boolean }> {
  const sorted = ranges
    .map(([start, end]): [number, number] => [Math.max(0, start), Math.min(text.length, end)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);
  const parts: Array<{ text: string; match: boolean }> = [];
  let pos = 0;
  for (const [start, end] of sorted) {
    if (end <= pos) {
      continue;
    }
    const from = Math.max(start, pos);
    if (from > pos) {
      parts.push({ text: text.slice(pos, from), match: false });
    }
    parts.push({ text: text.slice(from, end), match: true });
    pos = end;
  }
  if (pos < text.length) {
    parts.push({ text: text.slice(pos), match: false });
  }
  return parts;
}
