import { MetricInfo } from '../model/types';

/** A time window in ms epoch. */
export type TimeWindow = { from: number; to: number };
export type TagPair = { key: string; value: string };

/** A search hit; `ranges` are [start, end) character ranges of the name to highlight. */
export interface MetricMatch {
  metric: MetricInfo;
  score: number;
  ranges: Array<[number, number]>;
}

/** A search hit over `key:value` text; `ranges` index into that text. */
export interface TagMatch {
  pair: TagPair;
  negated: boolean;
  score: number;
  ranges: Array<[number, number]>;
}

/** One entry of `/api/v1/metadata`. */
export interface MetadataEntry {
  type: string;
  unit: string;
  help: string;
}

export type Metadata = Record<string, MetadataEntry[] | undefined>;
