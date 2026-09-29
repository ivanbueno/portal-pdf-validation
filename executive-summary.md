# Turn 8 million pages of experience into a repeatable accessibility service

[← Project overview](README.md)

## Executive brief — one page

**Recommendation: sponsor a six-week pilot of our internal PDF accessibility validation platform on Azure managed infrastructure, benchmarked against paid alternatives.** Invest in turning our operational experience into a repeatable service, and purchase commercial capabilities where they demonstrate additional value. Release further funding only when the pilot establishes quality, operational readiness, and a credible financial case.

**Our advantage begins with experience: 400,000 PDF documents, totaling 8 million pages.** These organization-supplied figures describe documents our team has processed; they do not mean those documents passed accessibility review or were processed by this new portal. That experience gives us firsthand knowledge of document variability, difficult cases, and workflow bottlenecks. It can guide representative testing, clearer reports, and better prioritization. It supports our ability to build a useful service, without establishing superiority over every vendor.

**We have a working foundation.** Staff can submit PDFs, run automated accessibility checks, and inspect reports identifying potential problems. The portal organizes validation around existing checking software, veraPDF; our investment is in the service and workflow around it. Automated validation supports human review and remediation. It does not fix documents or establish full accessibility.

**At our scale, paid services should earn their cost through demonstrated value.** Depending on the product, licenses, usage fees, page-based charges, integration, and support can become material. Our alternative also has costs: development, hosting, maintenance, security, staff support, and time diverted from other priorities. Compare the full cost of equivalent outcomes, including human review and correction. Historical processing volume is evidence of experience, not an annual demand forecast. Savings remain a hypothesis until we have current quotes, measured staff effort, and a credible forecast.

**An evolving market rewards careful selection.** AI-assisted PDF accessibility workflows are developing, and suitability depends on document types and required outcomes. Commercial auto-tagging is already available; that capability differs from this portal's validation role. A premium price alone does not establish the best fit for our documents. Our strategy should preserve the option to combine internal validation with specialist commercial remediation. [Adobe's auto-tagging overview](https://developer.adobe.com/document-services/docs/overview/pdf-accessibility-auto-tag-api/gettingstarted) illustrates that complementary capability.

**Own the workflow and use Azure to reduce infrastructure work.** Azure Container Apps, Storage, and monitoring fit the existing implementation and let us focus effort on document workflows. A managed VM introduces authentication changes and additional deployment and recovery work; copying the development setup is insufficient. Moving containers alone also retains Azure storage dependencies. Azure still requires application maintenance, security work, support, and cost controls, but it is the stronger starting point for this pilot.

**The decision requested:** appoint an executive sponsor and fund a capped pilot with engineering, accessibility, operations, and procurement participation. Compare the same representative documents across internal, commercial, and hybrid approaches. Expand only if quality and operational requirements are met and measured cost or workflow benefits justify continued ownership.

## Compare outcomes and responsibilities

| Approach | Business value | Cost and responsibility | Evidence needed |
|---|---|---|---|
| Internal | Control over validation workflow, integration, and priorities | Development and integration; hosting, security, maintenance, support, and continuity remain ours | Useful findings, staff time, operating reliability, and full ongoing cost |
| Commercial | Purchased capabilities and contracted support; some products also remediate | Licenses or usage charges, integration, review, and vendor management; responsibilities depend on contract | Current quotes, actual capabilities on our documents, service terms, and remaining manual work |
| Hybrid | Internal validation with purchased capabilities for selected needs | Internal operating costs plus selected vendor spend and handoff overhead | Whether additional benefits outweigh combined costs and workflow complexity |

Compare validation with validation. When a vendor also offers correction, include equivalent correction effort in the internal option. A lower validation bill alone does not establish a cheaper end-to-end accessibility workflow. Adobe's [licensing documentation](https://developer.adobe.com/document-services/docs/overview/pdf-extract-api/dcserviceslicensing) provides one example of transaction- and page-based charging; it is not a quote or evidence that all services are expensive.

## Why Azure managed infrastructure is the preferred deployment

**Our recommendation is to deploy on the Azure services this application already targets.** A VM can support a production service, including when hosted in Azure, but selecting one for this portal creates additional implementation and operating work. The business case is to spend scarce team capacity on accessibility outcomes while using managed services for common infrastructure needs.

| Decision factor | Azure managed services | Containers on a managed VM |
|---|---|---|
| Fit with the application | Existing deployment templates connect sign-in, storage, processing jobs, and monitoring | Replace the current sign-in boundary and adapt deployment; Azure storage remains unless separately replaced |
| Operating responsibility | Platform manages underlying compute; our team owns application updates, configuration, access, and incidents | Confirm exactly what the VM provider manages; Docker, application scheduling, deployment, and recovery may still need team ownership |
| Capacity | Current design scales the web service separately from validation jobs, with configured concurrency limits | A single VM shares finite resources across services; extra capacity and multiple-host coordination need a plan |
| Resilience and visibility | Existing health checks, queued jobs, scheduled cleanup, logs, and alert definitions provide a foundation to verify | Recreate or integrate equivalent controls and test recovery; a single VM remains a host-level failure point |
| Cost | Measure compute, storage, requests, registry, logs, networking, and staff effort | Measure VM and disk costs, management fees, any retained Azure services, staff effort, and recovery capacity |

**Use capacity when documents need it.** The current worker configuration permits zero active executions when idle and up to four when work is queued. Azure supports [event-driven processing jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs). This fits intermittent workloads without reserving a dedicated worker VM for the peak. It does not make the service free while idle: the web service keeps at least one instance, and storage, registry, monitoring, and other charges still apply. Evaluate the full [Azure billing model](https://learn.microsoft.com/en-us/azure/container-apps/billing), not only worker compute.

**Keep identity and operations aligned with the existing design.** Azure supplies platform security capabilities, including managed identities for service access, which the application already uses. This avoids building replacement infrastructure solely to move hosts. An Azure VM can also use managed identity, so that feature alone does not decide the comparison. [Microsoft's security overview](https://learn.microsoft.com/en-us/azure/container-apps/security) describes the managed platform capabilities.

**Budget for a service, not just a server.** A smaller VM invoice is not sufficient evidence of lower total cost. Include the authentication migration, operating labor, monitoring, recovery, and the opportunity cost of diverting the team. Conversely, steady workloads and an established VM operations service may favor a VM financially. Use that as a cost comparison during the pilot; a second deployment is unnecessary unless evidence justifies it.

Azure is the recommended starting point, not a guarantee of savings or availability. The current templates do not establish multi-region recovery, and managed hosting does not resolve the [open application security findings](docs/security-todo.md). Verify the required service level and close production-blocking gaps before live use. Azure budgets and alerts support oversight; they are not hard spending limits, so pair them with usage controls and a named cost owner.

## What we know, assume, and need to establish

| Evidence status | Claim and treatment |
|---|---|
| Supplied organizational facts | The team processed 400,000 documents / 8 million pages and reports substantial operational experience. Confirm the reporting period and supporting records before external use. These figures are not portal benchmarks or verified accessibility outcomes. |
| Documented implementation | Submission, automated checks, reports, and Azure deployment are described in [How it works](docs/how-it-works.md). Consult the [verification record](docs/verification.md) and [open security findings](docs/security-todo.md) for limits; existing code is not proof of production readiness. |
| Planning assumptions | A six-week Azure pilot, the proposed staffing below, and a representative sample can establish enough evidence for a decision. Azure's existing integration is expected to reduce implementation work relative to a VM migration. These are proposals and a design-based inference, not delivery estimates or approved allocations. |
| Claims requiring evidence | Lower total cost, less manual effort, better adoption, sufficient capacity, and competitive finding quality must be demonstrated. No savings percentage, break-even date, or market leadership claim is established. |

## Fund a bounded pilot with a decision at the end

**Proposed authorization:** one executive sponsor; one engineer for six weeks; operations/security and accessibility specialists each allocated one-quarter time for six weeks; and procurement/finance support for quotes and costing. Authorize a dedicated Azure pilot environment with a named service and cost owner. Finance should set an explicit spending ceiling before kickoff using loaded staff costs, Azure hosting, vendor evaluation fees, and contingency. This is a request for a fixed evaluation commitment, not approval for an indefinite rollout.

1. **Weeks 1–2: establish the baseline and readiness.** Select a proposed 500-document sample spanning common documents, scans, complex tables, forms, long files, and known difficult cases. Include accessibility-reviewed examples with known issues and examples expected to pass particular checks. Confirm permission to use documents with any vendor. Obtain current quotes for at least two relevant paid alternatives where available. Agree numerical quality, workload, recovery, adoption, and budget targets before measurement. Address production-blocking security findings and validate access, retention, recovery, and support arrangements before admitting live users.
2. **Weeks 3–5: run a limited production pilot if readiness criteria are met.** Use a named staff cohort and the same source documents and evaluation scope across options. Record findings and human effort; include repeat runs, failures, and difficult documents. Have accessibility specialists adjudicate findings and missed known issues against a common rubric. Measure validation separately from any additional vendor remediation. If readiness is not achieved, report that result and keep evaluation in a controlled environment.
3. **Week 6: make the investment decision.** Deliver a scorecard, a forecast based on expected future volume, a named service owner, and a recommendation to expand, adopt a hybrid approach, buy a service, or stop. Do not extend spending automatically.

| Measure | Evidence for the decision |
|---|---|
| Total cost | Actual pilot spending; forecast annual fixed and variable costs at low, expected, and high volumes; cost per document and page, including labor, integration, support, and rechecks; compare measured Azure costs with a fully costed VM alternative |
| Useful findings | Specialist-confirmed actionable findings, false alarms, and missed known issues, broken down by document type and severity |
| Manual effort | Time to interpret results, review, correct, and recheck equivalent documents; report correction work separately |
| Throughput | Documents and pages processed per hour, typical and slow-case turnaround, and behavior during an agreed peak workload |
| Reliability | Processing errors, queue delays, successful recovery, access controls, and verified retention behavior |
| Staff adoption | Completion of assigned workflows, repeat use, support requests, and feedback from the pilot cohort |

**Expansion gate:** meet the agreed quality and operational thresholds, remain within the approved cap, and demonstrate either lower forecast total cost for equivalent outcomes or a quantified workflow benefit worth any premium. Name and fund an ongoing owner and backup. If a paid or hybrid option performs better against those criteria, choose it. If none meets them, pause rollout and report the remaining gaps.

## Five stakeholder objections

1. **“Why build when we can buy?”** Buy when the capability and service justify the total cost. We already have a validation foundation and substantial document experience. A bounded comparison tests whether that foundation offers better value and where a vendor adds capabilities we lack.
2. **“Will internal maintenance erase the savings?”** It could. Include loaded staff time, security work, upgrades, support, incident recovery, and opportunity cost. Count existing development as historical investment; base the decision on future costs and benefits. Do not treat internal labor or existing VM capacity as free.
3. **“Does a passing report mean the document is accessible?”** No. Automated checks cover only part of the work. Human review, including assistive-technology checks where appropriate, and remediation remain necessary. The portal reports findings; it does not certify compliance or repair documents.
4. **“Why pay for Azure services when we already have a managed VM?”** Existing VM capacity may be economical, but this application already uses Azure sign-in, storage, jobs, and monitoring. Moving it adds authentication and operating work and may retain Azure charges. Prefer the existing Azure design to focus effort on the service, and compare full costs during the pilot. Both options require security fixes and verified recovery; managed hosting alone does not establish readiness.
5. **“What if a better commercial tool appears or our key people leave?”** Preserve exportable results and documented integrations, review paid options periodically, and fund documentation and backup ownership. Keep the ability to replace or supplement the checking workflow as requirements and tools change.

## 90-second verbal pitch

Our team has processed 400,000 PDF documents—8 million pages. That is experience with real documents, difficult cases, and the work it takes to manage them. It is not a claim that every page is accessible. It is a strong foundation for building a better service.

We have developed a portal that lets staff submit PDFs, run automated accessibility checks, and understand the findings. It supports human review and correction; it does not replace them.

We recommend running it on Azure's managed services, which fit the existing design and reduce server operations work. A VM would add authentication and operating work that must be included in its cost.

Commercial products can add real value. Compare their fees and remaining manual work with our full development and operating costs. A high price is not proof of a better fit, and internal software is not free.

We are asking for an executive sponsor and a capped, six-week pilot. We will compare the same representative documents, measure useful findings, staff effort, cost, speed, reliability, and adoption, and address production readiness before live use.

At the end, we will recommend expansion, a hybrid approach, a paid service, or stopping. We should turn our experience into measurable value—and let the evidence determine where we invest.
