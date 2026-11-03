# Changelog

## 0.4.0

- A time range over 24 h is read a day at a time, one request after another, and the parts are joined into one
  graph. A request then never reads more than a day of a stream, so the panel's maximum time range can go to a week
  without raising the backend's memory use.
- The 30 s timeout applies to each request instead of the whole run.
- A grouped query capped to its top 200 groups ranks them over the last 24 h when the range is longer, so that every
  part keeps the same groups.

## 0.3.1

- The query text and `q` links read `sum:X_sum{…}` and `sum:X_count{…}` of a histogram or CloudWatch metric `X` as
  `sum:X{…}` and `count:X{…}`. Before, they failed with "Metric … does not exist", because the explorer shows those
  streams only as part of `X`.

## 0.3.0

- `Split by: Query` draws one graph per query and formula, stacked so that their time axes line up, each with its
  own y axis. A query without data keeps an empty graph.
- Applied functions follow the query in its row; they and Σ Modify move to the next line only when the row is full.

## 0.2.1

- In the `from` field, `OR …` typed after the chips joins the last chip, e.g. `(service:api OR service:worker)`,
  and `AND …` adds a chip; typing `O` or `A` there offers the operator. Before, the text failed with "Expected a
  filter before OR".
- The query text and `q` links accept `by {…}` after the modifiers too: `sum:m{*}.as_count() by {service}`.

## 0.2.0

- Boolean tag filters: combine terms with `AND`, `OR`, `NOT` and parentheses in the `from` field, the query text
  and `q` links, e.g. `{env:prod AND (service:api OR service:worker), !status:5*}`. `NOT` is pushed down to the
  matchers; an OR becomes one regex matcher when its branches differ only in the values of one key, else PromQL `or`
  of the metric reads before the space aggregation, for every metric kind. A filter may have at most 16 branches.
- The `from` field suggests tag values for the term at the cursor, also inside `(` and as the values of
  `key IN (`, and offers `AND`, `OR` and `)` after a complete term. A group is one chip; click it to edit its text.
- `mx` states of 0.1.0 load unchanged. In `q` links and the query text, values that contain parentheses or a
  separate word `AND` or `OR` must now be quoted.

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
