import copy
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import build


class DatadogCoworkPackageTests(unittest.TestCase):
    def files_for(self, **kw):
        return build.collect_files(build.manifest(**kw))

    def mutate(self, files, fn):
        files = copy.deepcopy(files)
        m = json.loads(files["manifest.json"])
        fn(m)
        files["manifest.json"] = json.dumps(m).encode()
        return files

    # ---- endpoint composition -------------------------------------------------
    def test_us1_readonly_omits_write_tools(self):
        url = build.endpoint("us1", "readonly")
        self.assertTrue(url.startswith("https://mcp.datadoghq.com/v1/mcp?omit_tools="))
        for t in build.WRITE_TOOLS:
            self.assertIn(t, url)

    def test_core_profile_is_plain_stable_url(self):
        self.assertEqual(build.endpoint("us1", "core"), "https://mcp.datadoghq.com/v1/mcp")

    def test_all_confirmed_sites_build(self):
        for site, meta in build.SITES.items():
            if not meta["confirmed"]:
                continue
            m = build.manifest(site, "readonly")
            self.assertIn("tools/datadog-tools.json", build.collect_files(m))
            self.assertIn(meta["mcp"], m["agentConnectors"][0]["toolSource"]["remoteMcpServer"]["mcpServerUrl"])

    def test_toolsets_and_subdomain_params(self):
        url = build.endpoint("eu1", "readonly", toolsets="core,alerting,llmobs", subdomain="acme")
        self.assertIn("subdomain=acme", url)
        self.assertIn("toolsets=core,alerting,llmobs", url)
        self.assertIn("omit_tools=", url)

    def test_bad_subdomain_rejected(self):
        with self.assertRaises(build.BuildError):
            build.endpoint("us1", "readonly", subdomain="Bad Sub")

    def test_unknown_site_rejected(self):
        with self.assertRaises(build.BuildError):
            build.endpoint("gov", "readonly")

    # ---- identity -----------------------------------------------------------------
    def test_primary_app_id_is_stable_and_variants_differ(self):
        self.assertEqual(build.manifest("us1", "readonly")["id"], build.PRIMARY_APP_ID)
        ids = {build.manifest(s, p)["id"] for s in ("us1", "eu1", "us5") for p in ("readonly", "core")}
        self.assertEqual(len(ids), 6)
        self.assertEqual(build.manifest("eu1", "core")["id"], build.manifest("eu1", "core")["id"])

    # ---- package contents -----------------------------------------------------
    def test_no_auth_block_and_no_secrets(self):
        files = self.files_for(site="us1", profile="readonly")
        m = json.loads(files["manifest.json"])
        r = m["agentConnectors"][0]["toolSource"]["remoteMcpServer"]
        self.assertNotIn("authorization", r)  # Cowork DCR path
        blob = b"".join(v for k, v in files.items() if not k.endswith(".png")).lower()
        for needle in (b"dd_api_key", b"dd_application_key", b"client_secret", b"bearer "):
            self.assertNotIn(needle, blob)

    def test_eight_skills_all_present_and_named(self):
        files = self.files_for(site="us1", profile="readonly")
        m = json.loads(files["manifest.json"])
        self.assertEqual(len(m["agentSkills"]), 8)
        for s in m["agentSkills"]:
            folder = s["folder"].removeprefix("./")
            self.assertIn(f"{folder}/SKILL.md", files)

    def test_skills_reference_real_tool_names_only(self):
        catalog = {t["name"] for t in build.CATALOG["tools"]}
        for name in build.SKILL_ORDER:
            text = (build.ROOT / "skills" / name / "SKILL.md").read_text()
            import re
            for tool in re.findall(r"`((?:search|get|analyze|aggregate|create|edit|upsert)_[a-z_]+)`", text):
                self.assertIn(tool, catalog, f"{name} references unknown tool {tool}")

    def test_readonly_skills_do_not_instruct_writes(self):
        for name in build.SKILL_ORDER:
            text = (build.ROOT / "skills" / name / "SKILL.md").read_text()
            for w in build.WRITE_TOOLS:
                self.assertNotIn(f"`{w}`", text)

    # ---- bridge and authorization ------------------------------------------------
    def test_bridge_endpoint_keeps_tool_filter(self):
        url = build.bridge_endpoint("https://bridge.example.com/", "us1", "readonly")
        direct = build.endpoint("us1", "readonly")
        self.assertEqual(url, "https://bridge.example.com/mcp?" + direct.split("?", 1)[1])
        self.assertEqual(build.bridge_endpoint("https://bridge.example.com", "us1", "core"), "https://bridge.example.com/mcp")

    def test_bridge_must_be_https_origin(self):
        for bad in ("http://bridge.example.com", "https://bridge.example.com/mcp", "bridge.example.com", ""):
            with self.assertRaises(build.BuildError):
                build.bridge_endpoint(bad, "us1", "readonly")

    def test_dcr_authorization_block(self):
        m = build.manifest("us1", "readonly", auth="dcr", reference_id="QUJDREVGR0g=", mcp_url="https://bridge.example.com/mcp")
        r = m["agentConnectors"][0]["toolSource"]["remoteMcpServer"]
        self.assertEqual(r["authorization"], {"type": "DynamicClientRegistration", "referenceId": "QUJDREVGR0g="})
        self.assertEqual(r["mcpServerUrl"], "https://bridge.example.com/mcp")
        self.assertEqual(r["mcpToolDescription"], {"file": "tools/datadog-tools.json"})
        with self.assertRaises(build.BuildError):
            build.manifest("us1", "readonly", auth="dcr")

    def test_readonly_tool_file_lists_no_write_tools(self):
        files = self.files_for(site="us1", profile="readonly")
        names = {t["name"] for t in json.loads(files["tools/datadog-tools.json"])["tools"]}
        self.assertTrue(names)
        self.assertFalse(names & set(build.WRITE_TOOLS))

    # ---- end-to-end zip -------------------------------------------------------
    def test_zip_roundtrip_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p = build.build("us1", "readonly", Path(d) / "a.zip")
            with zipfile.ZipFile(p) as z:
                self.assertIn("manifest.json", z.namelist())
                m = json.loads(z.read("manifest.json"))
            self.assertEqual(m["version"], build.VERSION)
            with self.assertRaises(build.BuildError):
                build.build("us1", "readonly", p)

    def test_openplugin_layout(self):
        with tempfile.TemporaryDirectory() as d:
            out = build.openplugin(Path(d) / "op")
            self.assertTrue((out / ".plugin" / "plugin.json").is_file())
            mcp = json.loads((out / ".mcp.json").read_text())
            self.assertEqual(mcp["mcpServers"]["datadog"]["type"], "http")
            self.assertEqual(len(list((out / "skills").iterdir())), 8)


if __name__ == "__main__":
    unittest.main()
