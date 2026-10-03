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
import runpy

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


def deployment(template, suffix):
    key = {"net": "network", "worker-access": "workerAccess"}.get(suffix, suffix) + "Deployment"
    matches = [
        r
        for r in template["resources"]
        if r["type"] == "Microsoft.Resources/deployments" and f".{key}" in r["name"]
    ]
    assert len(matches) == 1
    return matches[0]


def nested(template, suffix):
    return deployment(template, suffix)["properties"]["template"]


def test_worker_never_has_the_api_identity_or_environment(compiled_template):
    app_deployment = deployment(compiled_template, "app")
    app = app_deployment["properties"]["template"]
    worker = next(
        r for r in app["resources"] if r["type"] == "Microsoft.App/jobs" and ".worker)" in r["name"]
    )
    params = app_deployment["properties"]["parameters"]
    for name in ("workerIdentityId", "workerClientId", "workerEnvironmentId"):
        assert f".outputs.{name}.value" in params[name]["value"]
    assert params["workerIdentityId"] != params["identityId"]
    assert worker["identity"] == {
        "type": "UserAssigned",
        "userAssignedIdentities": {"[format('{0}', parameters('workerIdentityId'))]": {}},
    }
    properties = worker["properties"]
    assert properties["environmentId"] == "[parameters('workerEnvironmentId')]"
    assert properties["workloadProfileName"] == "Consumption"
    configuration = properties["configuration"]
    assert configuration["registries"][0]["identity"] == "[parameters('workerIdentityId')]"
    assert configuration["eventTriggerConfig"]["scale"]["rules"][0]["identity"] == (
        "[parameters('workerIdentityId')]"
    )
    env = properties["template"]["containers"][0]["env"]
    assert env == "[variables('workerEnv')]"
    assert "parameters('workerClientId')" in app["variables"]["workerEnv"]
    assert "runtimeClientId" not in app["variables"]["workerEnv"]
    foundation = nested(compiled_template, "foundation")
    admin = nested(foundation, "admin")
    assert ".workerIdentity)" in admin["outputs"]["workerIdentityId"]["value"]
    assert ".runtimeIdentity)" in admin["outputs"]["identityId"]["value"]
    assert ".outputs.workerIdentityId.value" in foundation["outputs"]["workerIdentityId"]["value"]


def test_fresh_deployment_places_resources_in_four_groups(compiled_template):
    assert "/subscriptionDeploymentTemplate.json#" in compiled_template["$schema"]
    foundation = nested(compiled_template, "foundation")
    groups = [r for r in foundation["resources"] if r["type"] == "Microsoft.Resources/resourceGroups"]
    assert {r["name"] for r in groups} == {
        "[format('{0}-{1}', variables('namePrefix'), variables('names')." + role + "Group)]"
        for role in ("admin", "net", "app", "data")
    }
    for template, module, group, allowed in (
        (
            foundation,
            "admin",
            "admin",
            {
                "Microsoft.ManagedIdentity",
                "Microsoft.ContainerRegistry",
                "Microsoft.OperationalInsights",
                "Microsoft.Authorization",
            },
        ),
        (foundation, "data", "data", {"Microsoft.Storage", "Microsoft.Authorization"}),
        (foundation, "net", "net", {"Microsoft.Network"}),
        (foundation, "environments", "app", {"Microsoft.App"}),
        (compiled_template, "app", "app", {"Microsoft.App"}),
        (compiled_template, "monitoring", "admin", {"Microsoft.Insights"}),
    ):
        module_deployment = deployment(template, module)
        assert module_deployment["resourceGroup"] == (
            "[format('{0}-{1}', variables('namePrefix'), variables('names')." + group + "Group)]"
        )
        deployed = list(resources(module_deployment["properties"]["template"]))
        providers = {
            r["type"].split("/")[0] for r in deployed if r["type"] != "Microsoft.Resources/deployments"
        }
        assert providers == allowed
        assert module_deployment.get("dependsOn"), "Fresh deployments must wait for their groups/resources"


def test_cross_group_network_identity_logs_and_alert_references(compiled_template):
    foundation = nested(compiled_template, "foundation")
    data = nested(foundation, "data")
    access = nested(data, "worker-access")
    for grant in resources(data):
        if grant["type"] == "Microsoft.Authorization/roleAssignments":
            assert "parameters('adminResourceGroupName')" in grant["properties"]["principalId"]
    for resource in access["resources"]:
        if resource["type"] == "Microsoft.Authorization/roleDefinitions":
            assert resource["properties"]["assignableScopes"] == ["[resourceGroup().id]"]
    network = deployment(foundation, "net")["properties"]
    assert ".outputs.storageId.value" in network["parameters"]["storageId"]["value"]
    assert ".outputs.registryId.value" in network["parameters"]["registryId"]["value"]
    services = network["template"]["variables"]["privateServices"]
    assert all(s["resourceId"] == "[parameters('storageId')]" for s in services if s["name"] != "registry")
    assert next(s for s in services if s["name"] == "registry")["resourceId"] == "[parameters('registryId')]"
    environments = deployment(foundation, "environments")["properties"]
    assert ".outputs.workerSubnetId.value" in environments["parameters"]["workerSubnetId"]["value"]
    for env in environments["template"]["resources"]:
        logs = env["properties"]["appLogsConfiguration"]["logAnalyticsConfiguration"]
        assert "parameters('adminResourceGroupName')" in logs["customerId"]
        assert "parameters('adminResourceGroupName')" in logs["sharedKey"]
    monitor = deployment(compiled_template, "monitoring")["properties"]
    for name in ("logsId", "storageId", "workerJobId", "maintenanceJobId"):
        assert f".outputs.{name}.value" in monitor["parameters"][name]["value"]
    alerts = [r for r in monitor["template"]["resources"] if "scopes" in r["properties"]]
    assert len(alerts) == 3
    assert all("resourceId(" not in str(r["properties"]["scopes"]) for r in alerts)
    job_alert = next(r for r in alerts if "copy" in r)
    assert all(
        f"parameters('{name}')" in str(job_alert["properties"]["scopes"])
        for name in ("workerJobId", "maintenanceJobId")
    )


def arm_value(value, variables, indices=None, parameters=None):
    """Resolve only the pure ARM functions used in NSG rules, failing on unknown syntax."""
    indices = indices or {}
    parameters = parameters or {}
    if isinstance(value, dict):
        return {key: arm_value(item, variables, indices, parameters) for key, item in value.items()}
    if isinstance(value, list):
        return [arm_value(item, variables, indices, parameters) for item in value]
    if not isinstance(value, str) or not value.startswith("["):
        return value

    def variable(name):
        if name in variables:
            return arm_value(variables[name], variables, indices, parameters)
        loop = next(item for item in variables["copy"] if item["name"] == name)
        return [
            arm_value(loop["input"], variables, indices | {name: index}, parameters)
            for index in range(arm_value(loop["count"], variables, indices, parameters))
        ]

    functions = {
        "variables": variable,
        "parameters": lambda name: parameters[name],
        "replace": lambda value, old, new: value.replace(old, new),
        "environment": lambda: {"suffixes": {"storage": "core.windows.net"}},
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
        if isinstance(node, ast.Attribute):
            return evaluate(node.value)[node.attr]
        if isinstance(node, ast.Subscript):
            return evaluate(node.value)[evaluate(node.slice)]
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            return functions[node.func.id](*(evaluate(arg) for arg in node.args))
        raise AssertionError(f"Unsupported ARM expression: {ast.dump(node)}")

    return evaluate(ast.parse(value[1:-1], mode="eval").body)


def test_worker_network_denies_unmatched_egress_and_uses_private_endpoints(compiled_template):
    foundation = nested(compiled_template, "foundation")
    admin = nested(foundation, "admin")
    assert one_resource(admin, "Microsoft.ContainerRegistry/registries")["sku"]["name"] == "Premium"
    network = nested(foundation, "net")
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
    subnet = next(s for s in vnet["properties"]["subnets"] if ".workerSubnet)" in s["name"])["properties"]
    assert "Microsoft.Network/networkSecurityGroups" in subnet["networkSecurityGroup"]["id"]
    environments = nested(foundation, "environments")
    environment = next(
        r["properties"] for r in environments["resources"] if ".workerEnvironment)" in r["name"]
    )
    assert environment["vnetConfiguration"]["internal"] is True
    assert environment["vnetConfiguration"]["infrastructureSubnetId"] == "[parameters('workerSubnetId')]"
    assert "/subnets/" in network["outputs"]["workerSubnetId"]["value"]
    assert ".workerSubnet)" in network["outputs"]["workerSubnetId"]["value"]
    assert environment["workloadProfiles"] == [{"name": "Consumption", "workloadProfileType": "Consumption"}]
    assert {service["name"] for service in variables["privateServices"]} == {
        "blob",
        "queue",
        "table",
        "registry",
    }
    endpoints = one_resource(network, "Microsoft.Network/privateEndpoints")
    assert "privateServices" in endpoints["copy"]["count"]
    assert "/subnets/" in endpoints["properties"]["subnet"]["id"]
    assert ".privateEndpointSubnet)" in endpoints["properties"]["subnet"]["id"]
    one_resource(network, "Microsoft.Network/privateDnsZones/virtualNetworkLinks")
    one_resource(network, "Microsoft.Network/privateEndpoints/privateDnsZoneGroups")


def role(template, suffix):
    matches = [
        r
        for r in template
        if r["type"] == "Microsoft.Authorization/roleDefinitions" and f"'worker-{suffix}'" in r["name"]
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
        assert ".workerIdentity)" in grant["properties"]["principalId"]
        assert "runtime" not in grant["properties"]["principalId"]
    grants = [
        r
        for r in worker_access
        if r["type"] == "Microsoft.Authorization/roleAssignments"
        and ".workerIdentity)" in r["properties"]["principalId"]
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


@pytest.mark.parametrize("env,project", [("prod", "pdfportal"), ("dev", "portal2"), ("abcde", "abcdefgh12")])
def test_compiled_names_match_deployment_cli_and_azure_limits(compiled_template, env, project):
    make_names = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "azure_names.py"))[
        "resource_names"
    ]
    expected = make_names(env, project)
    values = {
        "env": env,
        "project": project,
        "namePrefix": f"{env}-{project}",
        "storageId": "storage-id",
        "registryId": "registry-id",
    }
    for key, name in expected.items():
        if key in ("storage", "registry"):
            assert re.fullmatch(r"[a-z][a-z0-9]+", name)
        else:
            assert re.fullmatch(
                r"[a-z][a-z0-9]{0,4}-[a-z][a-z0-9]{0,9}-(admin|net|app|data)-[a-z]+"
                r"(?:-[a-z][a-z0-9]*)?(?:-[0-9]{2})?",
                name,
            )
    assert len(set(expected.values())) == len(expected)
    assert 3 <= len(expected["storage"]) <= 24
    assert 5 <= len(expected["registry"]) <= 50
    for key in ("api", "environment", "workerEnvironment"):
        assert len(expected[key]) <= 32
    for key in ("worker", "maintenance"):
        assert len(expected[key]) < 32

    found = set()

    def check(template):
        variables = template.get("variables", {})
        for resource in template["resources"]:
            kind = resource["type"]
            if kind == "Microsoft.Resources/deployments":
                name = arm_value(resource["name"], variables, parameters=values)
                assert name in expected.values()
                check(resource["properties"]["template"])
            elif kind == "Microsoft.Network/privateEndpoints":
                assert resource["name"].endswith(".endpointName]")
                services = arm_value(variables["privateServices"], variables, parameters=values)
                assert [service["endpointName"] for service in services] == [
                    expected[f"{service}Endpoint"] for service in ("blob", "queue", "table", "registry")
                ]
                assert [service["dnsLinkName"] for service in services] == [
                    expected[f"{service}DnsLink"] for service in ("blob", "queue", "table", "registry")
                ]
            elif kind == "Microsoft.Authorization/roleDefinitions":
                assert (
                    arm_value(resource["properties"]["roleName"], variables, parameters=values)
                    in expected.values()
                )
            elif (
                not resource.get("copy")
                and "." in resource["name"]
                and kind.count("/") == 1
                and not kind.startswith("Microsoft.Authorization/")
            ):
                name = arm_value(resource["name"], variables, parameters=values)
                assert name in expected.values(), (kind, name)
                found.add(name)
                if kind == "Microsoft.Network/virtualNetworks":
                    assert [
                        arm_value(subnet["name"], variables, parameters=values)
                        for subnet in resource["properties"]["subnets"]
                    ] == [expected["workerSubnet"], expected["privateEndpointSubnet"]]

    check(compiled_template)
    for key in (
        "adminGroup",
        "netGroup",
        "appGroup",
        "dataGroup",
        "runtimeIdentity",
        "workerIdentity",
        "registry",
        "storage",
        "api",
        "worker",
        "maintenance",
        "environment",
        "workerEnvironment",
        "logs",
        "alerts",
        "processingAlert",
        "backlogAlert",
    ):
        assert expected[key] in found


@pytest.mark.parametrize("value", ["", "Prod", "1prod", "pro-d", "prod_1", "toolongname1", "prod\n"])
def test_naming_cli_rejects_invalid_tokens(value):
    make_names = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "azure_names.py"))[
        "resource_names"
    ]
    with pytest.raises(ValueError):
        make_names(value, "pdfportal")
    with pytest.raises(ValueError):
        make_names("prod", value)


def test_naming_cli_rejects_environment_that_would_exceed_job_name_limit():
    make_names = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts" / "azure_names.py"))[
        "resource_names"
    ]
    with pytest.raises(ValueError, match="env must be 1–5"):
        make_names("abcdef", "abcdefgh12")
