import React, { ReactNode, useId, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, Tooltip, useStyles2 } from '@grafana/ui';

import { Popover } from './editor/Popover';
import { getEditorColors, getEditorStyles, ROW_HEIGHT } from './editor/styles';

export interface MenuSelectOption<T> {
  value: T;
  label: string;
  description?: string;
  /** Pictogram or swatch before the label. */
  icon?: ReactNode;
  disabled?: boolean;
}

interface Props<T> {
  value: T;
  options: Array<MenuSelectOption<T>>;
  onChange: (value: T) => void;
  /** Grey caption before the value, e.g. `Display:`. */
  label?: string;
  /** Shown between the caption and the value, e.g. a swatch. */
  prefix?: ReactNode;
  /** Plain text (display bar), a bordered box (top bar, split line) or a joined row segment. */
  variant?: 'plain' | 'bordered' | 'segment';
  /** Trigger text instead of the selected option's label. */
  valueText?: string;
  ariaLabel?: string;
  className?: string;
  tooltip?: string;
  menuWidth?: number;
  /** Segments of the query row show no ▾. */
  hideCaret?: boolean;
}

/** A compact `Caption: Value ▾` picker; the highlighted row is drawn white on blue, the selected one has a ✓. */
export function MenuSelect<T extends string | number>({
  value,
  options,
  onChange,
  label,
  prefix,
  variant = 'plain',
  valueText,
  ariaLabel,
  className,
  tooltip,
  menuWidth,
  hideCaret,
}: Props<T>) {
  const styles = useStyles2(getStyles);
  const editorStyles = useStyles2(getEditorStyles);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const selected = options.findIndex((o) => o.value === value);
  const current = options[selected];

  const show = () => {
    setActive(Math.max(0, selected));
    setOpen(true);
  };
  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) {
      return;
    }
    setOpen(false);
    if (option.value !== value) {
      onChange(option.value);
    }
  };
  const move = (delta: number) => {
    const n = options.length;
    for (let step = 1; step <= n; step++) {
      const index = (active + delta * step + n * step) % n;
      if (!options[index].disabled) {
        setActive(index);
        return;
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        e.preventDefault();
        if (open) {
          move(e.key === 'ArrowDown' ? 1 : -1);
        } else {
          show();
        }
        return;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (open) {
          choose(active);
        } else {
          show();
        }
        return;
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
      case 'Tab':
        setOpen(false);
        return;
    }
  };

  // The tooltip clones the trigger with its own ref, so the anchor ref goes through the tooltip then.
  const trigger = (ref?: (el: HTMLElement | null) => void) => (
    <button
      ref={ref}
      type="button"
      className={cx(
        styles.trigger,
        variant === 'bordered' && styles.bordered,
        variant === 'segment' && editorStyles.segmentButton,
        className
      )}
      aria-label={ariaLabel ?? (label ? label.replace(/:$/, '') : undefined)}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      onClick={() => (open ? setOpen(false) : show())}
      onKeyDown={onKeyDown}
      onBlur={() => setOpen(false)}
    >
      {label && <span className={styles.caption}>{label}</span>}
      {prefix}
      {current?.icon && variant !== 'segment' && <span className={styles.triggerIcon}>{current.icon}</span>}
      <span className={styles.value}>{valueText ?? current?.label ?? String(value)}</span>
      {!hideCaret && <Icon name="angle-down" className={styles.caret} />}
    </button>
  );

  return (
    <>
      {tooltip ? (
        <Tooltip content={tooltip} ref={setAnchor}>
          {trigger()}
        </Tooltip>
      ) : (
        trigger(setAnchor)
      )}
      <Popover anchor={anchor} open={open} keepFocus width={menuWidth} onClose={() => setOpen(false)}>
        <div id={listId} role="menu" className={styles.menu}>
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              role="menuitemradio"
              aria-checked={i === selected}
              aria-disabled={o.disabled || undefined}
              className={cx(styles.option, i === active && styles.active, o.disabled && styles.disabled)}
              onMouseEnter={() => !o.disabled && setActive(i)}
              onClick={() => choose(i)}
            >
              {o.icon && <span className={styles.optionIcon}>{o.icon}</span>}
              <span className={styles.optionText}>
                <span>{o.label}</span>
                {o.description && <span className={styles.description}>{o.description}</span>}
              </span>
              {i === selected && <Icon name="check" className={styles.check} />}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    trigger: css({
      display: 'inline-flex',
      alignItems: 'center',
      gap: theme.spacing(0.75),
      height: 28,
      padding: theme.spacing(0, 0.5),
      background: 'transparent',
      border: '1px solid transparent',
      borderRadius: theme.shape.radius.default,
      color: theme.colors.text.primary,
      fontSize: theme.typography.bodySmall.fontSize,
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
      '&:hover': { background: theme.colors.action.hover },
      '&:focus-visible': { outline: `2px solid ${theme.colors.primary.border}`, outlineOffset: -2 },
    }),
    bordered: css({
      height: ROW_HEIGHT,
      padding: theme.spacing(0, 1),
      border: `1px solid ${theme.colors.border.medium}`,
      background: theme.colors.background.primary,
      fontSize: theme.typography.body.fontSize,
    }),
    caption: css({
      color: theme.colors.text.secondary,
    }),
    triggerIcon: css({
      display: 'inline-flex',
      color: theme.colors.text.secondary,
    }),
    value: css({
      color: theme.colors.text.primary,
    }),
    caret: css({
      color: theme.colors.text.secondary,
    }),
    menu: css({
      overflowY: 'auto',
      minHeight: 0,
      padding: theme.spacing(0.5, 0),
    }),
    option: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      minHeight: 28,
      padding: theme.spacing(0.5, 1.5),
      cursor: 'pointer',
      color: theme.colors.text.primary,
      fontSize: theme.typography.body.fontSize,
      whiteSpace: 'nowrap',
    }),
    active: css({
      background: colors.active,
      color: colors.activeText,
      '& *': { color: colors.activeText },
    }),
    disabled: css({
      cursor: 'not-allowed',
      opacity: 0.5,
    }),
    optionIcon: css({
      display: 'inline-flex',
      flexShrink: 0,
      color: theme.colors.text.secondary,
    }),
    optionText: css({
      display: 'flex',
      flexDirection: 'column',
      flex: '1 1 auto',
      minWidth: 0,
    }),
    description: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
      whiteSpace: 'normal',
    }),
    check: css({
      flexShrink: 0,
    }),
  };
};
