import { createDataFrame, DataFrame, FieldMatcherID, fieldMatchers, FieldType } from '@grafana/data';
import { SeriesVisibilityChangeMode } from '@grafana/ui';

import { chartSeries, nextVisibleSeries, visibilityOverrides } from './seriesVisibility';

const { ToggleSelection, AppendToSelection, SetExactly } = SeriesVisibilityChangeMode;

/** A series frame like the engine builds it, optionally with a label helper field. */
const frame = (name: string, helper?: string): DataFrame =>
  createDataFrame({
    fields: [
      { name: 'time', type: FieldType.time, values: [1, 2] },
      { name: 'value', type: FieldType.number, values: [1, 2], config: { displayName: name } },
      ...(helper
        ? [{ name: 'label', type: FieldType.number, values: [null, 2], config: { displayName: helper } }]
        : []),
    ],
  });

const frames = [frame('a', '__mx_label_0'), frame('b', '__mx_label_1'), frame('c')];
const all = ['a', 'b', 'c'];

describe('chartSeries', () => {
  it('lists series names without the label helpers and maps helpers to their series', () => {
    const { names, helpers } = chartSeries(frames);
    expect(names).toEqual(all);
    expect(helpers.get('a')).toEqual(['__mx_label_0']);
    expect(helpers.get('c')).toEqual([]);
  });
});

describe('nextVisibleSeries', () => {
  it('isolates the clicked series', () => {
    expect(nextVisibleSeries(null, 'b', ToggleSelection, all)).toEqual(['b']);
    expect(nextVisibleSeries(['a', 'c'], 'b', ToggleSelection, all)).toEqual(['b']);
  });

  it('shows everything again when the isolated series is clicked again', () => {
    expect(nextVisibleSeries(['b'], 'b', ToggleSelection, all)).toBeNull();
  });

  it('toggles one series with ctrl/cmd-click', () => {
    const hidden = nextVisibleSeries(null, 'b', AppendToSelection, all);
    expect(hidden).toEqual(['a', 'c']);
    expect(nextVisibleSeries(['b'], 'a', AppendToSelection, all)).toEqual(['b', 'a']);
    expect(nextVisibleSeries(hidden, 'b', AppendToSelection, all)).toBeNull();
  });

  it('sets an exact selection and clears it with null', () => {
    expect(nextVisibleSeries(null, ['a', 'c'], SetExactly, all)).toEqual(['a', 'c']);
    expect(nextVisibleSeries(['a'], ['c', 'b', 'a'], SetExactly, all)).toBeNull();
    expect(nextVisibleSeries(['a'], null, SetExactly, all)).toBeNull();
  });
});

describe('visibilityOverrides', () => {
  /** Field display names an override rule matches. */
  const matched = (rule: ReturnType<typeof visibilityOverrides>[number]) => {
    const matcher = fieldMatchers.get(rule.matcher.id).get(rule.matcher.options);
    return frames.flatMap((f) =>
      f.fields
        .filter((field) => field.type === FieldType.number && matcher(field, f, frames))
        .map((field) => field.config.displayName)
    );
  };

  it('adds nothing while every series is visible', () => {
    expect(visibilityOverrides(null, frames)).toEqual([]);
  });

  it('hides the other series from the chart and tooltip but keeps them in the legend', () => {
    const [hide, helpers] = visibilityOverrides(['a'], frames);
    expect(hide).toMatchObject({ __systemRef: 'hideSeriesFrom', matcher: { id: FieldMatcherID.byNames } });
    expect(hide.properties).toEqual([{ id: 'custom.hideFrom', value: { viz: true, legend: false, tooltip: true } }]);
    expect(matched(hide)).toEqual(['b', '__mx_label_1', 'c']);
    // Label helpers of hidden series stay out of the legend.
    expect(matched(helpers)).toEqual(['__mx_label_1']);
    expect(helpers.properties).toEqual([{ id: 'custom.hideFrom', value: { viz: true, legend: true, tooltip: true } }]);
  });

  it('needs no helper rule when the hidden series have no helpers', () => {
    const rules = visibilityOverrides(['a', 'b'], frames);
    expect(rules).toHaveLength(1);
    expect(matched(rules[0])).toEqual(['c']);
  });
});
