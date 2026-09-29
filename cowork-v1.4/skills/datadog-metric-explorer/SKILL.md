---
name: datadog-metric-explorer
description: |
  Finds and queries Datadog metrics: discovers metric names and tags, then returns
  timeseries values, aggregations and comparisons. Use when user asks "what metrics do
  I have for X", "graph CPU for the last day", "what tags are on metric Y", "compare
  request rate this week vs last week", or "query metric Z".
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Metric explorer

## Workflow
1. Discover with `search_datadog_metrics` when the exact name is unknown (for example
   "redis", "system.cpu", "datadog.mcp"). Offer up to 10 candidates.
2. Inspect with `get_datadog_metric_context`: type (gauge/count/distribution), unit,
   available tags and tag values. Use this to build a correct query - counts use
   `.as_count()`, distributions use `count:` or percentiles.
3. Query with `get_datadog_metric`. Default window last 1 hour; use the user's
   grouping (`by {host}`, `by {service}`). For comparisons, run the two windows as two
   queries and compute the delta.
4. Summarize: latest value, min/avg/max over the window, and the top groups.

## Output format
**<metric>** (<type>, <unit>) - <window>, retrieved <UTC time>

| Group | Latest | Avg | Max | Trend |
|---|---|---|---|---|

Then 1-3 bullets on what stands out. Include the exact query string used so the user
can paste it into Datadog.

## Rules
- Never invent a metric name; if discovery returns nothing, say so and suggest the
  closest names returned.
- Report units exactly as returned by the metric context.
