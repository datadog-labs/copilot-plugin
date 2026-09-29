---
name: datadog-service-trace
description: |
  Investigates a service in Datadog APM: ownership and dependencies from the Software
  Catalog, error and slow spans, and a full trace when the user has a trace ID. Use when
  user asks "why is service X slow", "show me errors in the checkout service", "who
  owns service Y", "what does service Z depend on", or "look up trace <id>".
license: MIT
metadata:
  author: Daryl Yourk
  version: "1.4"
---

# Service and trace investigation

## Workflow
1. Identify the service with `search_datadog_entities`: owner/team, tier, upstream and
   downstream dependencies, links.
2. Find problem spans with `search_datadog_spans` (default last 1 hour):
   first `status:error`, then the slowest spans (`@duration` descending), max 20 each.
   Group by resource (endpoint/query) and note the share of errors per resource.
3. If a trace ID is given or a span stands out, fetch it with `get_datadog_trace` and
   walk the critical path: the top 3 spans by self time and the first error span.
4. Check `search_datadog_monitors` for APM monitors on the service and
   `search_datadog_events` for deployments in the window.

## Output format
**<service>** - owner <team>, env <env>, window <window>, retrieved <UTC time>

- **Dependencies**: upstream -> this service -> downstream (from the catalog)
- **Errors**: N error spans; top resources table (resource, errors, share, example error)
- **Latency**: slowest resources table (resource, p50/p95 if computable, sample duration)
- **Trace <id>** (if any): critical path bullets
- **Changes**: deployments/events in window or "none returned"

## Rules
- Large traces may be truncated by the tool; say when they are.
- No APM data is a finding ("service not instrumented or no traffic"), not an error.
