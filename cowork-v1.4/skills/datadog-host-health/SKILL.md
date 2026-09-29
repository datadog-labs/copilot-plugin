---
name: datadog-host-health
description: |
  Reports the live health of one or more Datadog-monitored hosts: status, last report
  time, CPU, memory, disk, load, and any alerting monitors. Use when user asks "how is
  host X doing", "is HP11D healthy", "show me my hosts", "which hosts are down",
  "CPU and memory for my servers", or "host status in Datadog".
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Host health

## Workflow
1. Resolve the hosts with `search_datadog_hosts`. Filter by the host name, tag
   (`env:prod`, `role:database`) or cloud provider the user gave. If nothing is
   given, take the most recently reporting hosts (max 10) and say so.
2. For each host (max 10), read the last 1 hour with `get_datadog_metric`:
   - CPU: `avg:system.cpu.user{host:<name>} + avg:system.cpu.system{host:<name>}`
   - Memory used %: `100 - avg:system.mem.pct_usable{host:<name>}*100`
   - Disk used %: `avg:system.disk.in_use{host:<name>}*100`
   - Load: `avg:system.load.1{host:<name>}`
   If a metric is absent for a host (for example Windows hosts report memory but
   not load in the same way), report "n/a", do not substitute.
3. Check `search_datadog_monitors` for monitors scoped to those hosts and note any in
   Alert or Warn state.
4. Flag anything notable: host not reporting for > 5 minutes, CPU > 80%, memory > 85%,
   disk > 85%, any alerting monitor, clock/NTP offset if returned in host metadata.

## Output format
**Host health - <N> hosts, <time window>, retrieved <UTC time>**

| Host | Status | Last report | CPU % | Mem % | Disk % | Load | Alerting monitors |
|---|---|---|---|---|---|---|---|
| HP11D | Up | 10:14 UTC | 4.2 | 46.9 | 61.0 | n/a | 0 |

Then **Notes**: 2-5 bullets with the flags from step 4 and the host tags that matter
(OS, cloud provider, agent version) when they were returned.

## Rules
- Only numbers that came back from a tool. If a query returns no points, say so.
- Always state the time window and the retrieval time; a fresh call can carry stale
  data if the agent stopped reporting.
- Do not recommend installing or reconfiguring the Datadog Agent unless the host is
  actually missing or stale in the results.
