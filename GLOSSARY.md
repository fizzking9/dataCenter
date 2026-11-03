# Data Middle Office

The shared domain language for the self-contained, self-hosted data middle office deployed by a single business entity.

## Language

**Deployment**:
A single self-hosted installation operated by one business entity; the outermost scope for identities, Business Context, configuration, and data.
_Avoid_: Tenant, instance, account

**Workspace**:
A collaboration partition within a Deployment that scopes ownership and role assignments.
_Avoid_: Tenant, organization, department

**User**:
A human identity belonging to exactly one Deployment; every session, token, and action is bound to that Deployment.
_Avoid_: Service Identity, Agent Identity

**Role**:
A built-in set of permissions assigned to an actor at Deployment or Workspace scope.
_Avoid_: Custom role, arbitrary ACL

**Operator**:
A host-level actor with root-equivalent control who installs, upgrades, backs up, and restores a Deployment; fully trusted and outside the platform authorization boundary, not a platform User or Role.
_Avoid_: Deployment Administrator, global superuser

**Operator Console**:
A separately authenticated browser surface for an Operator's post-installation Deployment lifecycle work, distinct from platform User sessions and role-based navigation.
_Avoid_: Administrator dashboard, User settings

**Deployment Administrator**:
A User who manages deployment settings, workspaces, deployment-wide Business Context, and audit access without receiving implicit workspace content access.
_Avoid_: Tenant Administrator, Operator, Workspace Administrator

**Workspace Administrator**:
A User with full configuration, membership, and Artifact lifecycle control within an assigned Workspace.
_Avoid_: Workspace Editor, Consumer

**Consumer**:
An actor authorized to access published curated data products, reports, and their provenance metadata within an assigned Workspace.
_Avoid_: Workspace Administrator, deployment-wide reader, raw-data reader

**Artifact**:
A versioned configuration or governed data item belonging to exactly one Deployment and one accountable human Owner.
_Avoid_: Unowned resource, cross-deployment asset

**Artifact Version**:
An immutable, explicitly identified form of an Artifact; executions and governed results refer to exact Artifact Versions rather than an ambiguous latest state.
_Avoid_: Mutable configuration, unversioned Approval

**Model Profile**:
A versioned Deployment Artifact identifying an administrator-supplied inference endpoint, configured model identifier, API contract, credential reference, and supported generation purpose.
_Avoid_: Hard-coded provider catalog, Workspace credential, ambient model selection

**Model Binding**:
A Workspace-scoped configuration enabling an approved Model Profile for a permitted purpose and data-category set without exposing its credentials or provider settings.
_Avoid_: Workspace credential, Workspace provider endpoint, ambient model selection

**Artifact Proposal**:
An immutable review unit for one logical generated change, grouping exact candidate Artifact Versions and their evidence for all-or-nothing Approval.
_Avoid_: Unversioned LLM output, partially approved change

**Workspace Artifact**:
An Artifact belonging to exactly one Workspace, including its configuration, semantic definitions, and governed data products.
_Avoid_: Cross-workspace artifact, deployment-wide data product

**Deployment Artifact**:
Deployment Settings or common Business Context belonging directly to a Deployment and owned by an accountable Deployment Administrator.
_Avoid_: Tenant Artifact, system-workspace artifact, unowned deployment configuration

**Service Identity**:
A deployment-owned non-human principal for internal platform jobs, explicitly bound to the workspaces where it executes.
_Avoid_: Bot User, Agent Identity

**Agent Identity**:
A deployment-owned non-human principal for an external API or MCP actor with explicit Consumer grants.
_Avoid_: Bot User, Service Identity

**MCP Server**:
A read-only Consumer surface through which an Agent Identity discovers and queries governed data within one Workspace, using its own authority or the intersection of its authority with a delegated User’s.
_Avoid_: Administrative MCP channel, raw-data MCP channel, cross-workspace MCP session

**Owner**:
The User accountable for an Artifact; ownership does not itself grant operational permissions.
_Avoid_: Service owner, agent owner

**Business Context**:
The deployment-wide common definitions and additive workspace-private extensions used to interpret governed data, with Artifacts pinned to explicit common and workspace versions.
_Avoid_: Ambient context, workspace override, cross-workspace implicit reference

**Approval**:
A Workspace Administrator’s explicit acceptance of an exact Artifact Proposal, including all its candidate Artifact Versions and validation and preview evidence; human Approval is mandatory before publishing generated changes.
_Avoid_: Unversioned consent, autonomous LLM publication

**Audit Event**:
A record of a security-relevant action, including its actor, scope, target, outcome, and correlation; business-sensitive details remain Workspace-scoped and secrets are excluded.
_Avoid_: Mutable activity history, secret-bearing log

**Source**:
A Workspace Artifact identifying one logical dataset and its versioned acquisition configuration.
_Avoid_: Physical source system, monolithic connection, unowned dataset

**Acquisition Connection**:
A Workspace Artifact containing shared versioned endpoint metadata, credential reference, and acquisition policy for Sources in that Workspace belonging to one physical source system.
_Avoid_: Logical dataset, embedded secret, cross-workspace connection

**Integration Configuration**:
A versioned Source configuration binding stable record identity, an exact Dataset Schema, Cleaning Rule Set, source-to-dataset mapping, and common and Workspace Business Context versions.
_Avoid_: Ambient latest configuration, unversioned mapping, cleaning-based transport deduplication

**Dataset Schema**:
A versioned definition of the canonical fields and content shape of a Dataset, distinct from its source representation and Consumer-facing Data Product Contract.
_Avoid_: Data Product Contract, inferred mutable schema

**Cleaning Rule Set**:
A versioned set of governed rules used to validate and transform parsed source data into canonical Dataset content.
_Avoid_: Unapproved LLM rule, mutable cleaning logic

**Acquisition Run**:
One manual or scheduled request to acquire data from a Source, retaining its parameters, attempts, outcome, and provenance.
_Avoid_: Integration run, overwritten snapshot

**Acquisition Plan**:
The immutable set of pages, windows, or export fragments and exact Artifact Versions that one Acquisition Run attempt must use and complete before its result can become an Integration Batch.
_Avoid_: Partial batch, mutable request list, ambiguous latest configuration

**Raw Acquisition**:
The immutable uncurated bytes and associated provenance for one response, page, window, or export fragment produced by an Acquisition Run attempt; never part of the Consumer surface.
_Avoid_: Curated data, mutable landing file, merged raw export

**Integration Batch**:
The immutable handoff from one successful Acquisition Run to integration, linking its complete Acquisition Plan, raw data, source metadata, and exact configuration versions.
_Avoid_: Mutable handoff, curated dataset, partial acquisition

**Dataset**:
A Workspace Artifact containing canonical tabular records or documents produced from one Source under exact integration, schema, cleaning, and Business Context versions.
_Avoid_: Raw Acquisition, Data Product, cross-workspace dataset

**Dataset Release**:
An immutable, logically complete Workspace-scoped snapshot of a Dataset, inheriting its Source’s Owner and reconciling repeated acquisitions by stable record identity under explicit Artifact Versions.
_Avoid_: Mutable latest dataset, Acquisition Run, transport-driven duplicate record

**Data Product**:
A versioned Workspace Artifact defining a reusable Consumer-facing semantic model over one or more Datasets in that Workspace, supporting many authorized queries within its published contract rather than representing one saved query or result shape.
_Avoid_: Dataset, Raw Acquisition, saved query, cross-workspace data product

**Data Product Contract**:
The versioned Consumer-facing schema, semantic mapping, and supported query capabilities of a Data Product, explicitly separated from source representations and Dataset Schemas.
_Avoid_: Dataset Schema, source-derived implicit API, fixed query template

**Dimension**:
A field a Data Product Contract publishes for grouping its metrics by, so a Consumer can aggregate without restating the Dataset Schema.
_Avoid_: free-form grouping, unpublished column

**Record Grain**:
The published Dataset Schema fields that identify exactly one Dataset record, so every metric counts a record once and grouped results reconcile with their totals.
_Avoid_: implicit grain, guessed row key

**Data Product Release**:
An immutable Workspace-scoped result binding an exact Data Product Version, consistent Dataset Releases, Metric Definitions, and Business Context versions.
_Avoid_: Mutable latest product, per-run Approval

**Data Product API**:
The stable logical Consumer API automatically exposed for a published Data Product, serving dynamically composed authorized queries against one consistent Data Product Release under its Data Product Contract.
_Avoid_: LLM-generated endpoint code, unrestricted Dataset API, saved-query-only API

**Data Product Query**:
A dynamically composed request for curated records or documents, or for governed metrics grouped by dimensions, evaluated within an exact Data Product Contract against one consistent Data Product Release.
_Avoid_: Saved query, arbitrary SQL, ungoverned Dataset query

**Comparison Window**:
A time window a Data Product Query evaluates beside the window it queries, yielding the comparison value and the change against it.
_Avoid_: Ad-hoc baseline, second ungoverned query

**Report Template**:
A versioned Workspace Artifact defining one parameterized business question and the grounded-answer prompt template from which Reports are generated.
_Avoid_: Dashboard definition, stored answer, ungoverned prompt

**Report**:
An immutable stored Workspace Artifact answering one business question, generated from an exact Report Template Version and exact Data Product Releases for consumption by users, downstream applications, or agents without regenerating its content on retrieval.
_Avoid_: Dashboard, presentation layout, Report Template, Data Product, ungoverned narrative

**Natural-Language Query**:
A read-only Consumer interaction that clarifies and compiles a question into one or more deterministically validated Data Product Queries within one Workspace, then grounds its answer and explanations in the governed results.
_Avoid_: Arbitrary SQL generation, cross-workspace search, LLM-authorized query

**Data Product Grant**:
A Workspace-scoped authorization configuration allowing an actor to query a published Data Product subject to permitted columns and declarative row filters, enforced at the server-side data-access boundary.
_Avoid_: LLM-enforced permission, per-prompt access, unrestricted Dataset access

**Metric Definition**:
A versioned Business Context entry defining business meaning independently of a Source; common metrics cannot refer to Workspace-specific objects.
_Avoid_: Source cleaning rule, Workspace shadow of a common metric

**Publication**:
A lifecycle fact making an exact Artifact Version available for its governed use without changing that version’s content or Approval history.
_Avoid_: Mutable version, implicit Approval transfer

**Adoption**:
A lifecycle fact explicitly binding an operational Source to an exact published Artifact Version, separately from that version’s Approval and Publication.
_Avoid_: Implicit latest-version activation, automatic repair adoption

**Withdrawal**:
A lifecycle fact preventing an exact Artifact Version from future execution or Adoption while preserving its history, provenance, and governed results.
_Avoid_: Version deletion, history erasure

**Purge**:
The audited physical deletion of retention-eligible content, distinct from non-destructive Withdrawal and source-record tombstones; content still required by current, retained, held, or dependent results is ineligible.
_Avoid_: Withdrawal, source tombstone, age-based deletion of current data

**Retention Hold**:
An audited exception that makes content within a defined scope ineligible for automatic or manual Purge until the hold is explicitly released.
_Avoid_: Informal retention exemption, permanent undeclared preservation

**Purge Ledger**:
The durable, sequenced record of Purge operations used to prevent purged content from becoming accessible again after disaster recovery.
_Avoid_: Ordinary activity log, mutable deletion queue

**Rollback**:
A new lifecycle fact returning governed use to an eligible exact previously approved Artifact Version without rewriting or deleting intervening history.
_Avoid_: Mutable reversal, automatic candidate activation

**Application Rollback**:
An Operator-controlled return to the immediately preceding compatible application release while preserving current data and schema history, distinct from Artifact Rollback and disaster-recovery restoration.
_Avoid_: Down-migration, backup restoration, Artifact Rollback

**Release Bundle**:
The complete, versioned distribution unit used to install or upgrade a Deployment in connected or disconnected environments.
_Avoid_: Delta-only upgrade, automatic update, Deployment backup

**Deployment License**:
A vendor-issued entitlement bound to one Deployment that defines its permitted runtime duration and eligible platform releases, validated locally without a vendor service.
_Avoid_: User license, Workspace license, online activation

**License Request**:
A non-secret request generated by a Deployment to identify it for offline Deployment License issuance.
_Avoid_: Credential, master key, license file

**Record Rejection**:
Governed metadata identifying a source record or document rejected during integration, its raw locator, failed rule, reason, and exact processing versions.
_Avoid_: Silent discard, batch-level schema quarantine

**Provenance**:
The lineage linking governed data to its Sources, acquisitions, Integration Batches, exact Artifact Versions, and distinct source, acquisition, integration, and release times.
_Avoid_: Ambiguous freshness timestamp, raw-only lineage

**Scraper Task**:
A versioned Workspace Artifact specifying the target, output contract, parameters, fixtures, and constraints from which Scraper Service candidates are compiled.
_Avoid_: Published Scraper Service, unversioned scraping request

**Reference Workload**:
The canonical set of real business source data and expected governed results used to evaluate the first release end to end.
_Avoid_: Synthetic demo, csctalon acceptance dependency

**Scraper Service**:
A versioned, reusable acquisition Artifact compiled from a Scraper Task; its published version is approved for repeated scraping runs.
_Avoid_: One-off scrape, autonomous scraper repair
