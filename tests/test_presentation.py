from portal.auth import owner
from portal.services.grouping import group_issues
from portal.services.report_parser import parse_verapdf_xml
from portal.worker import process_document
from conftest import ISSUE, OWNER, failing_runner, put_input, runner_with


def test_group_by_specification_clause_test_preserves_profiles_and_locations():
    common = dict(specification="ISO 14289-1", clause="7.2", test_number="20", description="Rule description")
    results = [
        {
            "profile": "pdfua-1",
            "issues": [
                common | {"message": "first", "location": "page 1"},
                common | {"message": "second", "location": "page 2"},
            ],
        },
        {
            "profile": "wcag-2.2",
            "issues": [
                common | {"message": "third"},
                common | {"specification": "Other", "message": "distinct"},
            ],
        },
    ]
    groups = group_issues(results)
    assert len(groups) == 2
    assert groups[0]["count"] == 3 and groups[0]["message"] == "Rule description"
    assert groups[0]["counts"] == {"pdfua-1": 2, "wcag-2.2": 1}
    assert groups[0]["occurrences"][1]["location"] == "page 2"


def test_pdf_view_is_private_immutable_and_revoked(client, store, uploaded):
    doc_id = uploaded["id"]
    url = f"/api/v1/documents/{doc_id}/pdf"
    assert client.get(url).status_code == 409
    client.post(f"/api/v1/documents/{doc_id}/submit")
    put_input(store, doc_id, b"changed")
    response = client.get(url)
    assert response.content == b"%PDF-1.7\n"
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"].startswith("inline;")
    assert response.headers["cache-control"] == "no-store"
    client.app.dependency_overrides[owner] = lambda: "other-owner"
    assert client.get(url).status_code == 404
    assert client.get(f"/api/v1/documents/{doc_id}/issues").status_code == 404
    client.app.dependency_overrides.clear()
    client.delete(f"/api/v1/documents/{doc_id}")
    assert client.get(url).status_code == 404


def test_metadata_and_grouping_before_pagination(client, store, settings, submitted):
    doc_id = submitted
    issues = [ISSUE | {"message": str(i), "location": f"page {i + 1}"} for i in range(201)]
    process_document(store, settings, OWNER, doc_id, failing_runner(issues, page_count=7))
    item = client.get("/api/v1/documents").json()["items"][0]
    assert item["page_count"] == 7 and item["pdf_available"]
    assert len(item["profiles"]) == 2 and item["profiles"][0]["summary"]["errors"] == 201
    groups = client.get(f"/api/v1/documents/{doc_id}/issues?limit=1").json()
    assert groups["total"] == 1 and groups["items"][0]["count"] == 402
    assert len(groups["items"][0]["occurrences"]) == 100
    report = client.get(f"/api/v1/documents/{doc_id}/reports/json").json()
    assert len(report["issue_groups"][0]["occurrences"]) == 402
    assert client.get(f"/api/v1/documents/{doc_id}/issues?offset=1").json()["items"] == []


def test_page_count_and_explicit_rule_metadata():
    xml = """<report><validationReport isCompliant="false"><rule specification="ISO" clause="7.2" testNumber="20" status="failed"><description>Description</description></rule></validationReport><featuresReport><pages><page orderNumber="1"/><page orderNumber="2"/></pages></featuresReport></report>"""
    parsed = parse_verapdf_xml(xml, 1)
    assert parsed.page_count == 2
    assert parsed.issues[0].clause == "7.2" and parsed.issues[0].test_number == "20"
    assert parsed.issues[0].description == "Description"
    assert parse_verapdf_xml('<validationReport isCompliant="true"/>', 1).page_count is None


def test_list_filters_server_side_and_reports_workspace_totals(client, store, settings, submitted):
    doc_id = submitted
    pending = client.post("/api/v1/documents", json={"name": "Other.pdf", "size": 9}).json()
    queued = client.get("/api/v1/documents").json()
    assert queued["active_ids"] == [doc_id]
    process_document(store, settings, OWNER, doc_id, runner_with(page_count=3))
    page = client.get("/api/v1/documents?limit=1").json()
    assert page["total"] == page["matching"] == 2 and len(page["items"]) == 1
    assert page["processed"] == 1 and page["pages"] == 3
    assert page["passed_by_profile"] == {"pdfua-1": 1, "wcag-2.2": 1} and page["active_ids"] == []
    assert "ua_passed" not in page and "wcag_passed" not in page
    search = client.get("/api/v1/documents?q=%20other").json()
    assert [d["id"] for d in search["items"]] == [pending["id"]]
    assert search["matching"] == 1 and search["total"] == 2 and search["processed"] == 1
    assert [d["id"] for d in client.get("/api/v1/documents?status=passed").json()["items"]] == [doc_id]
    assert client.get("/api/v1/documents?status=active").json()["matching"] == 1
    assert client.get("/api/v1/documents?status=deleted").status_code == 422


def test_issue_views_read_groups_stored_at_publish(client, store, settings, submitted, monkeypatch):
    base = f"/api/v1/documents/{submitted}"
    assert client.get(base + "/issues").json() == {"items": [], "total": 0, "offset": 0, "limit": 100}
    process_document(store, settings, OWNER, submitted, failing_runner([ISSUE] * 150))
    real, reads = store.read, []
    monkeypatch.setattr(store, "read", lambda name: reads.append(name.rsplit("/", 1)[1]) or real(name))
    groups = client.get(base + "/issues").json()
    assert reads == ["issues.json"]
    assert groups["items"][0]["count"] == 300 and len(groups["items"][0]["occurrences"]) == 100
    report = client.get(base + "/reports/json").json()
    assert reads[1:] == ["report.json"] and len(report["issue_groups"][0]["occurrences"]) == 300
    assert "issue_groups" not in client.get(base).json()
