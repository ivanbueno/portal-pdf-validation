# Proposed policy: governed Azure deployment and support readiness

[← Project overview](README.md)

**Status: draft for Enterprise Architecture review.** This document proposes controls for the PDF Validation Portal; it is not an adopted organizational policy, deployment authorization, or evidence that controls are already enforced. Existing organizational requirements remain in effect. Enterprise Architecture (EA), Security, Operations, and the service owner must approve the completed adoption record below.

## 1. Recommended decision

**Authorize a bounded, supervised Azure pilot after the entry conditions are met.** Use it to establish an approved Infrastructure as Code pattern and demonstrate support readiness before a wider rollout. Approve the initial pattern for this workload; broader organizational adoption requires a separate decision.

The concerns about governance and support capacity are reasonable. This proposal addresses them with named ownership, reviewed changes, limited permissions, practical training, and evidence of recovery. It does not assume that documentation alone makes a service supportable.

Infrastructure as Code (IaC) means keeping the intended Azure configuration in version-controlled files. Here, those files use Microsoft's Bicep language. With the controls below, each infrastructure change has an author, a reviewable difference, test evidence, approval, and a deployment record. EA can review the intended outcome and risk without every architect or support analyst becoming a Bicep author.

**Tech Support's initial responsibility is to recognize impact, perform documented checks, collect evidence, and escalate.** Platform engineers own infrastructure changes; developers own application defects. The delivery team retains technical ownership through the pilot and handover. If there is no qualified engineering escalation route, fund one internally or through a contracted service before live use.

Azure managed services fit the existing application and reduce the need to operate underlying servers. Our organization still owns its application, access configuration, costs, and incident response. A managed VM would also require these responsibilities, plus a defined owner for container operations and replacement of the current authentication integration. It does not remove the need for governance or technical escalation.

## 2. Scope and proposed approval boundary

The pilot covers the portal's Azure Container Apps, validation and maintenance jobs, registry, storage, managed identities, monitoring, and associated Entra sign-in configuration. Inventory the exact subscription, resource groups, region, repository, and identities in the approval record.

Use separate approved production and non-production resource groups and deployment identities. Non-production must use approved test documents and accounts. Production document data must not be copied into training or testing by default. Review shared dependencies explicitly; resource-group separation alone does not establish complete isolation.

EA approves the resource types, regions, network exposure, data classification, capacity envelope, and operating model. The application currently uses public HTTPS endpoints with access controls; private networking is not established by its templates. EA must accept that design for the approved data or require changes before live use.

**Proposed pilot term:** six weeks, with a recorded end date and spending ceiling. At expiry, approve continued operation explicitly or stop new submissions through an approved procedure, notify users, and complete the retention obligations. Do not delete the resource group to end a pilot. An existing production service requires a transition plan; adoption of this draft must not itself interrupt users.

## 3. Ownership and support responsibilities

Assign named primary and backup contacts, not just team names. One person may perform several roles in a small team, but a change author must not be their own sole production approver.

| Role | Accountability and permitted work |
|---|---|
| Executive sponsor / service owner | Funds the service, defines business hours and service targets, accepts business risk, appoints owners, and decides whether the pilot continues |
| Enterprise Architecture | Approves the infrastructure pattern and material exceptions; reviews evidence and changes outside the approved boundary |
| Security and identity owners | Approve data handling and access design; manage identity, credential, and security-incident decisions |
| Platform / DevOps owner (Tier 2) | Owns Bicep, deployment workflow, platform diagnosis, monitoring, cost controls, and approved recovery; maintains a qualified backup |
| Application engineering (Tier 3) | Owns code, validator dependencies, defects, data compatibility, and application recovery; remains available to Tier 2 |
| Tech Support (Tier 1) | Performs documented read-only triage, guides users, opens sanitized tickets, communicates status, and escalates; does not need to author Bicep or debug application code |
| Accessibility lead | Interprets findings and defines the human review process; distinguishes document nonconformance from a product incident |
| Change approver | Authorizes the exact release and impact window after checking evidence; independent of the change author |

Use the existing [Tier 1 runbook](docs/runbook-tier-1.md), [Tier 2 runbook](docs/runbook-tier-2.md), and [developer onboarding guide](docs/development-onboarding.md). This allocation follows the principle of explicit cross-team responsibilities in Microsoft's [Cloud Adoption Framework](https://learn.microsoft.com/en-us/azure/cloud-adoption-framework/organize/raci-alignment).

## 4. Minimum Infrastructure as Code controls

The following requirements become mandatory only when adopted. The gap register in Section 8 identifies what still needs implementation or verification.

### 4.1 Approved source and changes

- Store Bicep, deployment workflows, non-secret configuration, and operational instructions in the approved repository. Protect the release branch against direct unreviewed changes and restrict who can change those protections.
- Require a pull request and an independent qualified review. Changes to infrastructure and deployment workflows require the platform owner; access or security changes also require the Security/identity owner. Require EA approval for changes outside the approved architecture boundary.
- Record the purpose, affected resources, expected user impact, data implications, estimated cost impact, verification, and recovery plan. A plain-language summary accompanies infrastructure changes.
- Keep secrets out of source, logs, screenshots, and review artifacts. Record secret names and rotation ownership, never values. Protect release evidence because it can reveal infrastructure and identity details.
- Pin release inputs sufficiently to reproduce and identify a release. Record the source commit and container digest; retain approved recovery images. A source-based image tag is not proof that rebuilding it produces identical bytes.

### 4.2 Review before production mutation

The approved deployment path is GitHub Actions **Deploy Azure**, consistent with the [deployment guide](docs/azure-ci.md). Manual provisioning is limited to documented bootstrap work or the emergency procedure below. A workflow being manually started does not itself prove that the deployment is approved.

Before the first production-changing step, the release process must:

1. Verify the exact approved commit and passing required **Verify** checks; failed, skipped, or missing required evidence blocks release.
2. Compile and validate the templates, run relevant security checks, and produce a Bicep **what-if** preview against the intended environment. Include changes to the foundation, application, access, configuration, and web container.
3. Attach the preview and a plain-language explanation to the change record. The qualified reviewer resolves unexpected deletion, replacement, permission expansion, or network exposure before approval.
4. Obtain an independent production approval after the evidence is available. Restrict allowed deployment refs and prevent self-approval and unrecorded bypass. Verify that the repository's plan and settings support the chosen controls; otherwise implement an equivalent enforced gate.
5. Deploy the reviewed commit, artifact, and parameters. Changes after approval invalidate it. Refresh the preview if the target environment changes materially before deployment.

What-if predicts changes; it can miss or be unable to evaluate some resources. Document unresolved output and use qualified review and non-production validation rather than treating an incomplete preview as a pass. First provisioning may require staged previews as hostnames and dependencies become available; review newly known material changes before the next stage. See [Microsoft's what-if guidance and limitations](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deploy-what-if).

### 4.3 Deployment identity and guardrails

- Authenticate automation using restricted GitHub-to-Azure federation, avoiding a long-lived deployment password. Bind trust to the approved repository/environment and restrict who can run or edit the trusted workflow.
- Scope permissions to the approved resources. Human support receives read access by default, with separately approved access to logs or document data. Do not give Tier 1 Contributor or Owner merely to view health.
- Review the deployment identity's ability to assign roles. The current setup grants resource-group Contributor and Role Based Access Control Administrator; that is powerful access, not automatically an acceptable permanent baseline. Prefer constrained role assignment or a separately controlled privileged stage. Record an approved, time-limited exception if narrower access cannot yet support deployment.
- Keep deployment and runtime identities separate; reduce runtime permissions by component where required by the security review. Review access at pilot entry and exit, after role changes, and quarterly thereafter if the policy is adopted.
- Have the central platform team apply approved Azure Policy assignments for supported controls such as locations, resource types, tags, and security settings. Test policy effects in non-production. Enforce critical validated restrictions with deny controls; track remaining audit findings with owners and deadlines.

Azure Policy evaluates resource configuration, while role-based access controls who may act. Neither replaces repository and release approval. Not every application setting is enforceable through Azure Policy, so document compensating checks. [Microsoft's Azure Policy overview](https://learn.microsoft.com/en-us/azure/governance/policy/overview) explains this distinction. Application deployers must not be able to remove central guardrails or approve their own policy exemptions.

### 4.4 Deployment, drift, and recovery

- Serialize production deployments. Use the approved deployment mode; prohibit complete-mode deletion, resource-group deletion, and bulk data destruction as routine releases. Incremental deployment still changes existing settings and must be reviewed.
- Verify sign-in, authorized and unauthorized access, upload, validation, reports, deletion, and job progress using approved accounts and non-sensitive fixtures. A successful readiness probe is insufficient. Assign an observation window and an owner who can stop or recover a failed release.
- Check for partial changes after failure. The workflow updates the API, jobs, and shared infrastructure; an API-only rollback may leave incompatible components. Follow the [Tier 2 release and recovery procedure](docs/runbook-tier-2.md#8-releases-failed-deployments-and-rollback).
- Test recovery in non-production. A previous commit or image is a recovery candidate, not a data backup; do not promise that redeployment restores deleted documents.
- Review configuration drift weekly during the pilot and after emergency changes. Investigate differences before correcting them through a reviewed change. Do not automatically overwrite live differences without understanding their purpose.
- Retain access-controlled change approvals, previews, test evidence, release identity, and deployment records for a proposed minimum of 12 months, subject to organizational records policy. Keep document contents and secrets out of these records; this evidence retention does not extend PDF retention.

## 5. Change classes and emergency access

| Class | Proposed route |
|---|---|
| Initial deployment or material change | EA and relevant Security/identity approval, platform review, passing evidence, and independent release approval. Includes new services/regions, identity privileges, public exposure, retention changes, or capacity outside the approved envelope. |
| Routine release within the approved pattern | Qualified peer review and independent release approval through the pipeline; no new architecture board review unless the approved boundary changes. App-only releases still require infrastructure preview while the workflow reapplies infrastructure. |
| Catalogued standard operation | Only an operation separately pre-approved in a written catalog, with exact scope, trained role, stop conditions, and evidence requirements. No production-changing operation is pre-approved merely by adopting this draft. |
| Emergency recovery | Named incident lead authorizes minimum necessary action under the organization's emergency-access process. Record actor, reason, scope, time, and evidence. Reconcile configuration into source, review access, and complete a retrospective by the next business day or document the approved extension. |

Emergency access must be named, time-limited, logged, and reviewed. Do not use it to normalize approval bypass, turn off authentication, enable development identity, or guess at document-state repairs. Security incidents follow the organization's incident-response authority. Tier 1 continues evidence collection and communication; it does not inherit emergency administrator duties.

## 6. Support readiness: teach the required work and demonstrate it

**Training is funded delivery work, and handover is conditional on demonstrated competence.** The application team must not declare a service supported by sending Tech Support a link to the repository.

| Stage | Proposed activity | Acceptance evidence |
|---|---|---|
| Orientation | Two short guided sessions on the user journey, Azure resource map, access boundaries, and incident routing | Staff can distinguish a PDF validation failure, a processing error, a sign-in problem, and an outage |
| Tier 1 practice | Mentor-led triage using the runbook and sanitized scenarios; practice collecting a request ID, checking health, and finding deployment history | At least two named analysts complete the scenarios, create useful tickets, and escalate without unauthorized changes |
| Tier 2 practice | Non-production deployment, queue-stall diagnosis, authentication failure, failed-release investigation, and compatible recovery | Primary and backup operators demonstrate the approved workflow, stop criteria, recovery checks, and evidence capture |
| Engineering continuity | Developer walkthrough, dependency maintenance, application diagnosis, and compatibility assessment | Named primary and backup engineering contacts; documented access and escalation route |
| Supervised service | Delivery engineers lead the first two supported pilot weeks; Tech Support shadows, then leads triage with engineers immediately available during agreed hours | Mentor and support lead sign off capability, access scope, remaining gaps, and funded coverage |

Session counts are planning proposals, not proof of proficiency. Extend training or narrow duties where a gap remains. Do not require cloud certification as a substitute for these demonstrations, and do not require Tier 1 to learn Bicep authoring.

Before live use, complete runbook placeholders: owners, subscription, resource names, staging environment, alert recipients, escalation contacts, support hours, severity definitions, credential rotation, Azure support plan, and authorized case opener. Test the escalation route with primary and backup contacts.

**Proposed pilot coverage:** staffed business hours explicitly stated with time zone. Publish out-of-hours handling; do not imply 24/7 coverage. During staffed hours, target acknowledgement of widespread outage or suspected data exposure within 15 minutes and engage the incident lead, Tier 2, and Security as appropriate immediately. The service owner must fund and accept these proposed targets before they are promised. Recovery targets and acceptable data loss require separate approval and rehearsal evidence.

At every handover, document what Tech Support owns and what engineering continues to own. If no qualified backup or escalation coverage is available, postpone expansion, retain delivery-team support, or fund an approved support partner.

## 7. Operating, data, and cost controls

- **Monitoring:** before live use, test alert delivery to a staffed route and demonstrate detection of API failure, stalled processing, maintenance failure, and authentication problems. Review health, backlog, cleanup freshness, credential expiry, and cost each supported day during the pilot. An empty log or absent alert is not evidence of health.
- **Data:** approve document classifications and who may inspect contents. Keep credentials, signed upload links, and customer PDFs out of ordinary tickets. Preserve the documented 72-hour document/report retention design; any backup, soft-delete, or log configuration that retains content longer requires explicit review and updated user information.
- **Recovery:** agree recovery time and acceptable data loss with the business. The templates do not provision document backups or a multi-region recovery design. If those are requirements, design and test them before claiming that service level. Otherwise record that affected users may need to resubmit documents.
- **Security:** assign and resolve production-blocking findings in the [security backlog](docs/security-todo.md). Other residual risks require named acceptance, compensating controls, and expiry. Managed Azure hosting does not close application or authorization findings automatically.
- **Cost:** assign a budget owner, approved capacity envelope, and usage restrictions. Proposed alerts at 50%, 80%, and 100% of the pilot budget trigger review, intervention, and the approved pause decision respectively. Alerts are not hard spending caps; infrastructure may keep accruing charges. Define how to limit new work while maintaining security, cleanup, and required service continuity.
- **Maintenance:** fund dependency updates, image rebuilding/scanning, credential rotation, and a monthly service review. Test relevant changes before release and review urgent vulnerabilities through the incident/change process.

## 8. Current foundation and adoption gaps

This is a repository review, not a live Azure or GitHub settings audit. A workflow definition or runbook does not prove the corresponding control is enabled or staffed.

| Control area | Evidence already present | Required next step / proposed owner |
|---|---|---|
| Repeatable configuration | [Bicep foundation](infra/foundation.bicep) and [application template](infra/main.bicep) | EA approves the baseline and permitted variations; platform owner inventories the deployed state |
| Verification | [Verify workflow](.github/workflows/ci.yml) defines application, browser, emulator, and Bicep checks | Platform owner verifies current passing evidence and enforces the exact-commit gate before deployment |
| Production deployment | [Deploy Azure workflow](.github/workflows/deploy.yml) uses federation, a production environment, and serialized runs | Repository administrator verifies protected refs, independent reviewers, bypass restrictions, and federation scope; these settings are not established by YAML alone |
| Infrastructure preview | No what-if step appears in the current deployment workflow; foundation provisioning occurs before image build | Platform owner adds preview and review gates before infrastructure mutation, covering every deployment stage |
| Test environment | Runbooks identify staging as unresolved; the deployment workflow targets one production environment | EA and platform owner approve a separate test environment and its deployment path |
| Privileged access | Setup documents specify Contributor plus role-assignment administration at resource-group scope | Identity/security owners approve constrained permissions or a documented temporary exception; review component runtime permissions |
| Release recovery | Source-based image tags and recovery instructions exist; workflow rebuilds releases | Platform and engineering owners capture digests, retain recovery artifacts, and implement/test an approved reproducible recovery path |
| Security and policy | Security findings are documented; central policy assignments are not demonstrated here | Security resolves blocking issues; central platform team verifies applicable policy assignments and exemptions |
| Support | Detailed Tier 1/Tier 2 runbooks and onboarding exercises exist | Support lead fills ownership/coverage gaps and records primary/backup competency sign-off |
| Service evidence | [Verification record](docs/verification.md) distinguishes local testing from unverified cloud behavior | Service owner obtains current cloud sign-in, access, scaling, alert, retention, recovery, and cost evidence |

## 9. Approval gates and review record

**Gate A: controlled engineering evaluation:** approve the architecture boundary, named owners, non-production environment, budget, restricted identities, and repository controls. Use non-sensitive test data. This does not authorize live users or production document processing.

**Gate B: limited live pilot:** demonstrate the release gates and support escalation path; close blocking security items; validate cloud authentication, document isolation, workflow, retention, alerts, and recovery. Approve service targets, data classifications, staffing, residual risks, and a named cohort. Delivery engineers retain support ownership during supervised operation.

**Gate C: ongoing service:** EA, Security, the service owner, and support lead review pilot evidence. Transfer only the duties staff have demonstrated and accepted. Continue, narrow, extend with explicit funding, or stop using the approved exit procedure. A missed deadline does not grant automatic approval.

Copy this record into the organization's approval system:

| Required decision | Value to complete before the applicable gate |
|---|---|
| Policy owner, version, adoption date | Named EA owner; approved version and date |
| Service owner and executive sponsor | Names and funded responsibilities |
| Scope | Repository; subscription; production/non-production resource groups; region; identities; approved network exposure |
| Data and service boundary | Permitted documents/users; retention; support hours/time zone; response and recovery targets; acceptable data loss |
| Technical and support contacts | Primary/backup platform engineers, developers, Tier 1 analysts, identity/security owners, incident lead, and vendor support route |
| Cost commitment | Approved ceiling, cost center, capacity/usage limits, alert recipients, and authorized intervention procedure |
| Evidence | Change-control settings, access review, preview sample, release/test records, security disposition, alert and recovery exercises, and training sign-offs |
| Exceptions | Requirement, reason, risk owner, compensating control, expiry, and closure plan; no self-approved exception |
| Decision | Gate approved or rejected; conditions; named approvers and date |
| Next review and exit | Pilot end date; review meeting; transition/pause owner and procedure |

The requested approval is therefore specific: permit a governed Azure pilot with engineering support retained, observable controls, and an explicit readiness decision before wider support handover. Enterprise Architecture gains a reusable starting pattern, and Tech Support gains bounded duties and a tested escalation route.
