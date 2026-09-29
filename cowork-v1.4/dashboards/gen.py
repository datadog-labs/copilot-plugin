import json, pathlib
out = pathlib.Path('.')

def ts(title, queries, unit=None, display="line", note=None):
    reqs=[{"q":q,"display_type":display,"style":{"palette":"dog_classic","line_type":"solid","line_width":"normal"}} for q in queries]
    d={"title":title,"type":"timeseries","requests":reqs,"show_legend":True,"legend_layout":"auto"}
    if unit: d["custom_links"]=[]
    return {"definition":d}
def qv(title,q,precision=0,unit=None,autoscale=True):
    r={"q":q,"aggregator":"last"}
    d={"title":title,"type":"query_value","requests":[r],"autoscale":autoscale,"precision":precision}
    if unit: d["custom_unit"]=unit
    return {"definition":d}
def top(title,q):
    return {"definition":{"title":title,"type":"toplist","requests":[{"q":q}]}}
def note(text,bg="gray"):
    return {"definition":{"type":"note","content":text,"background_color":bg,"font_size":"14","text_align":"left","show_tick":False}}
def group(title,widgets,bg="vivid_blue"):
    return {"definition":{"title":title,"type":"group","layout_type":"ordered","background_color":bg,"widgets":widgets}}
def events(title,query):
    return {"definition":{"title":title,"type":"event_stream","query":query,"event_size":"s","tags_execution":"and"}}
def event_ts(title,query):
    return {"definition":{"title":title,"type":"event_timeseries","query":query,"tags_execution":"and"}}
def logs(title,query,cols=("host","service","status")):
    return {"definition":{"title":title,"type":"log_stream","query":query,"columns":list(cols),"show_date_column":True,"show_message_column":True,"message_display":"inline","sort":{"column":"time","order":"desc"}}}
def hostmap(title,q,filt):
    return {"definition":{"title":title,"type":"hostmap","requests":{"fill":{"q":q}},"node_type":"host","no_metric_hosts":True,"no_group_hosts":True,"scope":filt}}
def dash(title,desc,widgets,tvars=()):
    return {"title":title,"description":desc,"layout_type":"ordered","widgets":widgets,
            "template_variables":[{"name":n,"prefix":p,"available_values":[],"default":"*"} for n,p in tvars],
            "notify_list":[],"reflow_type":"auto","tags":["team:darbotlabs","managed-by:cowork-plugin"]}

# 1 AI Copilot adoption ---------------------------------------------------------
gc="github_copilot.usage.organizations"
d1=dash("Darbotlabs - AI Copilot Adoption (GitHub Copilot + Microsoft 365 Copilot)",
 "Real adoption data from the GitHub Copilot and Microsoft Copilot integrations. GitHub Copilot metrics arrive daily from GitHub's Copilot Usage API; Microsoft Copilot usage reports are delayed up to 72 hours by Microsoft.",
 [group("GitHub Copilot - engagement",[
    qv("Daily active users",f"sum:{gc}.daily_active_users{{$org}}"),
    qv("Weekly active users",f"sum:{gc}.weekly_active_users{{$org}}"),
    qv("Monthly active users (28d)",f"sum:{gc}.monthly_active_users{{$org}}"),
    qv("Monthly active agent-mode users",f"sum:{gc}.monthly_active_agent_users{{$org}}"),
    ts("Active users trend",[f"sum:{gc}.daily_active_users{{$org}}",f"sum:{gc}.weekly_active_users{{$org}}",f"sum:{gc}.monthly_active_users{{$org}}"]),
    ts("Prompts vs generations vs acceptances (daily)",[f"sum:{gc}.user_initiated_interaction_count{{$org}}.as_count()",f"sum:{gc}.code_generation_activity_count{{$org}}.as_count()",f"sum:{gc}.code_acceptance_activity_count{{$org}}.as_count()"],display="bars"),
  ]),
  group("GitHub Copilot - code impact",[
    ts("Lines suggested vs added",[f"sum:{gc}.loc_suggested_to_add_sum{{$org}}.as_count()",f"sum:{gc}.loc_added_sum{{$org}}.as_count()"],display="bars"),
    top("Acceptances by IDE",f"top(sum:{gc}.by_ide.code_acceptance_activity_count{{$org}} by {{ide}}.as_count(), 10, 'sum', 'desc')"),
    top("Acceptances by feature",f"top(sum:{gc}.by_feature.code_acceptance_activity_count{{$org}} by {{feature}}.as_count(), 10, 'sum', 'desc')"),
    top("Lines added by language",f"top(sum:{gc}.by_language_feature.loc_added_sum{{$org}} by {{language}}.as_count(), 10, 'sum', 'desc')"),
    top("Prompts by model",f"top(sum:{gc}.by_model_feature.user_initiated_interaction_count{{$org}} by {{model}}.as_count(), 10, 'sum', 'desc')"),
    ts("Pull requests: created / by Copilot / merged",[f"sum:{gc}.pull_requests.total_created{{$org}}.as_count()",f"sum:{gc}.pull_requests.total_created_by_copilot{{$org}}.as_count()",f"sum:{gc}.pull_requests.total_merged{{$org}}.as_count()"],display="bars"),
  ],"vivid_purple"),
  group("GitHub Copilot - seats, CLI and credits",[
    qv("Seats billed",f"sum:github_copilot.organizations.billing.seats.total{{$org}}"),
    qv("Seats active this cycle",f"sum:github_copilot.organizations.billing.seats.active_this_cycle{{$org}}"),
    qv("Seats inactive this cycle",f"sum:github_copilot.organizations.billing.seats.inactive_this_cycle{{$org}}"),
    qv("Seats pending invitation",f"sum:github_copilot.organizations.billing.seats.pending_invitation{{$org}}"),
    ts("CLI sessions / requests / prompts",[f"sum:{gc}.cli.session_count{{$org}}.as_count()",f"sum:{gc}.cli.request_count{{$org}}.as_count()",f"sum:{gc}.cli.prompt_count{{$org}}.as_count()"],display="bars"),
    ts("CLI tokens (prompt vs output)",[f"sum:{gc}.cli.token_usage.prompt_tokens_sum{{$org}}.as_count()",f"sum:{gc}.cli.token_usage.output_tokens_sum{{$org}}.as_count()"],display="area"),
    top("AI credits used by user (cents)",f"top(sum:{gc}.users.ai_credits_used{{$org}} by {{user}}.as_count(), 15, 'sum', 'desc')"),
  ],"vivid_orange"),
  group("Microsoft 365 Copilot",[
    qv("Enabled users (any app)","max:microsoft_copilot.anyapp.users.enabled{*}"),
    qv("Active users (any app)","max:microsoft_copilot.anyapp.users.active{*}"),
    qv("User prompts","sum:microsoft_copilot.userprompt.count{*}.as_count()"),
    qv("AI responses","sum:microsoft_copilot.airesponse.count{*}.as_count()"),
    qv("Guardrail responses","sum:microsoft_copilot.airesponse.guardrail.count{*}.as_count()"),
    ts("Active vs enabled (any app)",["max:microsoft_copilot.anyapp.users.active{*}","max:microsoft_copilot.anyapp.users.enabled{*}"]),
    ts("Active users by app",[f"max:microsoft_copilot.{a}.users.active{{*}}" for a in ("copilotchat","teams","outlook","word","excel","powerpoint","onenote","loop")],display="bars"),
    logs("Per-user last-activity log (daily)","source:microsoft-copilot",("service","status")),
    note("Microsoft publishes Copilot usage reports with up to 72 h delay; blank panels for the current day are expected."),
  ],"vivid_green"),
 ],tvars=(("org","org"),))

# 2 GitHub activity & security ----------------------------------------------------------
d2=dash("Darbotlabs - GitHub Activity & Security",
 "Repository events from the GitHub webhook integration (source:github), plus audit-log streaming and code/secret scanning telemetry where enabled.",
 [group("Repository activity (events)",[
    event_ts("Events per hour","source:github $repo"),
    events("Pull requests","source:github $repo pull_request"),
    events("Pushes and releases","source:github $repo (push OR release)"),
    events("Issues and comments","source:github $repo (issues OR issue_comment)"),
  ]),
  group("Security",[
    events("Dependabot & vulnerability alerts","source:github $repo (dependabot OR vulnerability)"),
    events("Security advisories","source:github $repo security_advisory"),
    logs("GitHub audit log stream (enterprise)","source:github",("service","status")),
    note("Code Scan and Secret Scan alert metrics appear once the Telemetry tab toggles are on for the org. Confirm exact metric names in Metrics Explorer (filter `github.`) and pin them here."),
  ],"vivid_pink"),
  group("Change correlation",[
    ts("HP11D CPU with GitHub pushes overlaid",["avg:system.cpu.user{host:hp11d}+avg:system.cpu.system{host:hp11d}"]),
    note("Enable event overlays in this dashboard's settings with `sources:github` to see pushes/releases on the CPU graph."),
  ],"vivid_yellow"),
 ],tvars=(("repo","repository"),))
d2["widgets"][2]["definition"]["widgets"][0]["definition"]["events"]=[{"q":"source:github","tags_execution":"and"}]

# 3 HP11D infrastructure -----------------------------------------------------------
h="{host:hp11d}"
d3=dash("Darbotlabs - HP11D Infrastructure (Datadog Agent 7.83)",
 "Live host telemetry from the Datadog Agent on HP11D (Windows 11 Pro Insider). Add hosts by widening the $host template variable.",
 [group("At a glance",[
    qv("CPU busy %",f"avg:system.cpu.user{{$host}}+avg:system.cpu.system{{$host}}",1),
    qv("Memory used %",f"100-avg:system.mem.pct_usable{{$host}}*100",1),
    qv("Disk in use % (max volume)",f"max:system.disk.in_use{{$host}}*100",1),
    qv("Uptime (h)",f"max:system.uptime{{$host}}/3600",1),
    qv("Processes",f"max:system.proc.count{{$host}}",0),
    qv("Clock offset (s)",f"avg:ntp.offset{{$host}}",2),
    hostmap("Host map",f"avg:system.cpu.user{{*}}+avg:system.cpu.system{{*}}",["$host"]),
  ]),
  group("CPU & memory",[
    ts("CPU breakdown",[f"avg:system.cpu.user{{$host}}",f"avg:system.cpu.system{{$host}}",f"avg:system.cpu.iowait{{$host}}",f"avg:system.cpu.idle{{$host}}"],display="area"),
    ts("Load (1/5/15)",[f"avg:system.load.1{{$host}}",f"avg:system.load.5{{$host}}",f"avg:system.load.15{{$host}}"]),
    ts("Memory used vs total (bytes)",[f"avg:system.mem.used{{$host}}",f"avg:system.mem.total{{$host}}"]),
    ts("Page file / swap used",[f"avg:system.swap.used{{$host}}"]),
  ],"vivid_blue"),
  group("Disk & network",[
    ts("Disk in use by device",[f"avg:system.disk.in_use{{$host}} by {{device}}*100"]),
    ts("Disk read/write bytes",[f"avg:system.io.r_s{{$host}} by {{device}}",f"avg:system.io.w_s{{$host}} by {{device}}"]),
    ts("Network bytes in/out",[f"avg:system.net.bytes_rcvd{{$host}} by {{device}}",f"avg:system.net.bytes_sent{{$host}} by {{device}}"],display="area"),
    ts("TCP connections",[f"avg:system.net.tcp.current_established{{$host}}"]),
  ],"vivid_green"),
  group("Agent health",[
    ts("Agent running / checks",[f"max:datadog.agent.running{{$host}}",f"sum:datadog.agent.check_status{{$host}}.as_count()"]),
    ts("NTP offset",[f"avg:ntp.offset{{$host}}"]),
    events("Agent & monitor events for this host","host:hp11d"),
    note("No APM traces, logs or LLM Observability spans are configured on HP11D yet; those panels are intentionally absent rather than faked."),
  ],"gray"),
 ],tvars=(("host","host"),))

# 4 Datadog MCP usage (proves the Cowork plugin) -----------------------------------------
m="datadog.mcp.tool.usage"
d4=dash("Darbotlabs - Datadog MCP Server Usage (Cowork plugin evidence)",
 "Datadog emits datadog.mcp.session.starts and datadog.mcp.tool.usage for every MCP session and tool call, tagged with client, tool_name, user_email. When the Copilot Cowork plugin connects, its calls appear here - this is the real proof of connection.",
 [group("Sessions and calls",[
    qv("MCP sessions started","sum:datadog.mcp.session.starts{*}.as_count()"),
    qv("Tool calls",f"count:{m}{{*}}.as_count()"),
    qv("Tool calls from Copilot Cowork",f"count:{m}{{client:copilot-cowork}}.as_count()"),
    ts("Sessions by client",["sum:datadog.mcp.session.starts{*} by {client}.as_count()"],display="bars"),
    ts("Tool calls by client",[f"count:{m}{{*}} by {{client}}.as_count()"],display="bars"),
  ]),
  group("What is being called",[
    top("Top tools",f"top(count:{m}{{*}} by {{tool_name}}.as_count(), 15, 'sum', 'desc')"),
    top("Top users",f"top(count:{m}{{*}} by {{user_email}}.as_count(), 10, 'sum', 'desc')"),
    ts("Copilot Cowork tool calls by tool",[f"count:{m}{{client:copilot-cowork}} by {{tool_name}}.as_count()"],display="bars"),
    logs("Audit Trail: MCP tool calls","source:audit @action:*mcp* OR @evt.name:*mcp*",("@usr.email","@action")),
    note("Client tag values follow the MCP client name presented at initialize; Cowork presents `copilot-cowork`. If the filter shows nothing, check the Top clients panel for the exact tag value."),
  ],"vivid_purple"),
 ])

# Monitors ----------------------------------------------------------------
monitors=[
 {"name":"[Darbotlabs] HP11D stopped reporting","type":"service check","query":"\"datadog.agent.up\".over(\"host:hp11d\").by(\"host\").last(2).count_by_status()",
  "message":"HP11D Datadog Agent has not reported for 10 minutes. Check the Datadog Agent Manager service on HP11D. @REPLACE-WITH-ALERT-RECIPIENT","options":{"thresholds":{"critical":2,"ok":1},"notify_no_data":True,"no_data_timeframe":10},"tags":["team:darbotlabs"],"priority":2},
 {"name":"[Darbotlabs] HP11D disk above 85%","type":"metric alert","query":"max(last_15m):max:system.disk.in_use{host:hp11d} by {device} * 100 > 85",
  "message":"Disk {{device.name}} on HP11D is {{value}}% full. @REPLACE-WITH-ALERT-RECIPIENT","options":{"thresholds":{"critical":85,"warning":75},"notify_no_data":False},"tags":["team:darbotlabs"],"priority":3},
 {"name":"[Darbotlabs] GitHub Copilot daily active users dropped","type":"metric alert","query":"pct_change(avg(last_1d),last_1w):sum:github_copilot.usage.organizations.daily_active_users{*} < -50",
  "message":"GitHub Copilot daily active users fell more than 50% week over week. @REPLACE-WITH-ALERT-RECIPIENT","options":{"thresholds":{"critical":-50},"notify_no_data":False},"tags":["team:darbotlabs"],"priority":4},
 {"name":"[Darbotlabs] Copilot Copilot seats inactive this cycle","type":"metric alert","query":"max(last_1d):sum:github_copilot.organizations.billing.seats.inactive_this_cycle{*} > 5",
  "message":"{{value}} GitHub Copilot seats have not been used this billing cycle. Consider reassigning. @REPLACE-WITH-ALERT-RECIPIENT","options":{"thresholds":{"critical":5,"warning":2},"notify_no_data":False},"tags":["team:darbotlabs"],"priority":5},
 {"name":"[Darbotlabs] Datadog MCP tool-call burst","type":"metric alert","query":"sum(last_10m):count:datadog.mcp.tool.usage{*}.as_count() > 40",
  "message":"More than 40 MCP tool calls in 10 minutes (Datadog fair-use burst limit is 50/10s, monthly 100k). Check Top users on the MCP Usage dashboard. @REPLACE-WITH-ALERT-RECIPIENT","options":{"thresholds":{"critical":40,"warning":25},"notify_no_data":False},"tags":["team:darbotlabs"],"priority":4},
 {"name":"[Darbotlabs] New GitHub security advisory or Dependabot alert","type":"event-v2 alert","query":"events(\"source:github (dependabot OR security_advisory OR vulnerability)\").rollup(\"count\").last(\"1h\") > 0",
  "message":"New GitHub security event received. Review in the GitHub Activity & Security dashboard. @REPLACE-WITH-ALERT-RECIPIENT","options":{"thresholds":{"critical":0},"notify_no_data":False},"tags":["team:darbotlabs"],"priority":3},
]
monitors[3]["name"]="[Darbotlabs] GitHub Copilot seats inactive this cycle"

for fn,d in (("darbotlabs-ai-copilot-adoption.dashboard.json",d1),("darbotlabs-github-activity-security.dashboard.json",d2),("darbotlabs-hp11d-infrastructure.dashboard.json",d3),("darbotlabs-datadog-mcp-usage.dashboard.json",d4)):
    (out/fn).write_text(json.dumps(d,indent=2)+"\n")
    n=sum(len(w["definition"].get("widgets",[w])) for w in d["widgets"])
    print(fn, n, "widgets")
(out/"darbotlabs-monitors.json").write_text(json.dumps(monitors,indent=2)+"\n"); print("monitors", len(monitors))
