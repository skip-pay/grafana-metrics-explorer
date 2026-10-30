# Changelog

## 0.1.0

Initial release.

- Query rows with metric autocomplete and preview, tag filters (`from`), space aggregation and grouping (`by`).
- Function menu (Σ Modify) with arithmetic, boolean remapping, interpolation, timeshift, rate, smoothing, rollup,
  rank, count, regression and exclusion functions, plus a raw text mode per query.
- Formulas over query letters, with aliases and hidden rows.
- Timeseries (lines, bars, areas), query value, table, heatmap, distribution, top list, bar chart and pie chart.
- Display options: labels on the line, line style and stroke, eleven palettes, ordering, per-query colours.
- Split by a tag into one graph per value.
- State in the URL (`mx`) and readable deep links (`q`, `f`, `viz`, `display`, `split`).
- Delta and cumulative counters, histograms and CloudWatch metric streams; step aligned with the detected export
  cadence; safety limits on time range and series.
