#!/usr/bin/env python3
"""Create the Darbotlabs dashboards and monitors in a Datadog org via the public API.

Usage (run on a machine with internet, e.g. HP11D):
  set DD_API_KEY=...  set DD_APP_KEY=...   (or export on macOS/Linux)
  python push_to_datadog.py --site datadoghq.com            # dry run: validates JSON, prints plan
  python push_to_datadog.py --site datadoghq.com --apply    # creates dashboards + monitors

Keys are read from environment variables only; never pass them as arguments.
Stdlib only. Idempotent-ish: re-running --apply creates duplicates, so use --apply once, or
delete the previous copies first (they are tagged team:darbotlabs).
"""
import argparse, json, os, sys, urllib.request, pathlib

HERE = pathlib.Path(__file__).resolve().parent
DASHBOARDS = sorted(HERE.glob("*.dashboard.json"))
MONITORS = HERE / "darbotlabs-monitors.json"

def call(site, path, body, api, app):
    req = urllib.request.Request(f"https://api.{site}{path}", data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json", "DD-API-KEY": api, "DD-APPLICATION-KEY": app})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", default="datadoghq.com", help="datadoghq.com, us3.datadoghq.com, us5.datadoghq.com, datadoghq.eu, ap1.datadoghq.com, ap2.datadoghq.com")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--skip-monitors", action="store_true")
    a = ap.parse_args()
    dashboards = [(p.name, json.loads(p.read_text())) for p in DASHBOARDS]
    monitors = json.loads(MONITORS.read_text())
    print(f"site: {a.site}\ndashboards: {len(dashboards)}\nmonitors: {0 if a.skip_monitors else len(monitors)}")
    for n, d in dashboards: print(f"  - {d['title']}  ({n})")
    if not a.apply:
        print("\nDry run only. Add --apply to create these in Datadog."); return 0
    api, app = os.environ.get("DD_API_KEY"), os.environ.get("DD_APP_KEY")
    if not api or not app:
        print("DD_API_KEY and DD_APP_KEY environment variables are required for --apply", file=sys.stderr); return 2
    for n, d in dashboards:
        r = call(a.site, "/api/v1/dashboard", d, api, app)
        print(f"created dashboard {d['title']} -> https://app.{a.site}{r.get('url','')}")
    if not a.skip_monitors:
        for m in monitors:
            r = call(a.site, "/api/v1/monitor", m, api, app)
            print(f"created monitor {m['name']} -> id {r.get('id')}")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
