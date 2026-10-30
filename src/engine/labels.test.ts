import { FieldType, MappingType } from '@grafana/data';

import { extremeIndices, labelField, labelFieldName, lastIndex } from './labels';

describe('label points', () => {
  it('max and min of the series', () => {
    expect(extremeIndices([3, 9, null, 1, 4])).toEqual([1, 3]);
  });

  it('first occurrence wins ties', () => {
    expect(extremeIndices([9, 1, 9, 1])).toEqual([0]);
    expect(extremeIndices([9, 5, 1, 9, 1])).toEqual([0, 2]);
  });

  it('skips the minimum when equal to or next to the maximum', () => {
    expect(extremeIndices([2, 2, 2])).toEqual([0]);
    expect(extremeIndices([1, 9, 5])).toEqual([1]);
    expect(extremeIndices([5, 9, 1])).toEqual([1]);
    expect(extremeIndices([7])).toEqual([0]);
  });

  it('nothing for empty or all-null series', () => {
    expect(extremeIndices([])).toEqual([]);
    expect(extremeIndices([null, null])).toEqual([]);
    expect(lastIndex([])).toEqual([]);
    expect(lastIndex([null])).toEqual([]);
  });

  it('last non-null point', () => {
    expect(lastIndex([1, 2, null, null])).toEqual([1]);
    expect(lastIndex([1, 2, 3])).toEqual([2]);
  });

  it('helper field: null except at the chosen points, drawn as points with values, hidden from legend and tooltip', () => {
    const field = labelField(2, [3, 9, null, 1, 4], [1, 3], '#3d8ef0', { unit: 'percent' });
    expect(field).toEqual({
      name: '__mx_label_2',
      type: FieldType.number,
      values: [null, 9, null, 1, null],
      config: {
        displayName: '__mx_label_2',
        color: { mode: 'fixed', fixedColor: '#3d8ef0' },
        unit: 'percent',
        custom: {
          drawStyle: 'points',
          pointSize: 6,
          showValues: true,
          showPoints: 'always',
          hideFrom: { legend: true, tooltip: true, viz: false },
          stacking: { mode: 'none' },
        },
      },
    });
    expect(labelFieldName(0)).toBe('__mx_label_0');
  });

  it('a text label maps the value to the series name', () => {
    const field = labelField(0, [3, 4.5, null], [1], '#000000', { text: 'host:a' });
    expect(field.values).toEqual([null, 4.5, null]);
    expect(field.config.mappings).toEqual([{ type: MappingType.ValueToText, options: { '4.5': { text: 'host:a' } } }]);
    expect(field.config.mappings![0].type).toBe('value');
    expect(field.config.unit).toBeUndefined();
  });
});
