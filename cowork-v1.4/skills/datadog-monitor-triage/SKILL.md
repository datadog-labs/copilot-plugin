---
name: datadog-monitor-triage
description: |
  Triages Datadog monitors: what is alerting now, what is muted, what flapped
  recently, and what to look at first. Use when user asks "what's alerting",
  "show me firing monitors", "triage my Datadog alerts", "any monitors in warn",
  "what alerted overnight", or "monitor status for service X".
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Monitor triage

## Workflow
1. Pull monitors with `search_datadog_monitors`. Apply the user's scope (service,
   team tag, host, name text). Default scope: all monitors, up to 50.
2. Bucket by overall state: **Alert**, **Warn**, **No Data**, **OK**, and note muted
   monitors separately.
3. For every Alert/Warn/No Data monitor, get recent context with
   `search_datadog_events` filtered to that monitor (last 24 h): when it triggered,
   whether it recovered and re-triggered (flapping), and any linked deployment event.
4. Rank: Alert before Warn before No Data; within a bucket, priority P1 first, then
   the longest-running, then the most flaps.
5. If the user names a service, also run `search_datadog_incidents` to see whether an
   incident is already open for it.

## Output format
**Monitor triage - <scope>, <UTC time>**

Summary line: `X alerting - Y warn - Z no data - W ok (M muted)`

| # | Monitor | State | Priority | Since | Flaps (24 h) | Scope | Why it matters |
|---|---|---|---|---|---|---|---|
| 1 | API p95 latency | Alert | P1 | 08:12 UTC | 3 | service:api env:prod | Customer-facing |

**Recommended first look**: the top 1-3 items with one sentence each on what to check
(a linked dashboard from `search_datadog_dashboards` if one matches the service).

## Rules
- Report only monitors and events the tools returned; never infer an alert from a
  monitor's name.
- Muting or editing monitors is out of scope for this skill; if asked, say the
  connector is read-only.
