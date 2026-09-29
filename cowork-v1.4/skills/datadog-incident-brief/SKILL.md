---
name: datadog-incident-brief
description: |
  Produces a stakeholder-ready brief for Datadog incidents: what is open, severity,
  customer impact, commander, current state, and a timeline from events. Use when
  user asks "what incidents are open", "brief me on incident X", "write an incident
  summary for leadership", "status of the outage", or "incidents this week".
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Incident brief

## Workflow
1. List incidents with `search_datadog_incidents`. Default: active incidents; if the
   user asks about a period, include resolved incidents in that window.
2. For each incident the user cares about (max 5), call `get_datadog_incident` for
   title, severity, state, commander, customer impact, detection and resolution times.
3. Build a timeline from `search_datadog_events` over the incident window scoped to the
   affected services (the incident tool does not return timeline data).
4. Pull supporting signal only when it sharpens the brief: alerting monitors via
   `search_datadog_monitors`, error volume via `analyze_datadog_logs`.
5. Write the brief in plain language for a non-engineering reader.

## Output format
**Incident brief - <UTC time>**

For each incident:
### <SEV> - <title> (<state>)
- **Impact**: customer-facing? scope? duration so far
- **Owner**: commander, responders
- **Timeline**: 3-6 timestamped bullets (detected, escalated, mitigated, resolved)
- **Current status**: one sentence
- **Next update / open questions**

Close with a one-paragraph executive summary across all incidents.

## Rules
- Use only fields returned by the incident and event tools; mark unknowns as
  "not recorded in Datadog".
- Never speculate on root cause unless the incident record states it.
