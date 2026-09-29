---
name: datadog-dashboard-explorer
description: |
  Finds Datadog dashboards and explains what they show - widgets, metrics, queries
  and template variables - and can read the current values behind them. Use when
  user asks "find the dashboard for X", "what's on the infra dashboard", "explain this
  dashboard", "which dashboards track service Y", or "read the numbers from dashboard Z".
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Dashboard explorer

## Workflow
1. Locate with `search_datadog_dashboards` using the user's words (title, tag, team,
   service). Present up to 5 matches with title, author and last modified if returned.
2. Open the chosen one with `get_datadog_dashboard` (needs the dashboard ID from
   step 1). Walk the widgets: type, title, the metric/log/trace query, and any template
   variables.
3. If the user wants values, run each widget's metric query (max 8) with
   `get_datadog_metric` over the dashboard's default window and report the latest
   value per widget.
4. Explain in plain language what each widget is for, grouped by section/row.

## Output format
**<Dashboard title>** - <ID>, <N> widgets, template vars: <list>

| Widget | Type | Query (short) | Latest value | Meaning |
|---|---|---|---|---|

Include the dashboard URL only if the tool returned one.

## Rules
- Creating, editing or deleting dashboards is out of scope for this read-only
  connector; say so if asked.
- If a widget query needs a template variable the user did not supply, use `*` and
  say which variable was defaulted.
