import { tagValues } from './series';

/** What naming needs to know about the row a series comes from. */
export interface RowNaming {
  /** Group keys of the row's series, in naming order. */
  keys: string[];
  /** Name of an ungrouped series: alias, else the query text form or the formula expression. */
  ungroupedName: string;
  /** Prefix of a grouped series: alias, else the query letter or the formula expression. */
  label: string;
  aliased: boolean;
}

/**
 * Legend name of a series. Ungrouped: the row's name. Grouped: the tag values (`prod, checkout`), prefixed
 * `<label> · ` when several rows share the chart or the row has an alias. `exclude` drops the split key, which
 * the tile title shows.
 */
export function seriesName(
  row: RowNaming,
  labels: Record<string, string>,
  opts: { prefix?: boolean; exclude?: string } = {}
): string {
  const keys = row.keys.filter((k) => k !== opts.exclude);
  if (keys.length === 0) {
    return row.ungroupedName;
  }
  const values = tagValues(labels, keys);
  return opts.prefix || row.aliased ? `${row.label} · ${values}` : values;
}

/** True when the series is named by its tags rather than by the row. */
export function isGrouped(row: RowNaming, exclude?: string): boolean {
  return row.keys.some((k) => k !== exclude);
}
