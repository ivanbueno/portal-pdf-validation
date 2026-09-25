import time
from pathlib import Path
import pytest
from fastapi.testclient import TestClient
from portal.app import create_app
from portal.config import Settings
from portal.services.runner import run_profile, ValidationError
from portal.services.report_parser import parse_verapdf_xml


@pytest.mark.parametrize("kwargs", [{"dev_identity": True}, {"storage_connection_string": "secret"}, {}])
def test_production_fail_closed(kwargs):
    with pytest.raises(ValueError):
        Settings(_env_file=None, environment="production", **kwargs)


def test_missing_auth(settings, store):
    settings.dev_identity = False
    client = TestClient(create_app(settings, store))
    assert (
        client.get("/api/v1/documents", headers={"x-forwarded-email": "admin@example.com"}).status_code == 401
    )


def test_reused_parser_supports_real_check_nodes():
    xml = """<report><validationReport isCompliant="false"><details failedRules="1" passedRules="3" failedChecks="1"><rule status="failed" specification="UA" clause="5" testNumber="1"><description>Fallback</description><check status="failed"><context>root/document[0]</context><errorMessage>Missing metadata</errorMessage></check></rule></details></validationReport></report>"""
    r = parse_verapdf_xml(xml, 1)
    assert r.issues[0].message == "Missing metadata"
    assert r.issues[0].location == "root/document[0]"
    assert r.issues[0].rule_id == "UA:5:1"


def test_xml_entities_rejected():
    with pytest.raises(Exception):
        parse_verapdf_xml(
            '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><validationReport>&xxe;</validationReport>',
            1,
        )


@pytest.mark.parametrize("mode", ["timeout", "output"])
def test_process_limits(settings, tmp_path, mode):
    script = tmp_path / "fake-java"
    script.write_text(
        "#!/usr/bin/env python3\nimport time,sys\n"
        + (
            "time.sleep(30)\n"
            if mode == "timeout"
            else 'sys.stdout.write("x"*100000);sys.stdout.flush();time.sleep(30)\n'
        )
    )
    script.chmod(0o755)
    settings.java = str(script)
    settings.profile_timeout = 1
    settings.report_limit = 1000
    start = time.monotonic()
    with pytest.raises(ValidationError, match="timed out|output limit"):
        run_profile("unused.pdf", "pdfua-1", settings)
    assert time.monotonic() - start < 4


@pytest.mark.verapdf
@pytest.mark.parametrize("filename,ua,wcag", [("ua-pass.pdf", True, True), ("ua-fail.pdf", False, True)])
def test_real_profiles(filename, ua, wcag):
    settings = Settings()
    if not settings.verapdf_jar.exists():
        pytest.skip("Set PDF_VERAPDF_JAR to run real engine acceptance tests")
    for profile, expected in [("pdfua-1", ua), ("wcag-2.2", wcag)]:
        result, raw = run_profile(Path("tests/fixtures") / filename, profile, settings)
        assert result["passed"] is expected
        assert parse_verapdf_xml(raw.decode(), 0).passed is expected
        if not expected:
            assert result["issues"][0]["location"].startswith("root/")


@pytest.mark.verapdf
def test_malformed_pdf(tmp_path):
    settings = Settings()
    if not settings.verapdf_jar.exists():
        pytest.skip("Set PDF_VERAPDF_JAR")
    path = tmp_path / "broken.pdf"
    path.write_bytes(b"%PDF-1.7\nbroken")
    with pytest.raises(ValidationError, match="malformed or encrypted"):
        run_profile(path, "pdfua-1", settings)


@pytest.mark.verapdf
def test_encrypted_pdf():
    settings = Settings()
    if not settings.verapdf_jar.exists():
        pytest.skip("Set PDF_VERAPDF_JAR")
    with pytest.raises(ValidationError, match="malformed or encrypted"):
        run_profile(Path("tests/fixtures/encrypted.pdf"), "pdfua-1", settings)
