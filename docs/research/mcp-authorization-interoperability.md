# MCP authorization and interoperability research

Research for **Research MCP authorization and interoperability requirements**, part of **Wayfinder: Data middle office first release**.

This report separates protocol facts from implementation implications. Sources are official MCP documentation and first-party IETF/OpenID standards. In current MCP compatibility terminology, **modern** means MCP 2026-07-28 and later; **legacy** means 2025-11-25 and earlier.

## Protocol and transport facts

- MCP **2026-07-28** is the Current protocol revision. Version identifiers use `YYYY-MM-DD`; a Current revision may receive backward-compatible additions without changing its identifier. [MCP versioning](https://modelcontextprotocol.io/specification/versioning)
- Current MCP is stateless at the protocol level. Every request must be self-contained; servers must not infer protocol version, capabilities, or client identity from previous requests on the connection. Application state requires an explicit identifier supplied on each request. [Base protocol: statelessness](https://modelcontextprotocol.io/specification/2026-07-28/basic.md#statelessness)
- Streamable HTTP uses one MCP endpoint supporting POST. Each JSON-RPC message uses a new HTTP POST. Clients send `Accept` containing both `application/json` and `text/event-stream`; responses may be JSON or request-scoped SSE. Accepted notifications receive HTTP 202 with no body. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md)
- The current transport removes the standalone GET stream and protocol-level sessions. SSE notifications relate to the originating request; long-lived change notifications use `subscriptions/listen`. `Last-Event-ID` resumability is not supported. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md) and [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md)
- Every POST requires `MCP-Protocol-Version`, matching request metadata. `Mcp-Method` is required on requests; `Mcp-Name` is required for `tools/call`, `resources/read`, and `prompts/get`. Servers validate `Origin` and reject an invalid value with 403. [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md)

## Compatibility and version discovery

- Modern MCP has no initialization-based negotiation handshake. Servers implement `server/discover`; clients may call it to obtain supported versions and capabilities or send another request directly. An unsupported version produces `UnsupportedProtocolVersionError`, JSON-RPC code `-32022`, with supported and requested versions; Streamable HTTP uses HTTP 400. [Versioning](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md) and [server discovery](https://modelcontextprotocol.io/specification/2026-07-28/server/discover.md)
- Legacy negotiation applies only when deliberately supporting legacy peers. In MCP 2025-11-25, `initialize` is the first interaction; successful initialization is followed by `notifications/initialized`. [Legacy lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle.md)
- Dual-era implementations may support both models. Only an empty or unrecognized HTTP 400 permits fallback to legacy `initialize`; a recognized modern JSON-RPC error means the client remains modern. A legacy-only client cannot fall forward into a modern-only server. [Compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning.md)
- A current-only server returns 405 to legacy GET or DELETE, ignores `Mcp-Session-Id` without minting or echoing it, and ignores `Last-Event-ID`. The older HTTP+SSE transport is deprecated. [Transport compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http.md#backward-compatibility) and [deprecation registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md)

## Authorization and discovery facts

- Authorization is optional at the MCP protocol level. A protected MCP server is an OAuth resource server, the MCP client is an OAuth client, and an authorization server issues tokens after required user interaction. MCP authorization references OAuth 2.1 draft-13, dated 2025-05-28. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md) and [OAuth 2.1 draft-13](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-13)
- MCP servers must implement Protected Resource Metadata. MCP requires `authorization_servers` with at least one issuer. Discovery uses `resource_metadata` in a 401 `WWW-Authenticate` challenge or an RFC 9728 well-known URI; clients support both. [Authorization-server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery.md) and [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)
- RFC 9728 requires exact `resource` validation and TLS certificate checking. Multiple authorization servers are independent; client credentials and tokens remain separated by issuer. [RFC 9728, sections 3 and 5](https://www.rfc-editor.org/rfc/rfc9728.html)
- An MCP authorization server provides RFC 8414 metadata or OpenID Connect Discovery; clients support both. The returned `issuer` must exactly match the discovered issuer. Clients implement PKCE and use `S256` when capable; missing `code_challenge_methods_supported` is a refusal condition. [MCP discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery.md), [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414.html), and [OIDC Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html)
- Authorization servers should return `iss` in authorization responses. Clients apply RFC 9207 issuer validation before using a code, including exact string comparison rules. [MCP response validation](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md#authorization-response-validation) and [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)

## Resource indicators, tokens, and consent

- Clients include `resource` in authorization and token requests, identifying the intended MCP server by canonical URI whether or not the authorization server advertises resource-indicator support. [MCP resource parameter](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md#resource-parameter-implementation) and [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)
- An MCP server validates every access token and verifies it was issued specifically for that server. Invalid or expired tokens produce 401; valid tokens with insufficient permissions produce 403. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization.md)
- RFC 8707 section 3 advises sufficiently specific resource URIs, including tenant-identifying information where appropriate, when token audience provides tenant isolation. Multiple audiences increase replay and trust risks. [RFC 8707, section 3](https://www.rfc-editor.org/rfc/rfc8707.html#section-3)
- Authorized calls use `Authorization: Bearer <access-token>` on every request. Tokens never appear in URI queries. Clients do not send tokens from unrelated authorization servers. Tokens require secure storage; short-lived access tokens and public-client refresh-token rotation are recommended or required by the cited OAuth profile. [MCP authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations.md) and [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html)
- Token passthrough is prohibited. An MCP server does not accept or transit tokens intended for other resources; upstream calls use separate credentials. [MCP authorization security](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations.md)
- MCP does not universally mandate JWT access tokens. If RFC 9068 JWT access tokens are selected, resource servers validate `typ`, exact issuer, expected audience, signature while rejecting `alg=none`, and expiration. [RFC 9068, section 4](https://www.rfc-editor.org/rfc/rfc9068.html#section-4)
- When an MCP proxy uses a static upstream client ID with a third-party authorization server, it obtains user consent for each dynamically registered MCP client before forwarding authorization. Official guidance requires per-user/per-client consent binding, exact redirect matching, CSRF protection, and single-use, short-lived OAuth state. [MCP security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices.md)

## Client registration

- MCP's registration selection order is pre-registered client information, Client ID Metadata Documents when advertised, Dynamic Client Registration when advertised, then a user prompt if no mechanism works. [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md)
- Clients and authorization servers should support Client ID Metadata Documents (CIMD). CIMD uses an HTTPS URL containing a path as `client_id`; the document includes at least `client_id`, `client_name`, and `redirect_uris`. [MCP client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md) and [CIMD draft-00](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- Dynamic Client Registration is MAY and deprecated in MCP 2026-07-28, retained for backward compatibility. Credentials remain bound to their creating issuer. [Client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration.md) and [deprecation registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md)

## Tool discovery, caching, and sessions

- Servers supporting tools declare the `tools` capability and implement `tools/list`. Results contain tools available to the requesting client and may vary with authorization, not merely connection history. Pagination is supported. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md)
- Complete `tools/list` results carry caching hints. `private` results may be reused only within the same authorization context; a different access token requires a different cache. Cache scope is not access control. [MCP caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.md)
- If `listChanged` is declared, servers send `notifications/tools/list_changed` only to clients that opened `subscriptions/listen` with `toolsListChanged: true`. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md) and [subscriptions](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/subscriptions.md)
- Tool annotations are untrusted unless obtained from a trusted server; MCP recommends that a human be able to deny tool invocations. [MCP tools security](https://modelcontextprotocol.io/specification/2026-07-28/server/tools.md)
- Current MCP has no protocol-level session lifecycle. Servers verify every inbound request; possession of an application-state handle is not authentication. Handles should be nondeterministic and bound server-side to the verified security context. [Base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic.md#statelessness) and [security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices.md)

## Implications for the later design decision

These are derived implications, not MCP-normative product requirements:

1. Authenticate and authorize every operation independently, including tenant and object access; do not derive security context from sticky connections or legacy session state.
2. Keep protected-resource identifiers, OAuth `resource` values, and expected token audiences consistent. Audience validation complements rather than replaces operation-level authorization.
3. Bind application-state handles and private caches to the complete verified security context, including tenant where applicable.
4. Validate transport headers against request bodies before using them for routing or policy; Origin validation remains independent.
5. Keep inbound MCP tokens separate from upstream API and database credentials.
6. Treat metadata and CIMD retrieval as SSRF-sensitive URL fetching with HTTPS restrictions, redirect validation, private-address blocking, egress controls, and DNS-rebinding protections.

## Uncertainties and boundaries

- MCP 2026-07-28 can gain backward-compatible changes without a new version-date identifier, so the date does not freeze every compatible detail.
- Resource-indicator enforcement remains conditional on authorization-server support, although clients always send `resource` and MCP servers validate audience.
- Authorization-server inclusion of `iss` is SHOULD rather than MUST; PKCE and resource indicators do not close every mix-up case.
- Access-token format remains deployment-specific; RFC 9068 rules apply only when that profile is selected.
- MCP references OAuth and CIMD drafts, so implementations need explicit dependency-version discipline.
- DCR's earliest eligible removal is the first MCP revision released on or after 2027-07-28; this is not a committed removal schedule. [Deprecation registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated.md)
- MCP does not define tenant claims, tenant-context schemas, row-level security, SQL-injection policy, or database isolation. Those remain application responsibilities.
