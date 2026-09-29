#!/usr/bin/env python3
"""Build Datadog for Copilot Cowork app packages (v1.28 manifest) for any Datadog site.

Stdlib only. Never uploads, never authenticates, never embeds credentials.

Examples
  python3 build.py --site us1 --profile readonly --output dist/datadog-cowork-us1-readonly.zip
  python3 build.py --site eu1 --profile core --toolsets core,alerting --output dist/eu1.zip
  python3 build.py --site us1 --profile readonly --subdomain acme --output dist/acme.zip
  python3 build.py --openplugin dist/openplugin     # Agent Plugins layout for atk import / Claude Code / Cursor
"""

import argparse
import json
import re
import uuid
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VERSION = "1.4.0"
SCHEMA = "https://developer.microsoft.com/json-schemas/teams/v1.28/MicrosoftTeams.schema.json"
CATALOG = json.loads((ROOT / "catalog" / "core-tools.json").read_text())
SITES = CATALOG["sites"]
WRITE_TOOLS = CATALOG["write_tools_in_core"]
# Stable app id for the primary US1 read-only package (upgrade path from 1.3.x).
PRIMARY_APP_ID = "36d12977-5bb3-42db-be64-50aa2ac403ab"
SKILL_ORDER = [
    "datadog-connection-check",
    "datadog-host-health",
    "datadog-monitor-triage",
    "datadog-incident-brief",
    "datadog-log-investigation",
    "datadog-dashboard-explorer",
    "datadog-service-trace",
    "datadog-metric-explorer",
]
DEVELOPER = {
    "name": "Daryl Yourk",
    "websiteUrl": "https://github.com/dayour/datadog-agent-plugin",
    # Service-provider policies for the Datadog MCP service the connector calls.
    "privacyUrl": "https://www.datadoghq.com/legal/privacy/",
    "termsOfUseUrl": "https://www.datadoghq.com/legal/eula/",
}


class BuildError(ValueError):
    pass


def endpoint(site, profile, toolsets=None, subdomain=None):
    if site not in SITES:
        raise BuildError(f"Unknown site {site!r}; choose one of {', '.join(SITES)}")
    params = []
    if subdomain:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", subdomain):
            raise BuildError("subdomain must be a lowercase DNS label")
        params.append(("subdomain", subdomain))
    sets = [s.strip() for s in (toolsets or "core").split(",") if s.strip()]
    if sets != ["core"]:
        params.append(("toolsets", ",".join(sets)))
    if profile == "readonly":
        params.append(("omit_tools", ",".join(WRITE_TOOLS)))
    url = SITES[site]["mcp"]
    if params:
        url += "?" + "&".join(f"{k}={v}" for k, v in params)
    return url


def app_id(site, profile, toolsets, subdomain):
    if site == "us1" and profile == "readonly" and not toolsets and not subdomain:
        return PRIMARY_APP_ID
    seed = f"datadog-cowork|{site}|{profile}|{toolsets or 'core'}|{subdomain or ''}"
    return str(uuid.uuid5(uuid.UUID(PRIMARY_APP_ID), seed))


def manifest(site, profile, toolsets=None, subdomain=None, app_uuid=None):
    if profile not in ("readonly", "core"):
        raise BuildError("profile must be readonly or core")
    s = SITES[site]
    label = site.upper()
    mode = "read-only" if profile == "readonly" else "read/write (core)"
    url = endpoint(site, profile, toolsets, subdomain)
    return {
        "$schema": SCHEMA,
        "manifestVersion": "1.28",
        "version": VERSION,
        "id": app_uuid or app_id(site, profile, toolsets, subdomain),
        "developer": DEVELOPER,
        "name": {
            "short": f"Datadog ({label})",
            "full": f"Datadog for Microsoft 365 Copilot Cowork - {label} {mode}",
        },
        "description": {
            "short": f"Live Datadog hosts, monitors, incidents, logs, traces and dashboards ({label}).",
            "full": (
                f"Connects Copilot Cowork to your Datadog organization on the {label} site "
                f"({s['site']}) through Datadog's official MCP Server, with eight ready-made "
                "skills: connection check, host health, monitor triage, incident brief, log "
                "investigation, dashboard explorer, service and trace investigation, and metric "
                "explorer. Every answer is grounded in a real Datadog tool result with the "
                "retrieval time stated. "
                + (
                    "This package exposes the core read tools only; Datadog's notebook and "
                    "dashboard write tools are omitted at the connector URL. "
                    if profile == "readonly"
                    else "This package exposes Datadog's full core toolset, including notebook and "
                    "dashboard writes, which Datadog authorizes only for users with mcp_write. "
                )
                + "You sign in with your own Datadog account; access is limited to what that "
                "account can already see. No credentials are stored in this package. Privacy "
                "and terms links refer to Datadog's service policies for the MCP service this "
                "connector calls. Community package by Daryl Yourk; not an official Datadog or "
                "Microsoft product."
            ),
        },
        "icons": {"color": "color.png", "outline": "outline.png"},
        "accentColor": "#632CA6",
        "agentConnectors": [
            {
                "id": f"datadog-mcp-{site}",
                "displayName": f"Datadog MCP ({label})",
                "description": f"Datadog MCP Server, {label} site, {mode}. Sign in with your Datadog account.",
                "toolSource": {"remoteMcpServer": {"mcpServerUrl": url}},
            }
        ],
        "agentSkills": [{"folder": f"./skills/{name}"} for name in SKILL_ORDER],
    }


def collect_files(man):
    files = {
        "manifest.json": (json.dumps(man, indent=2, ensure_ascii=True) + "\n").encode(),
        "color.png": (ROOT / "icons" / "color.png").read_bytes(),
        "outline.png": (ROOT / "icons" / "outline.png").read_bytes(),
    }
    for entry in man["agentSkills"]:
        folder = entry["folder"].removeprefix("./")
        src = ROOT / folder
        if not (src / "SKILL.md").is_file():
            raise BuildError(f"missing skill {folder}")
        for p in sorted(src.rglob("*")):
            if p.is_file() and not p.name.startswith("."):
                files[f"{folder}/{p.relative_to(src).as_posix()}"] = p.read_bytes()
    return files


def write_zip(path, files):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise BuildError(f"{path} already exists; refusing to overwrite")
    with zipfile.ZipFile(path, "x", zipfile.ZIP_DEFLATED) as z:
        for name in sorted(files):
            info = zipfile.ZipInfo(name, (2026, 9, 28, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, files[name])
    from validate import validate_zip  # local import keeps build.py standalone-importable
    validate_zip(path)
    return path


def build(site, profile, output, toolsets=None, subdomain=None, app_uuid=None):
    return write_zip(output, collect_files(manifest(site, profile, toolsets, subdomain, app_uuid)))


def openplugin(out_dir, site="us1", profile="readonly"):
    """Agent Plugins layout: .plugin/plugin.json + .mcp.json + skills/ (atk import openplugin, Claude Code, Cursor)."""
    out = Path(out_dir)
    if out.exists():
        raise BuildError(f"{out} already exists")
    (out / ".plugin").mkdir(parents=True)
    plugin = {
        "name": "datadog-cowork",
        "version": VERSION,
        "description": "Datadog observability skills and MCP connection (official Datadog MCP Server).",
        "author": {"name": DEVELOPER["name"], "url": DEVELOPER["websiteUrl"]},
        "homepage": DEVELOPER["websiteUrl"],
        "license": "MIT",
        "skills": "./skills",
        "mcpServers": "./.mcp.json",
    }
    (out / ".plugin" / "plugin.json").write_text(json.dumps(plugin, indent=2) + "\n")
    (out / ".mcp.json").write_text(json.dumps({
        "mcpServers": {"datadog": {"type": "http", "url": endpoint(site, profile)}}
    }, indent=2) + "\n")
    for name in SKILL_ORDER:
        src = ROOT / "skills" / name
        dst = out / "skills" / name
        for p in src.rglob("*"):
            if p.is_file():
                target = dst / p.relative_to(src)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(p.read_bytes())
    for icon in ("color.png", "outline.png"):
        (out / icon).write_bytes((ROOT / "icons" / icon).read_bytes())
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default="us1", choices=sorted(SITES))
    ap.add_argument("--profile", default="readonly", choices=["readonly", "core"])
    ap.add_argument("--toolsets", help="comma list, e.g. core,alerting,llmobs (default core)")
    ap.add_argument("--subdomain", help="Datadog custom login subdomain, if your org uses one")
    ap.add_argument("--app-id", help="override the manifest id (keep stable across versions)")
    ap.add_argument("--output", help="ZIP path to create")
    ap.add_argument("--openplugin", help="write an Agent Plugins directory instead of a ZIP")
    a = ap.parse_args(argv)
    if a.openplugin:
        print(openplugin(a.openplugin, a.site, a.profile))
        return 0
    if not a.output:
        ap.error("--output is required unless --openplugin is used")
    if not SITES[a.site]["confirmed"]:
        print(f"warning: {a.site} endpoint is derived, not confirmed by Datadog docs: {SITES[a.site].get('note','')}")
    print(build(a.site, a.profile, a.output, a.toolsets, a.subdomain, a.app_id))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
