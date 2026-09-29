#!/usr/bin/env python3
"""Validate a Cowork plugin ZIP against the published Cowork packaging rules.

Checks the rules Microsoft documents for Cowork plugins (manifest v1.28 strictness,
root layout, icon sizes, agentSkills ASKILL-M00x / ASKILL-P00x, connector rules,
companion-file limits) plus Datadog endpoint sanity. It does not replace the
platform's own upload validation.
"""

import io
import json
import re
import sys
import uuid
import zipfile
from pathlib import PurePosixPath
from urllib.parse import urlsplit, parse_qs

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    Image = None

ROOT_KEYS = {
    "$schema", "manifestVersion", "version", "id", "developer", "name", "description",
    "icons", "accentColor", "agentConnectors", "agentSkills",
}
KEBAB = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RESERVED = {"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)}
SAFE_NAME = re.compile(r"^[A-Za-z0-9._ !-]+$")
DATADOG_HOSTS = {
    "mcp.datadoghq.com", "mcp.us3.datadoghq.com", "mcp.us5.datadoghq.com",
    "mcp.datadoghq.eu", "mcp.ap1.datadoghq.com", "mcp.ap2.datadoghq.com", "mcp.uk1.datadoghq.com",
}
ALLOWED_QUERY = {"toolsets", "omit_tools", "subdomain"}


class ValidationError(ValueError):
    pass


def need(cond, msg):
    if not cond:
        raise ValidationError(msg)


def strict_json(data):
    def hook(pairs):
        out = {}
        for k, v in pairs:
            need(k not in out, f"duplicate JSON key {k}")
            out[k] = v
        return out
    return json.loads(data, object_pairs_hook=hook)


def parse_frontmatter(text):
    need(text.startswith("---\n"), "ASKILL-P003: SKILL.md must start with --- frontmatter")
    end = text.find("\n---", 4)
    need(end > 0, "ASKILL-P003: unterminated frontmatter")
    fm = text[4:end]
    fields = {}
    for m in re.finditer(r"^([A-Za-z_]+):\s*(.*)$", fm, re.M):
        fields[m.group(1)] = m.group(2).strip()
    return fields, fm


def validate_files(files):
    need("manifest.json" in files, "manifest.json must be at the ZIP ROOT")
    for n in files:
        need(not n.startswith("/") and ".." not in PurePosixPath(n).parts and "\\" not in n, f"bad path {n}")
    man = strict_json(files["manifest.json"])

    # --- manifest root -------------------------------------------------------------
    extra = set(man) - ROOT_KEYS
    need(not extra, f"v1.28 root additionalProperties=false; undeclared field(s): {sorted(extra)}")
    for k in ("$schema", "manifestVersion", "version", "id", "developer", "name", "description", "icons", "accentColor"):
        need(k in man, f"manifest missing required field {k}")
    need(man["manifestVersion"] == "1.28", "manifestVersion must be 1.28")
    need("v1.28" in man["$schema"], "$schema must reference v1.28")
    need(re.fullmatch(r"\d+\.\d+\.\d+", man["version"]), "version must be semver x.y.z")
    need(str(uuid.UUID(man["id"])) == man["id"].lower(), "id must be a canonical GUID")
    dev = man["developer"]
    need(set(dev) >= {"name", "websiteUrl", "privacyUrl", "termsOfUseUrl"}, "developer needs name/websiteUrl/privacyUrl/termsOfUseUrl")
    need(1 <= len(dev["name"]) <= 32, "developer.name 1-32 chars")
    for k in ("websiteUrl", "privacyUrl", "termsOfUseUrl"):
        need(dev[k].startswith("https://"), f"developer.{k} must be https")
    need(1 <= len(man["name"]["short"]) <= 30, "name.short 1-30 chars")
    need(len(man["name"].get("full", "")) <= 100, "name.full <= 100 chars")
    need(1 <= len(man["description"]["short"]) <= 80, "description.short 1-80 chars")
    need(1 <= len(man["description"]["full"]) <= 4000, "description.full 1-4000 chars")
    need(re.fullmatch(r"#[0-9A-Fa-f]{6}", man["accentColor"]), "accentColor must be #RRGGBB")

    # --- icons ---------------------------------------------------------------------
    for key, size in (("color", 192), ("outline", 32)):
        fn = man["icons"][key]
        need(fn in files and "/" not in fn, f"icon {fn} must be at ZIP root")
        if Image:
            img = Image.open(io.BytesIO(files[fn]))
            need(img.format == "PNG" and img.size == (size, size), f"{fn} must be {size}x{size} PNG, got {img.format} {img.size}")

    # --- connectors ---------------------------------------------------------------
    conns = man.get("agentConnectors", [])
    need(len(conns) <= 10, "max 10 connectors per package")
    ids = set()
    for c in conns:
        need(c.get("id") and c.get("displayName"), "each connector requires id and displayName")
        need(c["id"] not in ids, "connector ids must be unique")
        ids.add(c["id"])
        ts = c["toolSource"]
        need(("remoteMcpServer" in ts) ^ ("plugin" in ts), "exactly one of plugin or remoteMcpServer")
        if "remoteMcpServer" in ts:
            r = ts["remoteMcpServer"]
            u = urlsplit(r["mcpServerUrl"])
            need(u.scheme == "https" and u.netloc, "mcpServerUrl must be a valid HTTPS URL")
            need(not u.username and not u.password and not u.fragment, "mcpServerUrl must not carry credentials or fragments")
            if u.hostname in DATADOG_HOSTS or u.hostname.endswith(".datadoghq.com") or u.hostname.endswith(".datadoghq.eu"):
                need(u.path == "/v1/mcp", "Datadog MCP path must be /v1/mcp (stable endpoint)")
                q = parse_qs(u.query, keep_blank_values=True)
                need(set(q) <= ALLOWED_QUERY, f"unexpected query params {sorted(set(q) - ALLOWED_QUERY)}")
                for k in q:
                    need(len(q[k]) == 1 and q[k][0], f"query param {k} must appear once with a value")
                    need(re.fullmatch(r"[a-z0-9_,-]+", q[k][0]), f"query param {k} has unexpected characters")
            if "mcpToolDescription" in r:
                f = r["mcpToolDescription"]["file"].removeprefix("./")
                need(f in files, "mcpToolDescription.file must exist in the ZIP")
                strict_json(files[f])
            auth = r.get("authorization")
            if auth is not None:
                need(auth.get("type") in {"None", "OAuthPluginVault", "ApiKeyPluginVault", "DynamicClientRegistration"}, "unknown authorization.type")
                if auth["type"] == "None":
                    need("referenceId" not in auth, "referenceId must not be present when type is None")
                else:
                    need(auth.get("referenceId"), "authorization.referenceId required unless type is None")

    # --- skills --------------------------------------------------------------------
    skills = man.get("agentSkills", [])
    need(len(skills) <= 20, "ASKILL-M002: max 20 skills")
    seen = set()
    for s in skills:
        need("folder" in s, "ASKILL-M001: folder is required")
        need(len(s["folder"]) <= 256, "ASKILL-M003: folder path <= 256 chars")
        folder = s["folder"].removeprefix("./").rstrip("/")
        need(folder not in seen, "ASKILL-P008: duplicate skill folder")
        seen.add(folder)
        skill_md = f"{folder}/SKILL.md"
        need(skill_md in files, f"ASKILL-P001/P002: {skill_md} missing from ZIP")
        fields, _ = parse_frontmatter(files[skill_md].decode("utf-8"))
        need("name" in fields, "ASKILL-P004: frontmatter needs name")
        need("description" in fields, "ASKILL-P005: frontmatter needs description")
        need(KEBAB.match(fields["name"]) and len(fields["name"]) <= 64, f"ASKILL-P007: name not kebab-case: {fields['name']}")
        need(fields["name"] == PurePosixPath(folder).name, f"ASKILL-P006: name {fields['name']} != folder {folder}")
        companions = [n for n in files if n.startswith(folder + "/") and n != skill_md]
        need(len(companions) <= 20, "max 20 companion files per skill")
        total = 0
        for n in companions:
            rel = PurePosixPath(n).relative_to(folder)
            for part in rel.parts:
                need(not part.startswith("."), f"hidden companion file {n}")
                need(part.split(".")[0].upper() not in RESERVED, f"reserved name {n}")
                need(SAFE_NAME.match(part), f"unsafe companion file name {n}")
            need(len(files[n]) <= 5 * 1024 * 1024, f"companion {n} > 5 MB")
            total += len(files[n])
        need(total <= 10 * 1024 * 1024, "companion files > 10 MB per skill")
    need(conns or skills, "package must declare at least one connector or skill")
    return man


def validate_zip(path):
    with zipfile.ZipFile(path) as z:
        need(z.testzip() is None, "corrupt ZIP")
        files = {i.filename: z.read(i) for i in z.infolist() if not i.is_dir()}
    return validate_files(files)


if __name__ == "__main__":
    for p in sys.argv[1:]:
        m = validate_zip(p)
        print(f"OK  {p}  id={m['id']}  v{m['version']}  skills={len(m.get('agentSkills', []))}  "
              f"url={m['agentConnectors'][0]['toolSource']['remoteMcpServer']['mcpServerUrl'] if m.get('agentConnectors') else '-'}")
