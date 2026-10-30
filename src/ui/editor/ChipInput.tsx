import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, Tooltip, useStyles2 } from '@grafana/ui';

import { Popover } from './Popover';
import { getEditorColors, ROW_HEIGHT } from './styles';
import { SuggestionItem, SuggestionList } from './SuggestionList';
import { insideParens, preventDefault } from './utils';

export interface ChipModel {
  id: string;
  content: React.ReactNode;
  /** Shown before the pill box, e.g. the `!` of an exclusion. */
  prefix?: React.ReactNode;
  /** Plain text of the chip for screen readers. */
  label: string;
  invalid?: boolean;
  tooltip?: string;
}

export interface ChipInputProps {
  chips: ChipModel[];
  text: string;
  onTextChange: (text: string) => void;
  /** Where the caret goes when the parent sets the text; the browser keeps its own when omitted. */
  caret?: number;
  /** The caret moved: typing, a click or a key such as the arrows. */
  onCaretChange?: (caret: number) => void;
  suggestions: SuggestionItem[];
  onPick: (index: number) => void;
  /** Enter (nothing highlighted) or `,` with typed text; the parent decides whether it becomes a chip. */
  onCommit: (text: string) => void;
  onRemoveChip: (index: number) => void;
  /** Click on a chip: the parent turns it back into text. */
  onEditChip: (index: number) => void;
  onClear: () => void;
  /** Return true when the pasted text was handled (default paste is then suppressed). */
  onPasteText?: (text: string) => boolean;
  onOpenChange?: (open: boolean) => void;
  placeholder: string;
  ariaLabel: string;
  className?: string;
  /** Popover content above and below the suggestion list. */
  header?: React.ReactNode;
  footer?: React.ReactNode;
  emptyText?: React.ReactNode;
  popoverWidth?: number;
  testId?: string;
  /** `filter`: square pills joined by commas; `group`: pink chips. */
  chipVariant?: 'filter' | 'group';
  /** Suggestion list look and height, see SuggestionList. */
  listVariant?: 'strong' | 'soft';
  visibleRows?: number;
}

/** Chip field with an inline text input and a keyboard-driven suggestion popover. */
export const ChipInput = ({
  chips,
  text,
  onTextChange,
  caret,
  onCaretChange,
  suggestions,
  onPick,
  onCommit,
  onRemoveChip,
  onEditChip,
  onClear,
  onPasteText,
  onOpenChange,
  placeholder,
  ariaLabel,
  className,
  header,
  footer,
  emptyText,
  popoverWidth = 420,
  testId,
  chipVariant = 'filter',
  listVariant,
  visibleRows,
}: ChipInputProps) => {
  const styles = useStyles2(getStyles);
  const [anchor, setAnchor] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpenState] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const activeIndex = suggestions.length === 0 ? -1 : Math.min(active, suggestions.length - 1);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (caret !== undefined && input && input === document.activeElement && input.selectionStart !== caret) {
      input.setSelectionRange(caret, caret);
    }
  }, [text, caret]);

  const setOpen = (next: boolean) => {
    if (next !== open) {
      setOpenState(next);
      onOpenChange?.(next);
    }
  };

  const pick = (index: number) => {
    onPick(index);
    setActive(0);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        const n = suggestions.length;
        if (n > 0) {
          setActive((activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n);
        }
        return;
      }
      case 'Enter':
        e.preventDefault();
        if (open && activeIndex >= 0) {
          pick(activeIndex);
          return;
        }
        if (text.trim() !== '') {
          onCommit(text.trim());
        }
        // Open, so a commit error in the header is visible.
        setOpen(true);
        return;
      case 'Tab':
        // Accept only what the user typed for; tabbing through an untouched field adds nothing.
        if (open && activeIndex >= 0 && text.trim() !== '') {
          pick(activeIndex);
        }
        return;
      case 'Escape':
        if (open) {
          // Keep Grafana's global Esc (leave panel view) out of it while the list is open.
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        }
        return;
      case 'Backspace':
        if (text === '' && chips.length > 0) {
          e.preventDefault();
          onRemoveChip(chips.length - 1);
        }
        return;
      case ',':
        if (!insideParens(text.slice(0, e.currentTarget.selectionStart ?? text.length))) {
          e.preventDefault();
          if (text.trim() !== '') {
            onCommit(text.trim());
          }
        }
        return;
    }
  };

  const reportCaret = (e: React.SyntheticEvent<HTMLInputElement>) =>
    onCaretChange?.(e.currentTarget.selectionStart ?? e.currentTarget.value.length);

  const focusInput = (e: React.MouseEvent) => {
    if (e.target !== inputRef.current) {
      e.preventDefault();
      inputRef.current?.focus();
      setOpen(true);
    }
  };

  const editChip = (index: number) => {
    onEditChip(index);
    inputRef.current?.focus();
    setOpen(true);
  };

  const showPlaceholder = chips.length === 0;
  return (
    <>
      <div
        ref={setAnchor}
        className={cx(styles.field, className)}
        onMouseDown={focusInput}
        data-testid={testId}
        data-open={open}
      >
        {chips.map((chip, i) => (
          <React.Fragment key={chip.id}>
            {chipVariant === 'filter' && i > 0 && <span className={styles.separator}>,</span>}
            <Chip chip={chip} variant={chipVariant} onEdit={() => editChip(i)} onRemove={() => onRemoveChip(i)} />
          </React.Fragment>
        ))}
        <span className={styles.sizer} data-value={text || (showPlaceholder ? placeholder : '')}>
          <input
            ref={inputRef}
            className={styles.input}
            size={1}
            value={text}
            placeholder={showPlaceholder ? placeholder : ''}
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onTextChange(e.target.value);
              onCaretChange?.(e.target.selectionStart ?? e.target.value.length);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            // After the key or click has moved the caret; a pick's own caret is set by then.
            onKeyUp={reportCaret}
            onClick={reportCaret}
            onFocus={() => setOpen(true)}
            onBlur={() => setOpen(false)}
            onPaste={(e) => {
              if (onPasteText?.(e.clipboardData.getData('text'))) {
                e.preventDefault();
              }
            }}
          />
        </span>
        {(chips.length > 0 || text !== '') && (
          <button
            type="button"
            className={styles.clear}
            aria-label={`Clear ${ariaLabel}`}
            onMouseDown={preventDefault}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
          >
            <Icon name="times" />
          </button>
        )}
      </div>
      <Popover anchor={anchor} open={open} keepFocus width={popoverWidth}>
        {header}
        <SuggestionList
          id={listId}
          items={suggestions}
          active={activeIndex}
          onHover={setActive}
          onPick={pick}
          emptyText={emptyText}
          variant={listVariant}
          visibleRows={visibleRows}
        />
        {footer}
      </Popover>
    </>
  );
};

interface ChipProps {
  chip: ChipModel;
  variant: 'filter' | 'group';
  onEdit: () => void;
  onRemove: () => void;
}

const Chip = ({ chip, variant, onEdit, onRemove }: ChipProps) => {
  const styles = useStyles2(getStyles);
  const box = (
    <span
      className={cx(styles.chip, variant === 'filter' ? styles.pill : styles.group, chip.invalid && styles.chipInvalid)}
      data-testid="chip"
      data-invalid={chip.invalid || undefined}
      title={chip.tooltip ? undefined : `Edit ${chip.label}`}
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onClick={onEdit}
    >
      <span className={styles.chipText}>{chip.content}</span>
      <button
        type="button"
        className={styles.chipRemove}
        aria-label={`Remove ${chip.label}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        <Icon name="times" size="sm" />
      </button>
    </span>
  );
  const element = chip.prefix ? (
    <span className={styles.prefixed}>
      {chip.prefix}
      {box}
    </span>
  ) : (
    box
  );
  return chip.tooltip ? (
    <Tooltip content={chip.tooltip} theme={chip.invalid ? 'error' : 'info'}>
      {element}
    </Tooltip>
  ) : (
    element
  );
};

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    field: css({
      display: 'inline-flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 2,
      minHeight: ROW_HEIGHT,
      minWidth: 120,
      maxWidth: 560,
      padding: theme.spacing(0, 0.5),
      border: `1px solid ${theme.colors.border.medium}`,
      background: theme.colors.background.primary,
      cursor: 'text',
      position: 'relative',
      '&:focus-within': {
        borderColor: theme.colors.primary.border,
        zIndex: 1,
      },
    }),
    sizer: css({
      display: 'inline-grid',
      flex: '1 0 auto',
      minWidth: 40,
      '&::after': {
        content: 'attr(data-value) " "',
        visibility: 'hidden',
        whiteSpace: 'pre',
        gridArea: '1 / 1',
        font: 'inherit',
        padding: theme.spacing(0, 0.5),
      },
    }),
    input: css({
      gridArea: '1 / 1',
      width: '100%',
      minWidth: 0,
      height: ROW_HEIGHT - 2,
      padding: theme.spacing(0, 0.5),
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: theme.colors.text.primary,
      font: 'inherit',
      '&::placeholder': { color: theme.colors.text.secondary, opacity: 1 },
    }),
    clear: css({
      display: 'inline-flex',
      alignItems: 'center',
      padding: 2,
      border: 'none',
      background: 'transparent',
      color: theme.colors.text.secondary,
      cursor: 'pointer',
      opacity: 0,
      '[data-open="true"] > &, div:hover > &': { opacity: 1 },
      '&:hover': { color: theme.colors.text.primary },
      '&:focus-visible': { opacity: 1 },
    }),
    chip: css({
      display: 'inline-flex',
      alignItems: 'center',
      maxWidth: 320,
      height: ROW_HEIGHT - 10,
      padding: theme.spacing(0, 0.25, 0, 0.75),
      border: '1px solid transparent',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      '&:hover button': { opacity: 1 },
    }),
    pill: css({
      background: colors.pillBg,
      borderColor: colors.pillBg,
      color: colors.pillKey,
    }),
    group: css({
      borderRadius: theme.shape.radius.default,
      background: colors.groupBg,
      borderColor: colors.groupChipBorder,
    }),
    prefixed: css({
      display: 'inline-flex',
      alignItems: 'center',
    }),
    separator: css({
      color: theme.colors.text.secondary,
      padding: theme.spacing(0, 0.25),
    }),
    chipInvalid: css({
      background: theme.colors.error.transparent,
      borderColor: theme.colors.error.border,
      color: theme.colors.error.text,
    }),
    chipText: css({
      overflow: 'hidden',
      textOverflow: 'ellipsis',
    }),
    chipRemove: css({
      display: 'inline-flex',
      alignItems: 'center',
      marginLeft: 2,
      padding: 0,
      border: 'none',
      background: 'transparent',
      color: theme.colors.text.secondary,
      cursor: 'pointer',
      opacity: 0,
      '&:hover': { color: theme.colors.text.primary },
      '&:focus-visible': { opacity: 1 },
    }),
  };
};
