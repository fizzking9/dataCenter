# Standalone single-organization deployment

The platform is standalone software that one business entity deploys and operates for its own use, superseding the earlier multi-tenant SaaS destination recorded in [Define tenant, user, and configuration ownership](https://github.com/fizzking9/dataCenter/issues/2). There is no tenant concept and no vendor-hosted control plane; Workspace remains the single partition for ownership and authorization, and a host-level Operator is trusted and explicitly outside the authorization boundary. First-release customization is configuration-driven only.

## Consequences

- Tenant, Tenant Administrator, and Tenant Artifact leave the domain language; Tenant Administrator becomes Deployment Administrator, and the outermost scope is the Deployment.
- Installation, upgrade, rollback, and migration of customer data become first-release design constraints, because the vendor does not control when a deployment is upgraded.
- Data residency follows from where the customer deploys and is not a platform feature.
- LLM calls are made by the customer's deployment with customer-supplied provider credentials or local models; there is no vendor model proxy, telemetry endpoint, or license service.
- Multi-tenant operation, cross-tenant isolation, per-tenant metering, and a plugin or extension SDK are out of scope for the first release.
- The MCP authorization and governed-LLM research findings are unaffected: transport, validation, approval, and provenance conclusions hold within one Deployment.
