import copy
import json
import tempfile
import unittest
from pathlib import Path

import build
from validate import ValidationError, validate_files, validate_zip


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

    def test_all_confirmed_sites_build_and_validate(self):
        for site, meta in build.SITES.items():
            if not meta["confirmed"]:
                continue
            m = build.manifest(site, "readonly")
            validate_files(build.collect_files(m))
            self.assertIn(meta["mcp"], m["agentConnectors"][0]["toolSource"]["remoteMcpServer"]["mcpServerUrl"])

    def test_toolsets_and_subdomain_params(self):
        url = build.endpoint("eu1", "readonly", toolsets="core,alerting,llmobs", subdomain="acme")
        self.assertIn("subdomain=acme", url)
        self.assertIn("toolsets=core,alerting,llmobs", url)
        self.assertIn("omit_tools=", url)
        validate_files(self.files_for(site="eu1", profile="readonly", toolsets="core,alerting,llmobs", subdomain="acme"))

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

    # ---- validator catches the documented upload failures ---------------------
    def test_validator_rejects_packageName(self):
        files = self.mutate(self.files_for(site="us1", profile="readonly"), lambda m: m.update(packageName="x"))
        with self.assertRaisesRegex(ValidationError, "undeclared"):
            validate_files(files)

    def test_validator_rejects_skill_name_mismatch(self):
        files = self.files_for(site="us1", profile="readonly")
        files = dict(files)
        files["skills/datadog-host-health/SKILL.md"] = files["skills/datadog-host-health/SKILL.md"].replace(
            b"name: datadog-host-health", b"name: HostHealth", 1)
        with self.assertRaisesRegex(ValidationError, "ASKILL-P00[67]"):
            validate_files(files)

    def test_validator_rejects_http_url_and_wrong_path(self):
        base = self.files_for(site="us1", profile="readonly")
        files = self.mutate(base, lambda m: m["agentConnectors"][0]["toolSource"]["remoteMcpServer"].update(mcpServerUrl="http://mcp.datadoghq.com/v1/mcp"))
        with self.assertRaisesRegex(ValidationError, "HTTPS"):
            validate_files(files)
        files = self.mutate(base, lambda m: m["agentConnectors"][0]["toolSource"]["remoteMcpServer"].update(mcpServerUrl="https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"))
        with self.assertRaisesRegex(ValidationError, "/v1/mcp"):
            validate_files(files)

    def test_validator_rejects_wrapper_folder(self):
        files = {"wrapper/" + k: v for k, v in self.files_for(site="us1", profile="readonly").items()}
        with self.assertRaisesRegex(ValidationError, "ROOT"):
            validate_files(files)

    def test_validator_rejects_referenceId_with_none_auth(self):
        files = self.mutate(self.files_for(site="us1", profile="readonly"),
                            lambda m: m["agentConnectors"][0]["toolSource"]["remoteMcpServer"].update(authorization={"type": "None", "referenceId": "x"}))
        with self.assertRaisesRegex(ValidationError, "referenceId"):
            validate_files(files)

    # ---- end-to-end zip -------------------------------------------------------
    def test_zip_roundtrip_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            p = build.build("us1", "readonly", Path(d) / "a.zip")
            m = validate_zip(p)
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
