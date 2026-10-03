"""Render the Azure naming map shared with Bicep; no Azure calls are made."""

import argparse
import json
from pathlib import Path
import re
import shlex

NAME_MAP = Path(__file__).resolve().parents[1] / "infra" / "names.json"
COMPACT_NAMES = {"registry", "storage"}
SHELL_KEYS = {
    "adminGroup": "ADMIN_RESOURCE_GROUP",
    "netGroup": "NET_RESOURCE_GROUP",
    "appGroup": "APP_RESOURCE_GROUP",
    "dataGroup": "DATA_RESOURCE_GROUP",
    "api": "API_NAME",
    "worker": "WORKER_NAME",
    "maintenance": "MAINTENANCE_NAME",
    "foundationDeployment": "FOUNDATION_DEPLOYMENT",
    "portalDeployment": "PORTAL_DEPLOYMENT",
}


def resource_names(env: str, project: str) -> dict[str, str]:
    for label, value, limit in (("env", env, 5), ("project", project, 10)):
        if not re.fullmatch(rf"[a-z][a-z0-9]{{0,{limit - 1}}}", value):
            raise ValueError(f"{label} must be 1–{limit} lowercase letters/digits, beginning with a letter")
    suffixes = json.loads(NAME_MAP.read_text())
    names = {key: f"{env}-{project}-{suffix}" for key, suffix in suffixes.items()}
    return {key: value.replace("-", "") if key in COMPACT_NAMES else value for key, value in names.items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env", default="prod")
    parser.add_argument("--project", default="pdfportal")
    parser.add_argument("--format", choices=("json", "shell"), default="json")
    args = parser.parse_args()
    try:
        names = resource_names(args.env, args.project)
    except ValueError as error:
        parser.error(str(error))
    if args.format == "json":
        print(json.dumps(names, indent=2))
    else:
        for key, shell_key in SHELL_KEYS.items():
            print(f"{shell_key}={shlex.quote(names[key])}")


if __name__ == "__main__":
    main()
