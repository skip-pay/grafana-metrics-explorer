---
name: metrics-explorer-links
description: Build links into the Grafana Metrics Explorer panel (skippay-metricsexplorer-panel). Use when you want to hand someone a clickable chart of Prometheus metrics (a rate, an error ratio, a top-N, a breakdown by tag, a comparison with yesterday) instead of raw PromQL, or when you write or fix the q/f query text of such a link.
---

# Metrics Explorer links

The Metrics Explorer is a Grafana panel that turns a short query text into PromQL and a chart. A link opens the
explorer dashboard with the query rows, formulas and display options already filled in, so the reader sees the chart
and can keep exploring from there.

## Base URL

Links go to the dashboard that holds the explorer panel: `<grafana>/d/<dashboard uid>`, for example
`https://grafana.example.com/d/metrics-explorer`. The demo and the shipped dashboard JSON use the uid
`metrics-explorer`. Take the Grafana address and uid from the user or the project's instructions; if neither gives
them, ask instead of guessing a hostname.

## Parameters

| Parameter    | Value                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`          | one query row in the query text form below. Repeat it for more rows; rows get letters `a`, `b`, `c`… in order                                 |
| `f`          | a formula over the letters, e.g. `a/b*100`. Repeatable. With at least one valid `f`, the `q` rows are hidden and the chart shows the formulas |
| `viz`        | `timeseries` (default), `queryvalue`, `table`, `heatmap`, `distribution`, `toplist`, `barchart`, `piechart`                                   |
| `display`    | `lines` (default), `bars`, `areas`; timeseries only                                                                                           |
| `split`      | a tag key: one graph per value of that tag (top 24 values); timeseries only                                                                   |
| `from`, `to` | Grafana's time range: relative (`now-6h`, `now`) or epoch milliseconds                                                                        |

- The time range may not exceed the panel's maximum, 24 hours unless the dashboard sets another; a longer range is
  refused and nothing is queried.
- `mx` (the full JSON state) wins over everything else. Never combine `mx` with `q`/`f`; build links from the
  readable parameters only.
- After loading, the explorer rewrites the URL in place to carry `mx`. That is expected.
- Parameters that fail to parse are named in a warning banner; the rest is still shown.

## Query text

```text
query      = function "(" query { "," argument } ")"
           | [ aggregator ":" ] metric "{" scope "}" [ "by" "{" key { "," key } "}" ] { modifier }
aggregator = avg | sum | min | max | count | p50 | p75 | p90 | p95 | p99
scope      = "*" | or
or         = and { "OR" and }
and        = unary { ( "AND" | "," ) unary }
unary      = "NOT" unary | "(" or ")" | filter
filter     = key ":" value               equals; value may contain * wildcards; key:* means "has the tag"
           | "!" key ":" value           differs; on Prometheus also series without the tag
           | key "IN" "(" value { "," value } ")"
           | key "NOT IN" "(" value { "," value } ")"
modifier   = ".as_count()" | ".as_rate()" | ".rollup(" [ rollup_agg "," ] seconds ")" | ".fill(" method [ "," limit ] ")"
```

- **Metric**: letters, digits, `_` and `.`; it must start with a letter or `_`. Dots and underscores are
  interchangeable when the metric is known (`http.requests.total` finds `http_requests_total`). Names that contain
  `:` (recording rules such as `job:http_requests:rate5m`) cannot be written in this form.
- **Braces are required**: write `avg:node_load1{*}`, never `avg:node_load1`.
- **Aggregator**: optional; without it counters use `sum` and gauges `avg`. `p50`…`p99` work only on histograms
  (`<m>_bucket` families). There and on CloudWatch metrics `count` counts observations; elsewhere it counts series,
  and `.as_count()` / `.as_rate()` do not change it. An aggregator a metric does not support skips the row with a
  message.
- **Filters**: separate with commas or combine with `AND`, `OR`, `NOT` and parentheses, in uppercase. `NOT` binds
  tighter than `AND`, and `AND` (a comma is `AND`) tighter than `OR`, so put an OR in parentheses:
  `{env:prod, (service:api OR service:worker)}`. Within one AND list, filters on the same key are ORed and
  different keys ANDed. Double-quote values that contain `,`, `{`, `}`, `(`, `)`, `"`, `\` or a separate word `AND`
  or `OR`: `path:"/a,b"`. `!key:*`, `NOT key:*` and template variables (`$var`) are not supported, and a filter may
  expand to at most 16 OR branches.
- **Tag keys** (in filters, `by {…}` and `split`): letters, digits and `_`, starting with a letter or `_`.
- **Counters**: `.as_count()` (events per interval, the default) or `.as_rate()` (events per second).
- **Rollup**: `rollup_agg` is `avg`, `count`, `max`, `min` or `sum`; `seconds` 0 means automatic. `.rollup(60)`
  sets only the interval.
- **Fill**: `method` is `null`, `zero`, `linear` or `last`; `limit` in seconds (default 300).

### Wrapping functions

Every function that is not a dotted modifier wraps the query; the first argument is the query, the rest are
literals. Nest them innermost first: `abs(diff(avg:m{*}))`. Quote string arguments (`'mean'`).

| Category          | Functions                                                                                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arithmetic        | `abs`, `log2`, `log10`, `cumsum`, `integral`, `ceil`, `floor`, `round(q, decimals)`                                                                                          |
| Boolean remapping | `is_greater(q, threshold)`, `is_less(q, threshold)`, `is_between(q, lower, upper)`                                                                                           |
| Interpolation     | `default_zero`                                                                                                                                                               |
| Timeshift         | `timeshift(q, seconds)` (negative = earlier), `hour_before`, `day_before`, `week_before`, `month_before` (28 days)                                                           |
| Rate              | `per_second`, `per_minute`, `per_hour`, `diff`, `monotonic_diff`, `derivative`, `throughput`                                                                                 |
| Smoothing         | `ewma_3`, `ewma_5`, `ewma_10`, `ewma_20`, `median_3`, `median_5`, `median_7`, `median_9`, `rollingavg_5`, `rollingavg_13`, `rollingavg_21`, `rollingavg_29`                  |
| Rollup            | `moving_rollup(q, seconds, 'avg'\|'sum'\|'min'\|'max'\|'median')`                                                                                                            |
| Rank              | `top(q, n, by, dir)`, `bottom(q, n, by, dir)`: `n` 5, 10, 25, 50 or 100; `by` `'mean'`, `'max'`, `'min'`, `'sum'`, `'last'`, `'l2norm'`, `'area'`; `dir` `'desc'` or `'asc'` |
| Count             | `count_nonzero`, `count_not_null`                                                                                                                                            |
| Regression        | `trend_line`                                                                                                                                                                 |
| Exclusion         | `exclude_null`, `cutoff_min(q, threshold)`, `cutoff_max(q, threshold)`, `clamp_min(q, threshold)`, `clamp_max(q, threshold)`                                                 |

Functions without arguments are still called with the query: `per_second(sum:m{*})`. Missing trailing arguments take
their defaults (`top(q)` is `top(q, 5, 'mean', 'desc')`).

### Formulas (`f`)

`+`, `-`, `*`, `/`, parentheses, numbers and the letters of the `q` rows. The wrapping functions above take a series
expression as their first argument (`top(a, 10, 'mean', 'desc')`, here with any `n`), and `minimum(x, y)`,
`maximum(x, y)`, `pow(x, y)` and `time()` exist only in formulas. Series are matched by their common group tags, so
group both sides by the same keys. String arguments must be quoted.

## URL encoding

Encode every value with `encodeURIComponent` (JavaScript) or `urllib.parse.urlencode` (Python); never paste raw
query text into a URL.

- `+` must become `%2B`: Grafana reads a bare `+` as a space, so `f=a+b` arrives as `a b`.
- `&`, `#`, `%` and spaces must be encoded; `{` `}` become `%7B` `%7D`.
- `!`, `'`, `(`, `)` and `*` may stay as they are.

```python
from urllib.parse import urlencode

params = [
    ("q", "sum:http_requests_total{status:5*} by {service}.as_count()"),
    ("q", "sum:http_requests_total{*} by {service}.as_count()"),
    ("f", "a/b*100"),
    ("from", "now-6h"),
    ("to", "now"),
]
url = "https://grafana.example.com/d/metrics-explorer?" + urlencode(params)
```

```js
const params = new URLSearchParams();
params.append('q', 'avg:node_load1{*} by {instance}');
params.append('from', 'now-1h');
params.append('to', 'now');
const url = `https://grafana.example.com/d/metrics-explorer?${params}`;
```

Both encode spaces as `+`, which Grafana reads back as spaces, and a literal `+` as `%2B`.

## Worked examples

Unencoded for reading; encode them as above before use.

**Error rate in percent per service** (two hidden rows and a formula):

```text
/d/metrics-explorer?q=sum:http_requests_total{status:5*} by {service}.as_count()&q=sum:http_requests_total{*} by {service}.as_count()&f=a/b*100&from=now-6h&to=now
```

Encoded as `URLSearchParams` writes it:
`/d/metrics-explorer?q=sum%3Ahttp_requests_total%7Bstatus%3A5*%7D+by+%7Bservice%7D.as_count%28%29&q=sum%3Ahttp_requests_total%7B*%7D+by+%7Bservice%7D.as_count%28%29&f=a%2Fb*100&from=now-6h&to=now`

**Top 5 CPUs by idle time**:

```text
/d/metrics-explorer?q=top(avg:node_cpu_seconds_total{mode:idle} by {cpu}, 5, 'mean', 'desc')
```

**Busiest services as a top list** (the top list ranks the groups itself, 10 by default):

```text
/d/metrics-explorer?q=sum:http_requests_total{env:prod} by {service}.as_rate()&viz=toplist&from=now-1h&to=now
```

**One graph per service, status codes as bars**:

```text
/d/metrics-explorer?q=sum:http_requests_total{*} by {status}.as_count()&split=service&display=bars
```

**p95 latency against the same time yesterday**:

```text
/d/metrics-explorer?q=p95:http_request_duration_seconds{service:api}&q=day_before(p95:http_request_duration_seconds{service:api})
```

**Excluding values**:

```text
/d/metrics-explorer?q=sum:http_requests_total{env:prod,!status:5*,method IN (GET,HEAD)} by {route}.as_rate()
```

**Either of two conditions** (one service, or one route of any service):

```text
/d/metrics-explorer?q=sum:http_requests_total{env:prod AND (service:api OR route:/checkout)} by {status}.as_count()
```

## Pitfalls

- Use metric and tag names you have actually seen (in the user's message, an alert, a dashboard or the Prometheus
  API). A wrong tag key gives an empty chart, not an error.
- Letters follow the position of `q` even when one fails to parse, so a formula that uses the failed row's letter is
  rejected too. Check every `q` against the grammar.
- A formula can only use letters of `q` rows in the same link.
- `top`/`bottom` in a `q` accept only `n` of 5, 10, 25, 50 or 100; other counts are allowed only in formulas.
- `split` and `display` affect only the timeseries visualization. The split key is added to the grouping
  automatically.
- Keep ranges within 24 hours. For a longer question, link a window around the event (absolute `from`/`to` in epoch
  milliseconds) rather than a week.
- A grouped query with more than about 200 groups is cut to the 200 highest; filter or group by fewer keys for a
  readable chart.
