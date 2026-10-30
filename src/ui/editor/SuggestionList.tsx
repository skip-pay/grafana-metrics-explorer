import React, { useEffect, useRef } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { useStyles2 } from '@grafana/ui';

import { getEditorColors } from './styles';
import { preventDefault } from './utils';

const OPTION_HEIGHT = 28;

export interface SuggestionItem {
  id: string;
  content: React.ReactNode;
  /** Group label shown above the first item of a run of items with the same group. */
  group?: string;
}

export interface SuggestionListProps {
  /** DOM id of the listbox; options get `<id>-<index>` for aria-activedescendant. */
  id: string;
  items: SuggestionItem[];
  active: number;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
  emptyText?: React.ReactNode;
  className?: string;
  /** `strong` draws the highlighted row white on blue; `soft` tints it and shows ↵. */
  variant?: 'strong' | 'soft';
  /** Rows visible before the list scrolls. */
  visibleRows?: number;
}

/** Listbox of suggestions; mousedown never takes focus from the input that drives it. */
export const SuggestionList = ({
  id,
  items,
  active,
  onHover,
  onPick,
  emptyText,
  className,
  variant = 'soft',
  visibleRows,
}: SuggestionListProps) => {
  const styles = useStyles2(getStyles);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Scroll the list itself (scrollIntoView would also scroll the dashboard).
    const list = listRef.current;
    const option = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!list || !option) {
      return;
    }
    if (option.offsetTop < list.scrollTop) {
      list.scrollTop = option.offsetTop;
    } else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [active, items]);

  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      className={cx(styles.list, className)}
      style={visibleRows ? { maxHeight: visibleRows * OPTION_HEIGHT + 8 } : undefined}
      onMouseDown={preventDefault}
    >
      {items.length === 0 && emptyText && <div className={styles.empty}>{emptyText}</div>}
      {items.map((item, i) => (
        <React.Fragment key={item.id}>
          {item.group !== undefined && item.group !== items[i - 1]?.group && (
            <div className={styles.group} role="presentation">
              {item.group}
            </div>
          )}
          <div
            id={`${id}-${i}`}
            role="option"
            aria-selected={i === active}
            data-index={i}
            className={cx(styles.option, i === active && (variant === 'strong' ? styles.strong : styles.active))}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(i)}
          >
            <div className={styles.content}>{item.content}</div>
            {i === active && variant === 'soft' && (
              <span className={styles.enter} aria-hidden>
                ↵
              </span>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    list: css({
      position: 'relative',
      overflowY: 'auto',
      minHeight: 0,
      flex: '1 1 auto',
      padding: theme.spacing(0.5),
    }),
    option: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      minHeight: OPTION_HEIGHT,
      padding: theme.spacing(0.25, 1),
      cursor: 'pointer',
      color: theme.colors.text.primary,
    }),
    active: css({
      background: colors.pillBg,
    }),
    strong: css({
      background: colors.active,
      color: colors.activeText,
    }),
    content: css({
      flex: '1 1 auto',
      minWidth: 0,
    }),
    enter: css({
      color: theme.colors.text.secondary,
      flexShrink: 0,
    }),
    group: css({
      padding: theme.spacing(1, 1, 0.5),
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontWeight: theme.typography.fontWeightMedium,
    }),
    empty: css({
      padding: theme.spacing(1),
      color: theme.colors.text.secondary,
    }),
  };
};
