import React, { useEffect, useMemo, useRef, useState } from 'react';
import { css, cx } from '@emotion/css';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, useStyles2 } from '@grafana/ui';

import { CATEGORY_ORDER, FunctionDef, FUNCTIONS, QUICK_PICKS } from '../../compile';
import { Popover } from './Popover';
import { getEditorColors, getEditorStyles } from './styles';

export interface ModifyMenuProps {
  onAdd: (name: string) => void;
}

const WIDTH = 680;
/** Counter modifiers live in the row's `as count|rate` segment, not in this menu. */
const NOT_IN_MENU = new Set(['as_count', 'as_rate']);

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  Arithmetic: 'Apply mathematical functions to the query.',
  'Boolean remapping': 'Remap the values to 1 or 0 by comparing them with thresholds.',
  Interpolation: 'Fill gaps or change how missing points are drawn.',
  Timeshift: 'Compare a metric with an earlier time period.',
  Rate: 'Graph how fast the metric changes.',
  Smoothing: 'Smooth the metric with a moving average or median.',
  Rollup: 'Aggregate each series over a time interval.',
  Rank: 'Keep only the top or bottom N series.',
  Count: 'Count the non-zero or non-null series.',
  Regression: 'Fit a line through the metric.',
  Exclusion: 'Exclude or clamp values.',
};

type Item = { kind: 'function'; def: FunctionDef } | { kind: 'all' };
type View = 'quick' | 'all';

/** The "Σ Modify" button: quick picks first, "View all N functions" opens the categories; typing searches. */
export const ModifyMenu = ({ onAdd }: ModifyMenuProps) => {
  const styles = useStyles2(getEditorStyles);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={styles.segmentButton}
        aria-label="Modify"
        aria-expanded={open}
        title="Modify query"
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden>Σ&nbsp;</span>Modify
      </button>
      <Popover anchor={anchor} open={open} width={WIDTH} maxHeight={440} onClose={() => setOpen(false)}>
        <ModifyPanel
          onAdd={(name) => {
            setOpen(false);
            onAdd(name);
            anchor?.focus();
          }}
          onClose={() => {
            setOpen(false);
            anchor?.focus();
          }}
        />
      </Popover>
    </>
  );
};

interface PanelProps extends ModifyMenuProps {
  onClose: () => void;
}

const ModifyPanel = ({ onAdd, onClose }: PanelProps) => {
  const styles = useStyles2(getStyles);
  const functions = useMemo(() => FUNCTIONS.filter((f) => !f.formulaOnly && !NOT_IN_MENU.has(f.name)), []);
  const categories = useMemo(() => groupByCategory(functions), [functions]);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('quick');
  const [active, setActive] = useState(0);
  const [category, setCategory] = useState(categories[0]?.[0] ?? '');
  // In the full view: -1 while the category column has the keyboard, else the function index.
  const [fnIndex, setFnIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  // `autoFocus` would fire while the popover is still hidden for placement; passive effects run after it is shown.
  useEffect(() => inputRef.current?.focus(), []);

  const searching = search.trim() !== '';
  const flat: Item[] = searching
    ? searchFunctions(search, functions).map((def) => ({ kind: 'function', def }))
    : [
        ...QUICK_PICKS.map((name) => functions.find((f) => f.name === name))
          .filter((def): def is FunctionDef => def !== undefined)
          .map((def): Item => ({ kind: 'function', def })),
        { kind: 'all' },
      ];
  const showFlat = searching || view === 'quick';
  const categoryFns = categories.find(([c]) => c === category)?.[1] ?? [];
  const activeItem = flat[Math.min(active, flat.length - 1)];
  const preview: FunctionDef | string | undefined = showFlat
    ? activeItem?.kind === 'function'
      ? activeItem.def
      : undefined
    : (categoryFns[fnIndex] ?? category);

  const choose = (item: Item | undefined) => {
    if (item?.kind === 'function') {
      onAdd(item.def.name);
    } else if (item?.kind === 'all') {
      setView('all');
      setFnIndex(-1);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (showFlat) {
      if (step !== 0 && flat.length > 0) {
        e.preventDefault();
        setActive((Math.min(active, flat.length - 1) + step + flat.length) % flat.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(activeItem);
      }
    } else if (step !== 0) {
      e.preventDefault();
      if (fnIndex < 0) {
        const i = categories.findIndex(([c]) => c === category);
        setCategory(categories[(i + step + categories.length) % categories.length][0]);
      } else if (categoryFns.length > 0) {
        setFnIndex((fnIndex + step + categoryFns.length) % categoryFns.length);
      }
    } else if (e.key === 'ArrowRight' && fnIndex < 0 && categoryFns.length > 0) {
      e.preventDefault();
      setFnIndex(0);
    } else if (e.key === 'ArrowLeft' && search === '') {
      e.preventDefault();
      if (fnIndex >= 0) {
        setFnIndex(-1);
      } else {
        setView('quick');
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (categoryFns[fnIndex]) {
        onAdd(categoryFns[fnIndex].name);
      }
    }
  };

  return (
    <div className={styles.panel} data-testid="modify-menu">
      <div className={styles.search}>
        <Icon name="search" className={styles.muted} />
        <input
          ref={inputRef}
          className={styles.searchInput}
          placeholder="Search functions"
          aria-label="Search functions"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        {search && (
          <button type="button" className={styles.clear} aria-label="Clear search" onClick={() => setSearch('')}>
            <Icon name="times" />
          </button>
        )}
      </div>
      <div className={styles.body}>
        {showFlat ? (
          <div className={cx(styles.column, styles.wide)} role="menu" aria-label="Functions">
            {!searching && (
              <div className={styles.section}>
                <span aria-hidden>Σ</span> Functions
              </div>
            )}
            {flat.map((item, i) =>
              item.kind === 'function' ? (
                <Row
                  key={item.def.name}
                  active={i === active}
                  onHover={() => setActive(i)}
                  onClick={() => choose(item)}
                  label={item.def.label}
                  detail={searching ? item.def.category : undefined}
                />
              ) : (
                <Row
                  key="all"
                  active={i === active}
                  onHover={() => setActive(i)}
                  onClick={() => choose(item)}
                  label={`View all ${functions.length} functions`}
                  link
                  icon="arrow-right"
                />
              )
            )}
            {searching && flat.length === 0 && <div className={styles.empty}>No matching functions</div>}
          </div>
        ) : (
          <>
            <div className={styles.column} role="menu" aria-label="Categories">
              <Row label="Back" icon="angle-left" iconFirst onClick={() => setView('quick')} />
              {categories.map(([name]) => (
                <Row
                  key={name}
                  label={name}
                  icon="angle-right"
                  active={name === category && fnIndex < 0}
                  current={name === category}
                  onHover={() => {
                    setCategory(name);
                    setFnIndex(-1);
                  }}
                  onClick={() => setFnIndex(-1)}
                />
              ))}
            </div>
            <div className={styles.column} role="menu" aria-label={category}>
              {categoryFns.map((def, i) => (
                <Row
                  key={def.name}
                  label={def.label}
                  active={i === fnIndex}
                  onHover={() => setFnIndex(i)}
                  onClick={() => onAdd(def.name)}
                />
              ))}
            </div>
          </>
        )}
        <div className={styles.preview}>
          <Preview item={preview} />
        </div>
      </div>
    </div>
  );
};

interface RowProps {
  label: string;
  detail?: string;
  active?: boolean;
  /** The open category while a function has the keyboard. */
  current?: boolean;
  link?: boolean;
  icon?: 'arrow-right' | 'angle-right' | 'angle-left';
  iconFirst?: boolean;
  onHover?: () => void;
  onClick: () => void;
}

const Row = ({ label, detail, active, current, link, icon, iconFirst, onHover, onClick }: RowProps) => {
  const styles = useStyles2(getStyles);
  return (
    <div
      role="menuitem"
      tabIndex={-1}
      className={cx(styles.row, link && styles.link, current && styles.current, active && styles.active)}
      onMouseEnter={onHover}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {icon && iconFirst && <Icon name={icon} />}
      <span className={styles.rowLabel}>{label}</span>
      {detail && <span className={styles.detail}>{detail}</span>}
      {icon && !iconFirst && <Icon name={icon} />}
    </div>
  );
};

/** Description and parameters of a function, or the description of a category. */
const Preview = ({ item }: { item: FunctionDef | string | undefined }) => {
  const styles = useStyles2(getStyles);
  if (item === undefined) {
    return <div className={styles.muted}>Pick a function to modify the query.</div>;
  }
  if (typeof item === 'string') {
    return (
      <>
        <div className={styles.previewTitle}>{item}</div>
        <div>{CATEGORY_DESCRIPTIONS[item] ?? ''}</div>
      </>
    );
  }
  return (
    <>
      <div className={styles.previewTitle}>{item.name}</div>
      <div>{item.description}</div>
      {item.params.length > 0 && (
        <div className={styles.params}>
          {item.params.map((p) => (
            <React.Fragment key={p.name}>
              <span className={styles.paramName}>{p.name}:</span>
              <span>
                {p.kind === 'enum' && p.options ? `one of ${p.options.join(', ')}` : p.kind}
                {` (default ${p.default})`}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}
    </>
  );
};

/** Functions grouped by category, in CATEGORY_ORDER; unknown categories follow. */
function groupByCategory(functions: FunctionDef[]): Array<[string, FunctionDef[]]> {
  const groups = new Map<string, FunctionDef[]>(CATEGORY_ORDER.map((c) => [c, []]));
  for (const f of functions) {
    const list = groups.get(f.category);
    if (list) {
      list.push(f);
    } else {
      groups.set(f.category, [f]);
    }
  }
  return [...groups.entries()].filter(([, list]) => list.length > 0);
}

/** Name or label prefix first, then name/label substring, then category or description substring. */
function searchFunctions(search: string, functions: FunctionDef[]): FunctionDef[] {
  const query = search.trim().toLowerCase();
  const tier = (f: FunctionDef) => {
    const name = f.name.toLowerCase();
    const label = f.label.toLowerCase();
    if (name.startsWith(query) || label.startsWith(query)) {
      return 0;
    }
    if (name.includes(query) || label.includes(query)) {
      return 1;
    }
    if (f.category.toLowerCase().includes(query) || f.description.toLowerCase().includes(query)) {
      return 2;
    }
    return -1;
  };
  return functions
    .map((f, index) => ({ f, index, tier: tier(f) }))
    .filter((x) => x.tier >= 0)
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((x) => x.f);
}

const getStyles = (theme: GrafanaTheme2) => {
  const colors = getEditorColors(theme);
  return {
    panel: css({
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      maxHeight: 440,
    }),
    search: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      padding: theme.spacing(0, 1.5),
      height: 36,
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      background: colors.pillBg,
    }),
    searchInput: css({
      flex: '1 1 auto',
      minWidth: 0,
      height: '100%',
      border: 'none',
      outline: 'none',
      background: 'transparent',
      color: theme.colors.text.primary,
      font: 'inherit',
      '&::placeholder': { color: theme.colors.text.secondary, opacity: 1 },
    }),
    clear: css({
      display: 'inline-flex',
      border: 'none',
      background: 'transparent',
      color: theme.colors.text.secondary,
      cursor: 'pointer',
    }),
    body: css({
      display: 'flex',
      minHeight: 0,
      flex: '1 1 auto',
    }),
    column: css({
      flex: '0 0 200px',
      minWidth: 0,
      overflowY: 'auto',
      borderRight: `1px solid ${theme.colors.border.weak}`,
    }),
    wide: css({
      flex: '0 0 340px',
    }),
    section: css({
      padding: theme.spacing(1, 1.5),
      borderBottom: `1px solid ${theme.colors.border.weak}`,
      fontWeight: theme.typography.fontWeightBold,
    }),
    row: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      minHeight: 34,
      padding: theme.spacing(0.5, 1.5),
      cursor: 'pointer',
      color: theme.colors.text.primary,
    }),
    rowLabel: css({
      flex: '1 1 auto',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    detail: css({
      color: theme.colors.text.secondary,
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    link: css({
      color: theme.colors.text.link,
      borderTop: `1px solid ${theme.colors.border.weak}`,
    }),
    current: css({
      background: theme.colors.action.selected,
    }),
    active: css({
      background: colors.active,
      color: colors.activeText,
      '& *': { color: colors.activeText },
    }),
    preview: css({
      flex: '1 1 auto',
      minWidth: 0,
      overflowY: 'auto',
      padding: theme.spacing(1.5),
      display: 'flex',
      flexDirection: 'column',
      gap: theme.spacing(1),
      fontSize: theme.typography.bodySmall.fontSize,
    }),
    previewTitle: css({
      fontSize: theme.typography.body.fontSize,
      fontWeight: theme.typography.fontWeightBold,
    }),
    params: css({
      display: 'grid',
      gridTemplateColumns: 'max-content 1fr',
      columnGap: theme.spacing(1),
      rowGap: theme.spacing(0.25),
    }),
    paramName: css({
      fontWeight: theme.typography.fontWeightBold,
    }),
    muted: css({
      color: theme.colors.text.secondary,
    }),
    empty: css({
      padding: theme.spacing(1.5),
      color: theme.colors.text.secondary,
    }),
  };
};
