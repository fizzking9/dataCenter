# Governed LLM patterns for data platforms

Research for **Research governed LLM patterns for data platforms**, part of **Wayfinder: Data middle office first release**.

This is a research synthesis, not a product contract. Established facts come from primary sources; design implications are architectural inferences. Living documentation is identified rather than assigned an inferred version.

## Generated schema and cleaning-rule artifacts

### Established facts

- TensorFlow Extended's production data-validation work addresses anomalies in ML-pipeline data, including unexpected patterns and training/serving skew. [Polyzotis et al., MLSys 2019](https://proceedings.mlsys.org/paper_files/paper/2019/hash/928f1160e52192e3e0017fb63ab65391-Abstract.html)
- TensorFlow Data Validation provides schema inference and validation of dataset statistics against a schema. Its guidance distinguishes repairing erroneous data from updating a schema when changed data is expected. [TensorFlow Data Validation guide, updated 2023-03-09](https://www.tensorflow.org/tfx/data_validation/get_started)
- JSON Schema Draft 2020-12 supplies a machine-checkable vocabulary for JSON document structure, assertions, and annotations. [JSON Schema Core 2020-12](https://json-schema.org/draft/2020-12/json-schema-core)
- OpenAI's Agents SDK supports pausing sensitive tool calls for human approval. Its documentation requires reviewer authentication and authorization, validation against server-owned pending requests, and replay/concurrent-resumption protections. Approval alone does not provide exactly-once execution. [OpenAI Agents SDK: Human in the loop](https://openai.github.io/openai-agents-python/human_in_the_loop/)

### Design implications

- Treat generated schemas and cleaning rules as candidate artifacts, not production changes. Apply deterministic structural validation before data-oriented validation and human review.
- Cleaning rules need behavioral tests over fixed inputs and expected outputs, plus examination of their effects on representative data statistics.
- Approval should bind the exact artifact and validation evidence being promoted. Consequential execution needs replay protection and idempotency or reconciliation outside the model.

### Boundaries

- Schema validity does not establish semantic correctness. Human review does not prove correctness, prevent every unsafe side effect, or provide exactly-once execution.
- JSON Schema Draft 2020-12's core document is an IETF Internet-Draft, not a finalized RFC.

## Validation, evaluation, and regression gates

### Established facts

- NIST's AI RMF Playbook recommends selecting measurements from significant risks, documenting what cannot be measured, reassessing regularly, tracking performance changes, and evaluating prototypes early and continuously. `MEASURE 2.3` calls for deployment-like conditions, documented measures, and differences between testing and deployment. [NIST AI RMF Playbook: Measure](https://airc.nist.gov/airmf-resources/playbook/measure)
- NIST `MANAGE 1.1` uses testing, evaluation, verification, and validation outputs in proceed/do-not-proceed decisions and continues monitoring after deployment. [NIST AI RMF Playbook: Manage](https://airc.nist.gov/airmf-resources/playbook/manage)
- RAGAS distinguishes retrieval relevance, context focus, faithful use of context, and generation quality. Answer relevance does not measure factuality. [Es et al., EACL 2024](https://aclanthology.org/2024.eacl-demo.16/)

### Design implications

- Combine deterministic artifact/data validation with deployment-like task evaluation, security tests, and an explicit release gate; continue monitoring after release.
- Rerun relevant evaluations when prompts, models, retrieval, semantic definitions, or artifact-generation logic change.
- Evaluate retrieval relevance, answer faithfulness, task correctness, and answer relevance separately rather than hiding regressions behind one aggregate score.
- Include deployment-like data, prior failures, near misses, and adversarial documents or tool outputs in regression scenarios.

### Boundaries

- NIST does not provide universal numerical thresholds or a ready-made data-platform test suite. RAGAS automated evaluation is not ground truth, and reported human-agreement results should not be assumed to transfer to other domains.
- A fixed regression suite does not establish correctness or safety on unseen inputs, changed data, or new attacks.

## Prompt, model, and artifact provenance

### Established facts

- W3C PROV-DM is a domain-agnostic provenance model with entities, activities, agents, generation, usage, derivation, attribution, association, and delegation. [W3C PROV-DM, Recommendation 2013-04-30](https://www.w3.org/TR/2013/REC-prov-dm-20130430/)
- MLflow Prompt Registry documents immutable prompt versions, diffs, deployment aliases, rollback, and lineage integration with tracing, evaluation, and monitoring. [MLflow Prompt Registry](https://mlflow.org/docs/latest/genai/prompt-registry/)

### Design implications

- Represent source snapshots, prompt/model versions, semantic definitions, generated artifacts, validation runs, approvals, executions, and answers as a linked provenance graph.
- Resolve mutable deployment aliases to the concrete immutable version used for each run. Record provider model revisions, retrieval snapshots, and external dependencies separately.

### Boundaries

- PROV-DM does not itself implement retention, access control, completeness, or tamper-evident audit storage. Immutable prompts do not freeze provider behavior, external documents, tools, or runtime dependencies.

## Semantic-layer grounding

### Established facts

- dbt's Semantic Layer uses centrally defined semantic models and metrics; MetricFlow generates SQL from those configurations. [dbt Semantic Layer architecture](https://docs.getdbt.com/docs/use-dbt-semantic-layer/sl-architecture)
- MetricFlow describes a semantic graph in which entities provide join keys, dimensions group metrics, and metrics define quantitative indicators. [About MetricFlow](https://docs.getdbt.com/docs/build/about-metricflow)
- dbt's official AI documentation connects AI tools through dbt MCP so answers use governed metrics; its MCP announcement lists `list_metrics`, `get_dimensions`, and `query_metrics`. [dbt Semantic Layer and AI](https://docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-sl) and [Introducing dbt MCP Server, 2025-04-21](https://docs.getdbt.com/blog/introducing-dbt-mcp-server)

### Design implications

- Constrain the LLM to discover and select existing metrics, dimensions, entities, and filters while deterministic semantic software constructs SQL.
- Return selected semantic objects alongside results so interpretation is inspectable. Ambiguous or unknown terms require clarification rather than arbitrary selection.

### Boundaries

- A semantic layer constrains query construction but does not prove the model selected the intended business meaning. Vendor accuracy statements are not independent comparative evidence.
- Semantically valid SQL can still be unauthorized or expose excessive data.

## Read-only queries and authorization outside the LLM

### Established facts

- PostgreSQL `READ ONLY` transactions disallow listed write and DDL operations, but PostgreSQL describes read-only as a high-level mode that does not prevent every write to disk. [PostgreSQL 18: SET TRANSACTION](https://www.postgresql.org/docs/18/sql-set-transaction.html)
- PostgreSQL distinguishes `SELECT` from write and execution privileges and supports table- and column-level grants. Functions and procedures have default `PUBLIC EXECUTE` privileges. [PostgreSQL 18: Privileges](https://www.postgresql.org/docs/18/ddl-priv.html)
- Row-level security restricts rows per user in addition to SQL privileges. Enabled RLS with no applicable policy is default-deny. Superusers and `BYPASSRLS` roles bypass it; owners normally bypass it unless forced. [PostgreSQL 18: Row Security Policies](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)
- PostgreSQL provides statement, transaction, lock, and idle-session/transaction timeout controls. [PostgreSQL 18: Client Connection Defaults](https://www.postgresql.org/docs/18/runtime-config-client.html)

### Design implications

- The LLM is not the authorization boundary. Execute under a separate least-privilege identity with required table/column grants, applicable RLS, read-only transactions, and database-enforced resource limits.
- Address owner, superuser, `BYPASSRLS`, role-inheritance, and function-execution exceptions explicitly.
- SQL parsing and single-statement restrictions are defense in depth, not replacements for database privileges and RLS.

### Boundaries

- Read-only queries can still expose sensitive data or consume substantial resources. Parsing a statement does not establish business correctness, authorization, or acceptable cost.

## Indirect prompt injection

### Established facts

- Greshake et al. demonstrate indirect prompt injection through instructions placed in data retrieved or processed by LLM-integrated applications, with impacts including data theft and control of API calls. [Greshake et al., arXiv 2302.12173, 2023](https://arxiv.org/abs/2302.12173)
- Anthropic states that tool results often contain web pages, email, uploads, and third-party API content outside application control. It recommends treating them as untrusted and retaining them in `tool_result` blocks rather than promoting them into system prompts or plain user text. [Anthropic: Handle tool calls](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/handle-tool-calls)
- Microsoft recommends designing on the assumption that prompt injection may eventually succeed. Controls include RBAC, constrained tools, scoped identities, data isolation, input validation, scanning, allowlisting, source-integrity checks, curated snapshots, delimiters/metadata, secondary checks, red teaming, and logging. Delimiters and metadata are not a complete trust boundary. [Microsoft: Prompt Injection](https://learn.microsoft.com/en-us/security/zero-trust/catalog-ai-attack-techniques/prompt-injection)

### Design implications

- Keep retrieved documents, records, web content, and tool results labeled as untrusted data throughout processing; never silently grant them instruction authority.
- Limit blast radius with scoped credentials, minimal tools, isolated data access, external authorization, and human confirmation for consequential actions.
- Screen source admission, retrieved content, and tool results; add a separate policy check before consequential execution. Include malicious content in regression tests.
- Treat tool names and arguments in approval interfaces as untrusted display content.

### Boundaries

- No reviewed source establishes a complete prompt-injection defense. Structural separation, scanning, classifiers, delimiters, and human review reduce risk but are not guaranteed boundaries.

## Answer provenance and uncertainty

### Established facts

- RAG combines parametric memory with retrieved non-parametric memory; its comparative improvements are not a factual-output guarantee. [Lewis et al., NeurIPS 2020](https://proceedings.neurips.cc/paper/2020/hash/6b493230205f780e1bc26945df7481e5-Abstract.html)
- Anthropic's Citations API grounds answers in provided documents and returns references to passages used for source-derived claims. Anthropic describes citations as minimizing, not eliminating, hallucinations. [Anthropic Citations API](https://www.anthropic.com/news/introducing-citations-api)
- RAGAS defines faithfulness as whether answer claims can be inferred from supplied context, separately from answer and retrieval relevance. [RAGAS paper](https://aclanthology.org/2024.eacl-demo.16/)
- Semantic entropy samples answers, clusters them by meaning using bidirectional entailment, and estimates entropy over meaning clusters. The authors propose using it to warn about or refuse likely confabulations. [Farquhar et al., Nature 630, published 2024-06-19](https://www.nature.com/articles/s41586-024-07421-0)

### Design implications

- Combine pinpoint answer citations with run provenance covering source snapshots, prompt/model versions, semantic definitions, query execution, and generated artifacts.
- Keep citation presence, claim-to-source faithfulness, source authority, and task correctness as separate checks.
- Use uncertainty as an additional signal for warnings, abstention, or review, with thresholds evaluated on deployment-like tasks.

### Boundaries

- A citation does not prove entailment, source authority, or truth. Faithfulness and uncertainty measure different failure modes.
- Semantic entropy does not directly address systematically dangerous behavior, systematic reasoning errors, or systematically misleading output. Its reported results do not establish calibration for governed data-platform answers without separate evaluation.
