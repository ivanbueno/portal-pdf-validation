"""Security checks against compiled ARM, including denied operations and path-confusion cases.

Run after Bicep compilation with PDF_INFRA_TEMPLATE=/path/to/main.json. These checks
exercise the condition expression locally; live Azure authorization still needs a smoke test.
"""

import ast
from fnmatch import fnmatchcase
import json
import os
from pathlib import Path
import re

import pytest

BLOB = "Microsoft.Storage/storageAccounts/blobServices/containers/blobs"
QUEUE = "Microsoft.Storage/storageAccounts/queueServices/queues"
TABLE = "Microsoft.Storage/storageAccounts/tableServices/tables"


def resources(template):
    for resource in template.get("resources", []):
        yield resource
        yield from resources(resource.get("properties", {}).get("template", {}))


@pytest.fixture(scope="module")
def compiled_template():
    path = os.environ.get("PDF_INFRA_TEMPLATE")
    if not path:
        pytest.skip("Set PDF_INFRA_TEMPLATE to the Bicep-compiled ARM template")
    return json.loads(Path(path).read_text())


@pytest.fixture(scope="module")
def worker_access(compiled_template):
    return list(resources(compiled_template))


def one_resource(template, kind):
    matches = [r for r in template["resources"] if r["type"] == kind]
    assert len(matches) == 1
    return matches[0]


def test_worker_never_has_the_api_identity_or_environment(compiled_template):
    worker = next(
        r
        for r in compiled_template["resources"]
        if r["type"] == "Microsoft.App/jobs" and "-worker'" in r["name"]
    )
    variables = compiled_template["variables"]
    assert "-worker'" in variables["workerIdentityId"]
    assert variables["workerIdentityId"] != variables["identityId"]
    assert worker["identity"] == {
        "type": "UserAssigned",
        "userAssignedIdentities": {"[format('{0}', variables('workerIdentityId'))]": {}},
    }
    properties = worker["properties"]
    assert ".outputs.workerEnvironmentId.value" in properties["environmentId"]
    assert properties["workloadProfileName"] == "Consumption"
    configuration = properties["configuration"]
    assert configuration["registries"][0]["identity"] == "[variables('workerIdentityId')]"
    assert configuration["eventTriggerConfig"]["scale"]["rules"][0]["identity"] == (
        "[variables('workerIdentityId')]"
    )
    env = properties["template"]["containers"][0]["env"]
    assert ".outputs.workerClientId.value" in env and "-runtime'" not in env


def arm_value(value, variables, indices=None):
    """Resolve only the pure ARM functions used in NSG rules, failing on unknown syntax."""
    indices = indices or {}
    if isinstance(value, dict):
        return {key: arm_value(item, variables, indices) for key, item in value.items()}
    if isinstance(value, list):
        return [arm_value(item, variables, indices) for item in value]
    if not isinstance(value, str) or not value.startswith("["):
        return value

    def variable(name):
        if name in variables:
            return arm_value(variables[name], variables, indices)
        loop = next(item for item in variables["copy"] if item["name"] == name)
        return [
            arm_value(loop["input"], variables, indices | {name: index})
            for index in range(arm_value(loop["count"], variables, indices))
        ]

    functions = {
        "variables": variable,
        "copyIndex": lambda name: indices[name],
        "length": len,
        "format": lambda pattern, *args: pattern.format(*args),
        "add": lambda left, right: left + right,
        "createArray": lambda *args: list(args),
        "createObject": lambda *args: dict(zip(args[::2], args[1::2], strict=True)),
        "concat": lambda *args: sum(args, []),
    }

    def evaluate(node):
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Subscript):
            return evaluate(node.value)[evaluate(node.slice)]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            return functions[node.func.id](*(evaluate(arg) for arg in node.args))
        raise AssertionError(f"Unsupported ARM expression: {ast.dump(node)}")

    return evaluate(ast.parse(value[1:-1], mode="eval").body)


def test_worker_network_denies_unmatched_egress_and_uses_private_endpoints(compiled_template):
    foundation = one_resource(compiled_template, "Microsoft.Resources/deployments")["properties"]["template"]
    assert one_resource(foundation, "Microsoft.ContainerRegistry/registries")["sku"]["name"] == "Premium"
    network = next(
        r["properties"]["template"]
        for r in foundation["resources"]
        if r["type"] == "Microsoft.Resources/deployments" and "-worker-network'" in r["name"]
    )
    variables = network["variables"]
    nsg = one_resource(network, "Microsoft.Network/networkSecurityGroups")
    rules = arm_value(nsg["properties"]["securityRules"], variables)
    outbound = [rule["properties"] for rule in rules if rule["properties"]["direction"] == "Outbound"]
    deny = [rule for rule in outbound if rule["access"] == "Deny"]
    assert len(deny) == 1
    assert deny[0] == {
        "priority": 4096,
        "direction": "Outbound",
        "access": "Deny",
        "protocol": "*",
        "sourcePortRange": "*",
        "destinationPortRange": "*",
        "sourceAddressPrefix": "*",
        "destinationAddressPrefix": "*",
    }
    expected = {
        variables["workerSubnetPrefix"]: ("*", "*"),
        variables["privateEndpointSubnetPrefix"]: ("Tcp", "443"),
        "AzurePlatformDNS": ("*", "53"),
        **{
            tag: ("Tcp", "443")
            for tag in (
                "MicrosoftContainerRegistry",
                "AzureFrontDoor.FirstParty",
                "AzureActiveDirectory",
                "AzureMonitor",
            )
        },
    }
    allowed = [rule for rule in outbound if rule["access"] == "Allow"]
    assert len(allowed) == len(expected)
    assert {
        rule["destinationAddressPrefix"]: (rule["protocol"], rule["destinationPortRange"]) for rule in allowed
    } == expected
    assert all(rule["sourceAddressPrefix"] == variables["workerSubnetPrefix"] for rule in allowed)
    assert all(rule["priority"] < deny[0]["priority"] for rule in allowed)

    vnet = one_resource(network, "Microsoft.Network/virtualNetworks")
    subnet = next(s for s in vnet["properties"]["subnets"] if s["name"] == "workers")["properties"]
    assert "Microsoft.Network/networkSecurityGroups" in subnet["networkSecurityGroup"]["id"]
    environment = one_resource(network, "Microsoft.App/managedEnvironments")["properties"]
    assert environment["vnetConfiguration"]["internal"] is True
    assert "/subnets/workers" in environment["vnetConfiguration"]["infrastructureSubnetId"]
    assert environment["workloadProfiles"] == [{"name": "Consumption", "workloadProfileType": "Consumption"}]
    assert {service["name"] for service in variables["privateServices"]} == {
        "blob",
        "queue",
        "table",
        "registry",
    }
    endpoints = one_resource(network, "Microsoft.Network/privateEndpoints")
    assert "privateServices" in endpoints["copy"]["count"]
    assert "/subnets/private-endpoints" in endpoints["properties"]["subnet"]["id"]
    one_resource(network, "Microsoft.Network/privateDnsZones/virtualNetworkLinks")
    one_resource(network, "Microsoft.Network/privateEndpoints/privateDnsZoneGroups")


def role(template, suffix):
    matches = [
        r
        for r in template
        if r["type"] == "Microsoft.Authorization/roleDefinitions"
        and f"-worker-{suffix}-" in r["properties"]["roleName"]
    ]
    assert len(matches) == 1
    return matches[0]["properties"]


def assignment(template, suffix):
    matches = [
        r
        for r in template
        if r["type"] == "Microsoft.Authorization/roleAssignments"
        and f"'worker-{suffix}'" in r["properties"]["roleDefinitionId"]
    ]
    assert len(matches) == 1
    return matches[0]


def test_worker_roles_have_no_delete_delegation_send_or_entity_insert(worker_access):
    expected = {
        "blobs": ([], [f"{BLOB}/read", f"{BLOB}/write"]),
        "queue": ([f"{QUEUE}/read"], [f"{QUEUE}/messages/read", f"{QUEUE}/messages/process/action"]),
        "table": ([], [f"{TABLE}/entities/read", f"{TABLE}/entities/update/action"]),
    }
    for suffix, (actions, data_actions) in expected.items():
        permissions = role(worker_access, suffix)["permissions"]
        assert permissions == [
            {"actions": actions, "notActions": [], "dataActions": data_actions, "notDataActions": []}
        ]


def test_worker_grants_use_its_identity_and_individual_storage_resources(worker_access):
    for suffix, resource_type, name in (
        ("blobs", "blobServices/containers", "documents"),
        ("queue", "queueServices/queues", "validation"),
        ("table", "tableServices/tables", "validation"),
    ):
        grant = assignment(worker_access, suffix)
        assert f"Microsoft.Storage/storageAccounts/{resource_type}'" in grant["scope"]
        assert f"'default', '{name}'" in grant["scope"]
        assert "-worker'" in grant["properties"]["principalId"]
        assert "runtime" not in grant["properties"]["principalId"]
    grants = [
        r
        for r in worker_access
        if r["type"] == "Microsoft.Authorization/roleAssignments"
        and "-worker'" in r["properties"]["principalId"]
    ]
    assert len(grants) == 4  # Three custom grants plus AcrPull, never an inherited Contributor grant.
    assert sum("7f951dda-4ed3-4680-a7ca-43fe172d538d" in str(g) for g in grants) == 1


def allows(condition, action, path, snapshot=True, private=True, suboperation=""):
    """Evaluate the documented Boolean/string/Exists subset used by this ABAC policy.

    Parse the deployed expression, not an independently rewritten policy. Fail on unknown
    syntax. fnmatchcase has Azure StringLike's relevant behavior: '*' also matches '/'.
    """
    attributes = {
        f"@Resource[{BLOB}:path]": path,
        "@Environment[isPrivateLink]": private,
    }
    if snapshot:
        attributes[f"@Request[{BLOB}:snapshot]"] = "2026-10-02T00:00:00Z"
    expression = re.sub(
        r"(ActionMatches|SubOperationMatches)\{'([^']+)'\}",
        lambda m: str(fnmatchcase(action if m[1] == "ActionMatches" else suboperation, m[2])),
        condition,
    )
    attribute = r"(@(?:Resource|Request|Environment)\[[^\]]+\])"
    expression = re.sub(r"Exists " + attribute, lambda m: str(m[1] in attributes), expression)

    def compare(match):
        value = attributes.get(match[1])
        if match[2] == "StringLike":
            return str(isinstance(value, str) and fnmatchcase(value, match[3][1:-1]))
        return str(value is (match[3] == "true"))

    expression = re.sub(attribute + r" (StringLike|BoolEquals) ('[^']*'|true|false)", compare, expression)
    expression = re.sub(r"\b(AND|OR|NOT)\b", lambda m: m[0].lower(), expression)

    def evaluate(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, bool):
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
            return not evaluate(node.operand)
        if isinstance(node, ast.BoolOp):
            values = [evaluate(value) for value in node.values]
            if isinstance(node.op, ast.And):
                return all(values)
            if isinstance(node.op, ast.Or):
                return any(values)
        raise AssertionError(f"Unsupported ABAC expression: {ast.dump(node)}")

    return evaluate(ast.parse(expression.strip(), mode="eval").body)


@pytest.mark.parametrize(
    "action,path,snapshot,private,suboperation,expected",
    [
        ("read", "owner/doc/input.pdf", True, True, "", True),
        ("read", "owner/doc/input.pdf", False, True, "", False),
        ("read", "owner/doc/input.pdf", True, False, "", False),
        ("read", "owner/doc/input.pdf", True, True, "Blob.List", False),
        ("read", "owner/doc/reports/run/report.json", True, True, "", False),
        ("read", "owner/doc/other.pdf", True, True, "", False),
        ("write", "owner/doc/reports/run/report.json", False, True, "", True),
        ("write", "owner/doc/reports/run/wcag.xml", False, True, "", True),
        ("write", "owner/doc/reports/run/groups/0.json", False, True, "", True),
        ("write", "owner/doc/reports/run/pdfua1/0.json", False, True, "", True),
        ("write", "owner/doc/reports/run/report.json", False, False, "", False),
        ("write", "owner/doc/input.pdf", False, True, "", False),
        ("write", "owner/doc/reports/input.pdf", False, True, "", False),
        ("write", "owner/doc/run/report.json", False, True, "", False),
        ("write", "owner/doc/reports/run/secret.txt", False, True, "", False),
        ("write", "owner/doc/reports-elsewhere/report.json", False, True, "", False),
        ("write", "owner/doc/reports/run/input.pdf.json/../../input.pdf", False, True, "", False),
        ("delete", "owner/doc/reports/run/report.json", False, True, "", False),
        ("add/action", "owner/doc/input.pdf", False, True, "", False),
    ],
)
def test_blob_policy_allows_only_private_snapshot_reads_and_report_writes(
    worker_access, action, path, snapshot, private, suboperation, expected
):
    grant = assignment(worker_access, "blobs")["properties"]
    assert grant["conditionVersion"] == "2.0"
    assert allows(grant["condition"], f"{BLOB}/{action}", path, snapshot, private, suboperation) == expected
