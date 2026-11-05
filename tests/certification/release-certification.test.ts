import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { createBundleFixture } from '../support/bundle.js';
import {
  blockedEgressEnvironment,
  recordedEgressAttempts,
} from '../support/egress-guard.js';
import {
  timestampKeys,
  verifyEvidenceManifest,
  writeEvidenceManifest,
} from '../support/evidence.js';
import {
  LEDGER_ORACLE,
  PROVIDER_PROFILES,
  assessCertification,
  certifyRelease,
  type CertificationRun,
} from '../support/release-certification.js';

const GENERATED_AT = '2026-03-01T00:00:00.000Z';
let certification: CertificationRun;

function scratchDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'dc-evidence-'));
}

test('a signed evidence manifest is canonical, tamper-evident, and byte-stable across rewrites', () => {
  const scratch = scratchDirectory();
  const bundle = createBundleFixture(scratch);
  const body = {
    kind: 'release_certification',
    generated_at: '2026-01-01T00:00:00.000Z',
    zeta: 1,
    alpha: { items: [2, { beta: true, alpha: null }], value: '简体中文' },
  };
  const first = writeEvidenceManifest({
    directory: join(scratch, 'first'),
    body,
    privateKey: bundle.releasePrivateKey,
    keyId: bundle.releaseFingerprint,
  });
  const second = writeEvidenceManifest({
    directory: join(scratch, 'second'),
    body: { zeta: 1, alpha: { value: '简体中文', items: [2, { alpha: null, beta: true }] }, generated_at: '2026-01-01T00:00:00.000Z', kind: 'release_certification' },
    privateKey: bundle.releasePrivateKey,
    keyId: bundle.releaseFingerprint,
  });

  // The manifest is written with sorted keys and no volatile content, so two
  // certifications of the same inputs are byte-identical.
  assert.equal(readFileSync(first.manifestPath, 'utf8'), readFileSync(second.manifestPath, 'utf8'));
  assert.equal(first.digest, second.digest);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(first.manifestPath, 'utf8')) as object), ['alpha', 'generated_at', 'kind', 'zeta']);
  assert.equal(first.signature.key_id, bundle.releaseFingerprint);
  assert.equal(first.signature.algorithm, 'Ed25519');

  const verified = verifyEvidenceManifest({
    manifestPath: first.manifestPath,
    signaturePath: first.signaturePath,
    publicKeyPath: bundle.releasePublicKeyPath,
  });
  assert.equal(verified.valid, true, verified.reason ?? undefined);
  assert.equal(verified.digest, first.digest);

  // Any change to a signed field is detected rather than accepted.
  const tampered = JSON.parse(readFileSync(first.manifestPath, 'utf8')) as Record<string, unknown>;
  tampered['zeta'] = 2;
  const tamperedPath = join(scratch, 'first', 'tampered.json');
  writeFileSync(tamperedPath, `${JSON.stringify(tampered, null, 2)}\n`);
  const tamperedResult = verifyEvidenceManifest({
    manifestPath: tamperedPath,
    signaturePath: first.signaturePath,
    publicKeyPath: bundle.releasePublicKeyPath,
  });
  assert.equal(tamperedResult.valid, false);
  assert.equal(tamperedResult.reason, 'EVIDENCE_SIGNATURE_INVALID');

  // A manifest signed by another key is not this release's evidence.
  const foreign = createBundleFixture(join(scratch, 'foreign'));
  const foreignResult = verifyEvidenceManifest({
    manifestPath: first.manifestPath,
    signaturePath: first.signaturePath,
    publicKeyPath: foreign.releasePublicKeyPath,
  });
  assert.equal(foreignResult.valid, false);
  assert.equal(foreignResult.reason, 'EVIDENCE_SIGNATURE_INVALID');
});

test('a disconnected fixture blocks every non-loopback connection and records the attempts', () => {
  const scratch = scratchDirectory();
  const guard = blockedEgressEnvironment(join(scratch, 'egress'));

  // A loopback address is still allowed: the guard refuses vendor egress, not
  // the fixture's own controlled endpoints. Nothing listens on the port, so the
  // failure names a connection refusal rather than the guard.
  const local = spawnSync(process.execPath, ['--input-type=module', '-e', `
    try {
      await fetch('http://127.0.0.1:1/');
      console.log('connected');
    } catch (error) {
      console.log('refused:' + String(error.cause?.code ?? error.code ?? error.message));
    }
  `], { encoding: 'utf8', env: { ...process.env, ...guard.env } });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /^refused:/u);
  assert.equal(local.stdout.includes('CERTIFICATION_EGRESS_BLOCKED'), false);

  // A required vendor call would fail closed under the block rather than
  // quietly reach the network; the attempt is recorded for the evidence.
  const external = spawnSync(process.execPath, ['--input-type=module', '-e', `
    try {
      await fetch('https://vendor.example.invalid/model');
      console.log('connected');
    } catch (error) {
      console.log('blocked:' + String(error.cause?.code ?? error.code ?? error.message));
    }
  `], { encoding: 'utf8', env: { ...process.env, ...guard.env } });
  assert.equal(external.status, 0, external.stderr);
  assert.match(external.stdout, /^blocked:/u);
  assert.equal(external.stdout.includes('connected'), false);
  assert.deepEqual(recordedEgressAttempts(guard.logPath), ['vendor.example.invalid']);
});

before(async () => {
  certification = await certifyRelease({ generatedAt: GENERATED_AT });
}, { timeout: 900_000 });

test('release certification certifies both bundle channels, every shipped adapter, disconnected operation, and the Chinese UI', { timeout: 900_000 }, () => {
  const evidence = certification.manifest;
  assert.equal(evidence['schema_version'], 1);
  assert.equal(evidence['kind'], 'release_certification');
  assert.equal(evidence['generated_at'], GENERATED_AT);

  // The exact signed release identity is recorded for both delivery channels.
  const release = evidence['release'] as Record<string, unknown>;
  assert.equal(release['release'], '0.1.0');
  assert.equal(release['next_release'], '0.2.0');
  assert.equal(release['release_key_fingerprint'], certification.bundle.releaseFingerprint);
  assert.equal(release['identical_content'], true);
  const channels = release['channels'] as Array<Record<string, unknown>>;
  assert.deepEqual(channels.map((channel) => channel['channel']), ['connected-download', 'removable-media']);
  for (const channel of channels) {
    assert.match(String(channel['manifest_sha256']), /^[0-9a-f]{64}$/u);
    assert.match(String(channel['signature_sha256']), /^[0-9a-f]{64}$/u);
    const files = channel['files'] as Array<Record<string, unknown>>;
    assert.equal(files.length, 6);
    for (const file of files) assert.match(String(file['sha256']), /^[0-9a-f]{64}$/u);
    assert.equal((channel['embedding_assets'] as unknown[]).length, 1);
  }
  const embeddings = release['bundled_embeddings'] as Record<string, unknown>;
  assert.ok(embeddings['asset'] !== null);
  assert.equal(
    ((embeddings['platform_local_configuration'] as Record<string, unknown>)['model_id']),
    'Qwen3-Embedding-0.6B',
  );

  // Connected and removable media behave identically through the whole lifecycle.
  const lifecycle = evidence['lifecycle'] as Record<string, unknown>;
  assert.equal(lifecycle['identical'], true);
  const lifecycleChannels = lifecycle['channels'] as Array<Record<string, unknown>>;
  assert.equal(lifecycleChannels.length, 2);
  assert.deepEqual(lifecycleChannels[0]!['observations'], lifecycleChannels[1]!['observations']);
  const observations = lifecycleChannels[0]!['observations'] as Record<string, unknown>;
  assert.equal((observations['install'] as Record<string, unknown>)['state'], 'license_required');
  assert.equal((observations['install'] as Record<string, unknown>)['service_open'], false);
  assert.equal((observations['initialize'] as Record<string, unknown>)['state'], 'verified_open');
  assert.deepEqual((observations['initialize'] as Record<string, unknown>)['runtime_services'], ['minio', 'postgres']);
  assert.equal((observations['status_before_upgrade'] as Record<string, unknown>)['health'], 'healthy');
  assert.deepEqual(
    (observations['read_before_upgrade'] as Record<string, unknown>)['totals'],
    LEDGER_ORACLE.totals,
  );
  assert.equal((observations['upgrade'] as Record<string, unknown>)['to_release'], '0.2.0');
  assert.equal((observations['verify_after_upgrade'] as Record<string, unknown>)['passed'], true);
  assert.equal((observations['rollback'] as Record<string, unknown>)['to_release'], '0.1.0');
  assert.equal((observations['rollback'] as Record<string, unknown>)['offline'], true);
  assert.equal((observations['rollback'] as Record<string, unknown>)['down_migrations'], 0);
  assert.equal((observations['read_after_rollback'] as Record<string, unknown>)['returned'], 3);
  assert.equal((observations['backup'] as Record<string, unknown>)['payloads_encrypted'], true);
  assert.equal((observations['backup_verify'] as Record<string, unknown>)['verified'], true);
  assert.equal((observations['restore'] as Record<string, unknown>)['state'], 'verified_open');
  assert.equal((observations['restore'] as Record<string, unknown>)['workers_enabled'], false);
  assert.equal((observations['restored_read'] as Record<string, unknown>)['returned'], 3);
  assert.equal((observations['offline'] as Record<string, unknown>)['registry_pulls'], 0);

  // Deterministic mock-LLM acceptance passes completely, scenario by scenario.
  const suites = evidence['suites'] as Array<Record<string, unknown>>;
  assert.deepEqual(suites.map((suite) => suite['name']), [
    'governed_correctness',
    'natural_language_chinese',
    'recovery',
    'chinese_ui',
  ]);
  let scenarioCount = 0;
  for (const suite of suites) {
    assert.equal(suite['passed'], true, `${String(suite['name'])}: ${JSON.stringify(suite['scenarios'])}`);
    assert.equal(suite['passed_count'], suite['total_count']);
    scenarioCount += Number(suite['total_count']);
  }
  assert.equal(scenarioCount, 17);
  const governed = suites[0]!['scenarios'] as Array<Record<string, unknown>>;
  assert.deepEqual(governed.map((scenario) => scenario['name']), [
    'numeric_correctness', 'typed_filters', 'release_pinning', 'workspace_isolation',
    'redaction', 'provenance', 'audit',
  ]);
  const numeric = governed.find((scenario) => scenario['name'] === 'numeric_correctness')!;
  assert.deepEqual((numeric['detail'] as Record<string, unknown>)['totals'], LEDGER_ORACLE.totals);
  const grounding = (suites[1]!['scenarios'] as Array<Record<string, unknown>>)
    .find((scenario) => scenario['name'] === 'critical_grounding')!;
  assert.equal((grounding['detail'] as Record<string, unknown>)['grounded_result_preserved'], true);

  // Every shipped adapter holds three consecutive passing runs, clears its
  // Binding preflight, and every adverse endpoint is refused rather than repaired.
  const adapters = evidence['adapters'] as Array<Record<string, unknown>>;
  assert.deepEqual(
    adapters.map((adapter) => adapter['provider']),
    PROVIDER_PROFILES.map((profile) => profile.key),
  );
  assert.deepEqual(
    adapters.map((adapter) => adapter['adapter']),
    PROVIDER_PROFILES.map((profile) => profile.adapter),
  );
  for (const adapter of adapters) {
    const runs = adapter['runs'] as Array<Record<string, unknown>>;
    assert.equal(runs.length, 3);
    assert.deepEqual(runs.map((run) => run['run']), [1, 2, 3]);
    assert.equal(runs.every((run) => run['passed'] === true), true, JSON.stringify(runs));
    assert.equal(adapter['consecutive_passes'], 3);
    assert.equal(adapter['passed'], true);
    const checks = runs[0]!['checks'] as Array<Record<string, unknown>>;
    for (const name of [
      'preflight',
      'pinned_identity',
      'structured_output',
      'constrained_tools',
      'simplified_chinese_prompt',
      'grounded_narration',
      'simplified_chinese_narrative',
      'simplified_chinese_clarification',
    ]) {
      assert.equal(checks.find((check) => check['name'] === name)?.['passed'], true, `${String(adapter['adapter'])}: ${name}`);
    }
    const binding = adapter['binding'] as Record<string, unknown>;
    assert.equal(binding['passed'], true, `${String(adapter['adapter'])} binding: ${JSON.stringify(binding)}`);
    assert.ok((binding['checks'] as unknown[]).length > 0);
  }
  // One adverse family per shipped adapter, each refused rather than repaired.
  const adverse = adapters.flatMap((adapter) => adapter['adverse'] as Array<Record<string, unknown>>);
  assert.equal(adverse.length, adapters.length);
  assert.deepEqual(
    adverse.map((entry) => entry['behaviour']).sort(),
    ['identity_mismatch', 'identity_mismatch', 'malformed_structured_output', 'malformed_structured_output', 'undeclared_tool'],
  );
  for (const entry of adverse) {
    assert.equal(entry['refused'], true);
    assert.ok((entry['failed_checks'] as unknown[]).length > 0);
  }
  const summary = evidence['adapter_summary'] as Record<string, unknown>;
  assert.deepEqual(summary['shipped_adapters'], ['hosted', 'generic_local', 'alibaba_qwen', 'deepseek', 'openai_compatible']);
  assert.equal(summary['profiles_passed'], PROVIDER_PROFILES.length);
  assert.equal(summary['profiles_total'], PROVIDER_PROFILES.length);
  assert.equal((summary['activation'] as Record<string, unknown>)['activated_version'], 1);

  // Real-model runs were not configured, so they are recorded as not_configured
  // and the certification fails closed instead of claiming them.
  const realModels = evidence['real_models'] as Array<Record<string, unknown>>;
  assert.deepEqual(realModels.map((model) => model['provider']), ['alibaba-qwen', 'deepseek', 'openai-compatible']);
  assert.deepEqual(realModels.map((model) => model['adapter']), ['alibaba_qwen', 'deepseek', 'openai_compatible']);
  for (const model of realModels) {
    assert.equal(model['status'], 'not_configured');
    assert.equal(model['model_id'], null);
    assert.deepEqual(model['runs'], []);
  }
  assert.equal(evidence['outcome'], 'incomplete');
  assert.equal(evidence['certified'], false);
  const blockers = evidence['blockers'] as string[];
  assert.deepEqual(
    blockers.filter((blocker) => !blocker.startsWith('real_model.')),
    [],
    `unexpected blockers: ${JSON.stringify(blockers)}`,
  );
  for (const provider of ['alibaba-qwen', 'deepseek', 'openai-compatible']) {
    assert.ok(blockers.includes(`real_model.${provider}:not_configured`), JSON.stringify(blockers));
  }

  // Disconnected operation needed no vendor egress at all.
  const disconnected = evidence['disconnected'] as Record<string, unknown>;
  assert.equal(disconnected['egress_blocked'], true);
  assert.equal(disconnected['egress_attempts'], 0);
  assert.equal(disconnected['required_vendor_egress'], 0);
  assert.equal(disconnected['local_generation'], true);
  assert.equal(disconnected['offline_license'], true);
  assert.equal(disconnected['signed_media_installation'], true);
  assert.equal(disconnected['bundled_embeddings'], true);
  assert.equal(disconnected['rollback_without_media'], true);
  assert.equal(disconnected['upgrade_offline'], true);
  assert.equal(disconnected['recovery'], true);

  // Token and cost accounting is read from the Deployment, not estimated here.
  const usage = evidence['usage'] as Record<string, unknown>;
  const totals = usage['totals'] as Record<string, unknown>;
  assert.ok(Number(totals['generations']) > 0);
  assert.ok(Number(totals['input_tokens']) > 0);
  assert.ok(Number(totals['output_tokens']) > 0);
  assert.equal(typeof totals['cost_cny'], 'number');
  assert.ok(Number(totals['cost_cny']) >= 0);
  const connectedTotals = usage['connected_totals'] as Record<string, unknown>;
  assert.equal(typeof connectedTotals['cost_cny'], 'number');
  assert.ok(Number(connectedTotals['generations']) >= 0);

  // Recovery names its exact verification results.
  const recovery = evidence['recovery'] as Record<string, unknown>;
  assert.equal(recovery['passed'], true);
  const verification = recovery['verification'] as Record<string, unknown>;
  assert.equal(verification['verified'], true);
  const verifyChecks = verification['checks'] as Record<string, boolean>;
  assert.equal(verifyChecks['integrity'], true);
  assert.equal(verifyChecks['objects'], true);
  assert.equal(verifyChecks['keys'], true);
  assert.equal(verifyChecks['manifests'], true);
  assert.equal(verifyChecks['provenance'], true);
  assert.equal(verifyChecks['governed_reads'], true);
  const restoration = recovery['restoration'] as Record<string, unknown>;
  assert.equal(restoration['state'], 'verified_open');
  assert.equal(restoration['rto_met'], true);
  assert.equal(restoration['purge_ledger'] && (restoration['purge_ledger'] as Record<string, unknown>)['removed'] !== undefined, true);

  // The real browser smoke covered all four surfaces with the shared gate.
  const chinese = evidence['chinese_ui'] as Record<string, unknown>;
  assert.equal(chinese['browser'], 'chrome');
  assert.equal(chinese['passed'], true);
  assert.equal(chinese['api_contract_unchanged'], true);
  const surfaces = chinese['surfaces'] as Array<Record<string, unknown>>;
  assert.deepEqual(surfaces.map((surface) => surface['surface']), [
    'Operator Console', 'Deployment Administrator', 'Workspace Administrator', 'Consumer',
  ]);
  for (const surface of surfaces) {
    assert.equal(surface['passed'], true, JSON.stringify(surface['failures']));
    assert.equal(surface['copy_leaks'], 0);
    assert.equal(surface['contrast_failures'], 0);
    assert.equal(surface['unlabeled_controls'], 0);
  }
  assert.ok(Number(chinese['pages']) >= 10);

  // Only generated_at varies, and the manifest carries no secret material.
  assert.deepEqual(timestampKeys(evidence), ['generated_at']);
  const text = readFileSync(certification.manifestPath, 'utf8');
  assert.equal(text.includes(readFileSync(certification.bundle.releasePublicKeyPath, 'utf8')), false);
  assert.equal(text.includes('certification-credential-'), false);
});

test('the signed evidence manifest verifies with the Release Bundle key and is byte-deterministic', { timeout: 60_000 }, () => {
  const verified = verifyEvidenceManifest({
    manifestPath: certification.manifestPath,
    signaturePath: certification.signaturePath,
    publicKeyPath: certification.bundle.releasePublicKeyPath,
  });
  assert.equal(verified.valid, true, verified.reason ?? undefined);
  assert.equal(verified.digest, certification.digest);
  assert.equal(certification.verify(), true);

  // Re-signing the same manifest produces identical bytes and the same digest.
  const repeated = writeEvidenceManifest({
    directory: join(certification.scratch, 'evidence-again'),
    body: certification.manifest,
    privateKey: certification.bundle.releasePrivateKey,
    keyId: certification.bundle.releaseFingerprint,
  });
  assert.equal(readFileSync(repeated.manifestPath, 'utf8'), readFileSync(certification.manifestPath, 'utf8'));
  assert.equal(repeated.digest, certification.digest);
});

test('certification fails closed for a failed suite, adapter sequence, adverse acceptance, or Chinese surface', () => {
  const copy = (): Record<string, unknown> => structuredClone(certification.manifest);
  const unblocked = copy();
  const passedModels = (unblocked['real_models'] as Array<Record<string, unknown>>)
    .map((model) => ({ ...model, status: 'passed' }));
  unblocked['real_models'] = passedModels;
  assert.equal(assessCertification(unblocked).certified, true);

  const failedSuite = structuredClone(unblocked);
  (failedSuite['suites'] as Array<Record<string, unknown>>)[0]!['passed'] = false;
  const suiteAssessment = assessCertification(failedSuite);
  assert.equal(suiteAssessment.certified, false);
  assert.ok(suiteAssessment.blockers.includes('suite.governed_correctness:failed'));

  const failedAdapter = structuredClone(unblocked);
  const adapter = (failedAdapter['adapters'] as Array<Record<string, unknown>>)[0]!;
  adapter['passed'] = false;
  adapter['consecutive_passes'] = 2;
  const adapterAssessment = assessCertification(failedAdapter);
  assert.equal(adapterAssessment.certified, false);
  assert.ok(adapterAssessment.blockers.includes('adapter.alibaba-qwen:not_three_consecutive_passes'));

  const acceptedAdverse = structuredClone(unblocked);
  const adverseAdapter = (acceptedAdverse['adapters'] as Array<Record<string, unknown>>)[0]!;
  (adverseAdapter['adverse'] as Array<Record<string, unknown>>)[0]!['refused'] = false;
  const adverseAssessment = assessCertification(acceptedAdverse);
  assert.equal(adverseAssessment.certified, false);
  assert.ok(adverseAssessment.blockers.includes('adapter.alibaba-qwen:accepted_identity_mismatch'));

  const leakedEgress = structuredClone(unblocked);
  (leakedEgress['disconnected'] as Record<string, unknown>)['egress_attempts'] = 1;
  const egressAssessment = assessCertification(leakedEgress);
  assert.equal(egressAssessment.certified, false);
  assert.ok(egressAssessment.blockers.includes('disconnected:egress_attempted'));

  const failedUi = structuredClone(unblocked);
  (failedUi['chinese_ui'] as Record<string, unknown>)['passed'] = false;
  const uiAssessment = assessCertification(failedUi);
  assert.equal(uiAssessment.certified, false);
  assert.ok(uiAssessment.blockers.includes('chinese_ui:failed'));
});
