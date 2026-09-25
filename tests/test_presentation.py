from portal.auth import owner
from portal.services.grouping import group_issues
from portal.services.report_parser import parse_verapdf_xml
from portal.worker import process_document
from conftest import successful_runner


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
    legacy = group_issues(
        [
            {
                "profile": "pdfua-1",
                "issues": [
                    {"rule_id": "ISO:7.2:20", "message": "first"},
                    {"rule_id": "ISO:7.2:20", "message": "second"},
                ],
            }
        ]
    )
    assert legacy[0]["clause"] == "7.2" and legacy[0]["count"] == 2


def test_pdf_view_is_private_immutable_and_revoked(client, store, uploaded):
    doc_id = uploaded["id"]
    url = f"/api/v1/documents/{doc_id}/pdf"
    assert client.get(url).status_code == 409
    client.post(f"/api/v1/documents/{doc_id}/submit")
    store.put(f"local-development/{doc_id}/input.pdf", b"changed")
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


def test_metadata_and_grouping_before_pagination(client, store, settings, uploaded):
    doc_id = uploaded["id"]
    client.post(f"/api/v1/documents/{doc_id}/submit")

    def runner(path, profile, s):
        result, xml = successful_runner(path, profile, s)
        result.update(
            page_count=7,
            status="failed",
            passed=False,
            issues=[
                {"rule_id": "ISO:7.2:20", "message": str(i), "location": f"page {i + 1}"} for i in range(201)
            ],
        )
        result["summary"].update(errors=201, failed_rules=1)
        return result, xml

    process_document(store, settings, "local-development", doc_id, runner)
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
