# Datadog MCP core tools (official reference, captured 2026-09-28)

Source: https://docs.datadoghq.com/mcp_server/tools/

| Tool | Access | Required Datadog permissions | What it does |
|---|---|---|---|
| `search_datadog_hosts` | read | Hosts Read, Timeseries | Lists and provides information about monitored hosts, supporting filtering and searching. |
| `search_datadog_metrics` | read | Metrics | Lists available metrics, with options for filtering and metadata. |
| `get_datadog_metric_context` | read | Metrics (or Cloud Cost Management Read) | Retrieves metric metadata, available tags and tag values for filtering and grouping. |
| `get_datadog_metric` | read | Metrics or Timeseries (or Cloud Cost Management Read) | Queries and analyzes historical or real-time metric data, supporting custom queries and aggregations. |
| `search_datadog_monitors` | read | Monitors Read | Retrieves monitors including statuses, thresholds and alert conditions. |
| `search_datadog_events` | read | Events, Timeseries | Searches events such as monitor alerts, deployments, infrastructure changes, security findings and service status changes. |
| `search_datadog_incidents` | read | Incidents Read | Lists incidents including state, severity and metadata. |
| `get_datadog_incident` | read | Incidents Read | Retrieves detailed information about an incident (timeline data not included). |
| `search_datadog_dashboards` | read | Dashboards Read, User Access Read | Lists available dashboards and key details; limited detail about contents. |
| `get_datadog_dashboard` | read | Dashboards Read, User Access Read | Retrieves a dashboard by ID with title, description, tags and widgets. |
| `search_datadog_logs` | read | Logs Read Data, Logs Read Index Data | Searches logs with filters (time, query, service, host, storage tier) and returns log details. |
| `analyze_datadog_logs` | read | Logs Read Data, Logs Read Index Data, Timeseries | Analyzes logs with SQL for counting, aggregation and numerical analysis. |
| `search_datadog_spans` | read | APM Read | Retrieves APM spans with filters such as service, time and resource. |
| `get_datadog_trace` | read | APM Read | Fetches a complete trace by trace ID; very large traces may be truncated. |
| `search_datadog_entities` | read | Service Catalog Read | Searches the Software Catalog for service identity, ownership and upstream/downstream dependencies. |
| `search_datadog_notebooks` | read | Notebooks Read | Lists and searches notebooks by author, tags and content. |
| `get_datadog_notebook` | read | Notebooks Read | Retrieves a notebook by ID including name, status and author. |
| `search_datadog_rum_events` | read | RUM Apps Read | Searches RUM events using advanced query syntax. |
| `aggregate_rum_events` | read | RUM Apps Read | Aggregates RUM events (counts, averages, percentiles) with grouping. |
| `create_datadog_notebook` | write | Notebooks Read, Notebooks Write | Creates a new notebook. |
| `edit_datadog_notebook` | write | Notebooks Read, Notebooks Write | Edits an existing notebook. |
| `upsert_datadog_dashboard` | write | Dashboards Read, Dashboards Write | Creates or updates a dashboard. |

## Optional toolsets (enabled per package via the `toolsets` URL parameter)

- **alerting**: `validate_datadog_monitor`, `get_datadog_monitor_templates`, `search_datadog_monitor_groups`, `search_datadog_slos`, `get_monitor_coverage`, `create_datadog_monitor`
- **llmobs**: Agent Observability spans and experiments (LLM/agent traces).
- **audit-trail**: `search_audit_events`, `list_audit_events`, `build_audit_trail_query`
- **error-tracking**: `search_datadog_error_tracking_issues`, `get_datadog_error_tracking_issue`, `analyze_datadog_error_tracking_errors`
- **ddsql**: `ddsql_get_spec`, `ddsql_schema_search_tables`, `ddsql_run_query`

## Sites

| Site | MCP endpoint | Confirmed |
|---|---|---|
| US1 (datadoghq.com) | https://mcp.datadoghq.com/v1/mcp | yes |
| US3 (us3.datadoghq.com) | https://mcp.us3.datadoghq.com/v1/mcp | yes |
| US5 (us5.datadoghq.com) | https://mcp.us5.datadoghq.com/v1/mcp | yes |
| EU1 (datadoghq.eu) | https://mcp.datadoghq.eu/v1/mcp | yes |
| AP1 (ap1.datadoghq.com) | https://mcp.ap1.datadoghq.com/v1/mcp | yes |
| AP2 (ap2.datadoghq.com) | https://mcp.ap2.datadoghq.com/v1/mcp | yes |
| UK1 (uk1.datadoghq.com) | https://mcp.uk1.datadoghq.com/v1/mcp | no - Derived from Datadog's 'prepend mcp. to your site' rule; not listed in the six documented commercial MCP endpoints. Verify before use. |
