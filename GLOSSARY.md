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

**Owner**:
The User accountable for an Artifact; ownership does not itself grant operational permissions.
_Avoid_: Service owner, agent owner

**Business Context**:
The deployment-wide common definitions and additive workspace-private extensions used to interpret governed data, with Artifacts pinned to explicit common and workspace versions.
_Avoid_: Ambient context, workspace override, cross-workspace implicit reference

**Approval**:
An Administrator’s explicit acceptance of an exact configuration version; human Approval is mandatory before publishing LLM-proposed changes, including schemas, cleaning rules, and Scraper Services.
_Avoid_: Unversioned consent, autonomous LLM publication

**Audit Event**:
A record of a security-relevant action, including its actor, scope, target, outcome, and correlation; business-sensitive details remain Workspace-scoped and secrets are excluded.
_Avoid_: Mutable activity history, secret-bearing log

**Source**:
A Workspace Artifact identifying one logical dataset and its versioned acquisition configuration.
_Avoid_: Physical source system, monolithic connection, unowned dataset

**Acquisition Connection**:
Shared versioned endpoint metadata, credential reference, and acquisition policy used by Sources belonging to one physical source system.
_Avoid_: Logical dataset, embedded secret

**Acquisition Run**:
One manual or scheduled request to acquire data from a Source, retaining its parameters, attempts, outcome, and provenance.
_Avoid_: Integration run, overwritten snapshot

**Raw Acquisition**:
The immutable uncurated bytes and associated provenance produced by an Acquisition Run attempt; never part of the Consumer surface.
_Avoid_: Curated data, mutable landing file

**Integration Batch**:
The immutable handoff from one successful Acquisition Run to integration, linking raw data, source metadata, and exact configuration versions.
_Avoid_: Mutable handoff, curated dataset

**Scraper Task**:
A versioned Workspace Artifact specifying the target, output contract, parameters, fixtures, and constraints from which Scraper Service candidates are compiled.
_Avoid_: Published Scraper Service, unversioned scraping request

**Reference Workload**:
The canonical set of real business source data and expected governed results used to evaluate the first release end to end.
_Avoid_: Synthetic demo, csctalon acceptance dependency

**Scraper Service**:
A versioned, reusable acquisition Artifact compiled from a Scraper Task; its published version is approved for repeated scraping runs.
_Avoid_: One-off scrape, autonomous scraper repair
