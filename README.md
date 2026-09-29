<img src="docs/images/hero.svg" alt="PDF Validation Portal: catch accessibility problems before a PDF goes public. 2 standards checked, 200 files per batch, at most 5 minutes per standard, auto-deleted after 72 hours." width="100%">

**Bottom line:** staff drop in PDFs and, within minutes, see whether each one meets **PDF/UA-1** and **WCAG 2.2**, which rule every problem breaks, and where it is in the document. Files stay private to the person who uploaded them and are deleted after 72 hours.

> [!WARNING]
> **A pass is not a sign-off.** Automated checks do not establish full accessibility or WCAG conformance. Manual review is required. This service does not remediate documents.

## FAQ

<details>
<summary><b>Is our content safe?</b></summary>

Staff sign in with Microsoft Entra ID and see only their own documents. PDFs upload straight into private Azure storage with a short-lived grant for that one file, and an exact copy is frozen before it is checked. Everything becomes inaccessible after 72 hours; users can delete it sooner. [How it works →](docs/how-it-works.md#security)
</details>

<details>
<summary><b>How much can it handle?</b></summary>

Up to 200 files (2 GiB) per upload from the browser, 200 MiB per file. By default four validations run at once, each in its own isolated job, with a five-minute limit per standard. [Capacity →](docs/how-it-works.md#performance-and-capacity)
</details>

<details>
<summary><b>Can other systems use it?</b></summary>

Yes. The portal itself uses the same versioned API that approved integrations call. See the [API guide](docs/api.md), the [PHP SDK](sdk/php/README.md), the [Python client](scripts/validate.py), and [external client setup](docs/azure-api.md).
</details>

<details>
<summary><b>What does it take to deploy?</b></summary>

An Azure subscription and Entra ID. A GitHub Actions workflow provisions Azure Container Apps, Storage and monitoring, then deploys. Creating this project provisions nothing by itself. [Azure resources →](docs/how-it-works.md#azure-resources) · [Deploy to Azure →](docs/azure-ci.md)
</details>

## Go deeper

| Role | Documentation |
|---|---|
| Staff | [Using the portal](docs/user-guide.md) |
| Architect | [How it works](docs/how-it-works.md) |
| Tech Support | [Tier 1 support runbook](docs/runbook-tier-1.md) |
| DevOps | [Tier 2 runbook and onboarding](docs/runbook-tier-2.md), [Deploy to Azure](docs/azure-ci.md), [Manual setup guide](docs/azure-manual.md) |
| Developer | [Onboarding and knowledge transfer](docs/development-onboarding.md), [Development and testing](docs/development.md), [API guide](docs/api.md) |
| Integration Developer | [API guide](docs/api.md), [Azure API client setup](docs/azure-api.md), [PHP SDK](sdk/php/README.md) |
| Identity Administrator | [Entra and deployment setup](docs/azure-ci.md), [API client permissions](docs/azure-api.md) |
| Security Reviewer | [Open security findings and TODOs](docs/security-todo.md), [How it works](docs/how-it-works.md) |
