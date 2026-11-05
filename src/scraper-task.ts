import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import { actorLabel, reject, requireWorkspaceAdministrator, type ActionContext } from './authz.js';
import {
  latestScraperTaskVersion,
  type ScraperConstraints,
  type ScraperCredentialRecord,
  type ScraperFixturePage,
  type ScraperFixtureSet,
  type ScraperNetworkScope,
  type ScraperOutput,
  type ScraperOutputField,
  type ScraperParameter,
  type ScraperTarget,
  type ScraperTaskArtifact,
  type ScraperTaskVersion,
} from './catalog.js';
import { canonicalDigest } from './crypto.js';
import { isRecord, readJsonDocument } from './documents.js';
import type { Fail } from './errors.js';
import { encryptSecret } from './keys.js';
import { openPlatform } from './session.js';
import { isValidSelector, parseSelector, pathAllows, staticPathPrefix } from './scraper-engine.js';

const NAME_MINIMUM = 2;
const NAME_MAXIMUM = 128;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/u;
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const TIMEOUT_CEILING_MS = 15_000;
const BYTE_CEILING = 8_388_608;
const RECORD_CEILING = 100_000;
const PAGE_CEILING = 100;

/** Every fact a Scraper Task Version pins, parsed from its administrator-supplied document. */
export interface ScraperTaskInput {
  target: ScraperTarget;
  network_scope: ScraperNetworkScope;
  output: ScraperOutput;
  parameters: ScraperParameter[];
  fixtures: ScraperFixtureSet;
  constraints: ScraperConstraints;
  credential_refs: string[];
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** The path prefixes a path template can read under, static part first. */
function readScope(parsed: unknown, target: ScraperTarget, fail: Fail): ScraperNetworkScope {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'A Scraper Task must declare the approved network scope.');
  }
  const origins = parsed['origins'];
  const paths = parsed['paths'];
  if (!Array.isArray(origins) || origins.length === 0 || origins.some((origin) => typeof origin !== 'string')) {
    fail('SCRAPER_TASK_INVALID', 'The approved network scope must name at least one origin.');
  }
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((path) => typeof path !== 'string' || !path.startsWith('/'))) {
    fail('SCRAPER_TASK_INVALID', 'The approved network scope must name at least one absolute path prefix.');
  }
  const targetOrigin = originOf(target.base_url);
  if (targetOrigin === null || !(origins as string[]).includes(targetOrigin)) {
    fail(
      'SCRAPER_NETWORK_SCOPE_NOT_APPROVED',
      'The target origin is not inside the approved network scope of this Scraper Task.',
    );
  }
  const staticPath = staticPathPrefix(target.path);
  if (!pathAllows(paths as string[], staticPath)) {
    fail(
      'SCRAPER_NETWORK_SCOPE_NOT_APPROVED',
      'The target path is not inside the approved network scope of this Scraper Task.',
    );
  }
  return { origins: [...(origins as string[])], paths: [...(paths as string[])] };
}

function readTarget(parsed: unknown, fail: Fail): ScraperTarget {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'A Scraper Task must declare its target.');
  }
  const baseUrl = parsed['base_url'];
  if (typeof baseUrl !== 'string' || originOf(baseUrl) !== baseUrl) {
    fail('SCRAPER_TASK_INVALID', 'The target base URL must be one http or https origin, without a path.');
  }
  const path = parsed['path'];
  if (typeof path !== 'string' || !path.startsWith('/')) {
    fail('SCRAPER_TASK_INVALID', 'The target path must be an absolute path on the target origin.');
  }
  const pageParameter = parsed['page_parameter'] ?? null;
  if (pageParameter !== null && (typeof pageParameter !== 'string' || !IDENTIFIER.test(pageParameter))) {
    fail('SCRAPER_TASK_INVALID', 'The page parameter must be a lowercase identifier.');
  }
  const firstPage = parsed['first_page'] ?? 1;
  if (!Number.isInteger(firstPage) || (firstPage as number) < 1) {
    fail('SCRAPER_TASK_INVALID', 'The first page must be a whole number from 1.');
  }
  const maxPages = parsed['max_pages'] ?? 1;
  if (!Number.isInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > PAGE_CEILING) {
    fail('SCRAPER_TASK_INVALID', `The maximum pages must be a whole number from 1 to ${PAGE_CEILING}.`);
  }
  const pageSize = parsed['page_size'] ?? null;
  const pageSizeParameter = parsed['page_size_parameter'] ?? null;
  if (pageSize !== null && (!Number.isInteger(pageSize) || (pageSize as number) < 1)) {
    fail('SCRAPER_TASK_INVALID', 'The page size must be a whole number from 1.');
  }
  if (pageSizeParameter !== null && (typeof pageSizeParameter !== 'string' || !IDENTIFIER.test(pageSizeParameter))) {
    fail('SCRAPER_TASK_INVALID', 'The page size parameter must be a lowercase identifier.');
  }
  if ((pageSize === null) !== (pageSizeParameter === null)) {
    fail('SCRAPER_TASK_INVALID', 'A declared page size and its parameter are stated together.');
  }
  return {
    base_url: baseUrl,
    path,
    page_parameter: pageParameter as string | null,
    first_page: firstPage as number,
    page_size: pageSize as number | null,
    page_size_parameter: pageSizeParameter as string | null,
    max_pages: maxPages as number,
  };
}

function readOutputField(parsed: unknown, fail: Fail): ScraperOutputField {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'Each output field must be an object.');
  }
  const name = parsed['name'];
  const selector = parsed['selector'];
  if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
    fail('SCRAPER_TASK_INVALID', 'Each output field name must be a lowercase identifier of up to 64 characters.');
  }
  if (typeof selector !== 'string' || !isValidSelector(selector)) {
    fail('SCRAPER_TASK_INVALID', 'Each output field selector must be element, element.class, or element.class@attribute.');
  }
  return { name, selector };
}

function readOutput(parsed: unknown, fail: Fail): ScraperOutput {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'A Scraper Task must declare its output contract.');
  }
  const recordSelector = parsed['record_selector'];
  if (typeof recordSelector !== 'string' || !isValidSelector(recordSelector) || parseSelector(recordSelector)?.attribute != null) {
    fail('SCRAPER_TASK_INVALID', 'The record selector must name the element that delimits one record.');
  }
  const fields = parsed['fields'];
  if (!Array.isArray(fields) || fields.length === 0) {
    fail('SCRAPER_TASK_INVALID', 'The output contract must declare at least one field.');
  }
  const output: ScraperOutputField[] = [];
  for (const candidate of fields) {
    const field = readOutputField(candidate, fail);
    if (output.some((other) => other.name === field.name)) {
      fail('SCRAPER_TASK_INVALID', 'Each output field name must appear once.');
    }
    output.push(field);
  }
  return { record_selector: recordSelector, fields: output };
}

function readParameters(parsed: unknown, fail: Fail): ScraperParameter[] {
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'Run parameters must be an array.');
  }
  const parameters: ScraperParameter[] = [];
  for (const candidate of parsed) {
    if (!isRecord(candidate)) {
      fail('SCRAPER_TASK_INVALID', 'Each run parameter must be an object.');
    }
    const name = candidate['name'];
    const type = candidate['type'] ?? 'string';
    const required = candidate['required'] ?? false;
    const fallback = candidate['default'] ?? null;
    if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
      fail('SCRAPER_TASK_INVALID', 'Each run parameter name must be a lowercase identifier of up to 64 characters.');
    }
    if (type !== 'string' && type !== 'integer') {
      fail('SCRAPER_TASK_INVALID', 'Each run parameter is either string or integer.');
    }
    if (typeof required !== 'boolean') {
      fail('SCRAPER_TASK_INVALID', 'Each run parameter states whether it is required.');
    }
    if (fallback !== null && (typeof fallback !== 'string' || (type === 'integer' && !/^-?\d+$/u.test(fallback)))) {
      fail('SCRAPER_TASK_INVALID', 'A run parameter default must match the parameter type.');
    }
    if (parameters.some((other) => other.name === name)) {
      fail('SCRAPER_TASK_INVALID', 'Each run parameter name must appear once.');
    }
    parameters.push({ name, type, required, default: fallback as string | null });
  }
  return parameters;
}

/** Every placeholder one path states, so validation can refuse an undeclared one. */
export function placeholdersOf(path: string): string[] {
  return [...path.matchAll(/\{([a-z][a-z0-9_]*)\}/gu)].map((match) => String(match[1]));
}

function readFixtures(parsed: unknown, fail: Fail): ScraperFixtureSet {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'A Scraper Task must pin the fixtures its validation runs against.');
  }
  const version = parsed['version'] ?? 1;
  if (!Number.isInteger(version) || (version as number) < 1) {
    fail('SCRAPER_TASK_INVALID', 'The fixture set version must be a whole number from 1.');
  }
  const pages = parsed['pages'];
  if (!Array.isArray(pages) || pages.length === 0) {
    fail('SCRAPER_TASK_INVALID', 'The fixture set must declare at least one page.');
  }
  const fixtures: ScraperFixturePage[] = [];
  for (const candidate of pages) {
    if (!isRecord(candidate)) {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page must be an object.');
    }
    const name = candidate['name'];
    const path = candidate['path'];
    const contentType = candidate['content_type'] ?? 'text/html';
    const body = candidate['body'];
    const expected = candidate['expected_record_count'];
    if (typeof name !== 'string' || name.trim().length === 0) {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page must name itself.');
    }
    if (typeof path !== 'string' || !path.startsWith('/')) {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page must state an absolute path.');
    }
    if (contentType !== 'text/html') {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page must declare the text/html content it answers with.');
    }
    if (typeof body !== 'string' || body.length === 0) {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page must carry the response body it freezes.');
    }
    if (!Number.isInteger(expected) || (expected as number) < 0) {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page must state how many records it produces.');
    }
    if (fixtures.some((other) => other.name === name)) {
      fail('SCRAPER_TASK_INVALID', 'Each fixture page name must appear once.');
    }
    let expectedRecords: Array<Record<string, string>> | undefined;
    const stated = candidate['expected_records'];
    if (stated !== undefined) {
      if (!Array.isArray(stated) || stated.some((record) => !isRecord(record))) {
        fail('SCRAPER_TASK_INVALID', 'A fixture page states its expected records as an array of objects.');
      }
      expectedRecords = (stated as unknown[]).map((record) => {
        const cells: Record<string, string> = {};
        for (const [key, value] of Object.entries(record as Record<string, unknown>)) {
          if (typeof value !== 'string') {
            fail('SCRAPER_TASK_INVALID', 'A fixture expected record holds string cells only.');
          }
          cells[key] = value;
        }
        return cells;
      });
    }
    fixtures.push({
      name,
      path,
      content_type: 'text/html',
      body,
      expected_record_count: expected as number,
      ...(expectedRecords === undefined ? {} : { expected_records: expectedRecords }),
    });
  }
  return { version: version as number, pages: fixtures };
}

function readConstraints(parsed: unknown, fail: Fail): ScraperConstraints {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'A Scraper Task must declare its operational constraints.');
  }
  const timeout = parsed['timeout_ms'] ?? 5_000;
  const maxBytes = parsed['max_bytes'] ?? 1_048_576;
  const maxRecords = parsed['max_records'] ?? 10_000;
  if (!Number.isInteger(timeout) || (timeout as number) < 100 || (timeout as number) > TIMEOUT_CEILING_MS) {
    fail('SCRAPER_TASK_INVALID', `The timeout must be a whole number of milliseconds from 100 to ${TIMEOUT_CEILING_MS}.`);
  }
  if (!Number.isInteger(maxBytes) || (maxBytes as number) < 1 || (maxBytes as number) > BYTE_CEILING) {
    fail('SCRAPER_TASK_INVALID', `The maximum bytes must be a whole number from 1 to ${BYTE_CEILING}.`);
  }
  if (!Number.isInteger(maxRecords) || (maxRecords as number) < 1 || (maxRecords as number) > RECORD_CEILING) {
    fail('SCRAPER_TASK_INVALID', `The maximum records must be a whole number from 1 to ${RECORD_CEILING}.`);
  }
  return { timeout_ms: timeout as number, max_bytes: maxBytes as number, max_records: maxRecords as number };
}

function readCredentialRefs(parsed: unknown, fail: Fail): string[] {
  if (parsed === undefined || parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.some((ref) => typeof ref !== 'string' || ref.trim().length === 0)) {
    fail('SCRAPER_TASK_INVALID', 'Credential references must be a list of stored credential names.');
  }
  const refs = (parsed as string[]).map((ref) => ref.trim());
  if (new Set(refs).size !== refs.length) {
    fail('SCRAPER_TASK_INVALID', 'Each credential reference must appear once.');
  }
  return refs;
}

/**
 * Validates one Scraper Task document. Publication and compilation share this
 * parser, so a candidate never invents a second Task model.
 */
export function parseScraperTask(parsed: unknown, fail: Fail): ScraperTaskInput {
  if (!isRecord(parsed)) {
    fail('SCRAPER_TASK_INVALID', 'A Scraper Task must be a JSON object.');
  }
  const target = readTarget(parsed['target'], fail);
  const networkScope = readScope(parsed['network_scope'], target, fail);
  const output = readOutput(parsed['output'], fail);
  const parameters = readParameters(parsed['parameters'], fail);
  const declared = new Set(parameters.map((parameter) => parameter.name));
  for (const placeholder of placeholdersOf(target.path)) {
    if (!declared.has(placeholder)) {
      fail('SCRAPER_TASK_INVALID', `The target path names the undeclared run parameter ${placeholder}.`);
    }
  }
  const fixtures = readFixtures(parsed['fixtures'], fail);
  const constraints = readConstraints(parsed['constraints'], fail);
  const credentialRefs = readCredentialRefs(parsed['credential_refs'], fail);
  return {
    target,
    network_scope: networkScope,
    output,
    parameters,
    fixtures,
    constraints,
    credential_refs: credentialRefs,
  };
}

/** Publishes one immutable Scraper Task Version from an administrator-supplied document. */
export function publishScraperTask(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  name: string;
  configPath: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'scraper_task_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.name,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const fail: Fail = (code, message, nextStep) => reject(session, actorLabel(actor.user), context, code, message, nextStep);

  const name = options.name.trim();
  if (name.length < NAME_MINIMUM || name.length > NAME_MAXIMUM) {
    fail('SCRAPER_TASK_NAME_INVALID', 'A Scraper Task name must contain 2 to 128 characters.');
  }
  const parsed = readJsonDocument(
    options.configPath,
    fail,
    'SCRAPER_TASK_UNREADABLE',
    'The Scraper Task document must contain valid JSON.',
  );
  const input = parseScraperTask(parsed, fail);

  let task = session.state.scraper_tasks.find(
    (candidate) => candidate.workspace_id === options.workspaceId && candidate.name.toLowerCase() === name.toLowerCase(),
  );
  if (!task) {
    task = {
      scraper_task_id: randomUUID(),
      workspace_id: options.workspaceId,
      name,
      owner_user_id: actor.user.user_id,
      created_at: new Date().toISOString(),
      versions: [],
    } satisfies ScraperTaskArtifact;
    session.state.scraper_tasks.push(task);
  }
  const fixturesHash = canonicalDigest(input.fixtures);
  const content = {
    version: (latestScraperTaskVersion(task)?.version ?? 0) + 1,
    published_at: new Date().toISOString(),
    published_by: actor.user.user_id,
    target: input.target,
    network_scope: input.network_scope,
    output: input.output,
    parameters: input.parameters,
    fixtures: input.fixtures,
    constraints: input.constraints,
    credential_refs: input.credential_refs,
    fixtures_hash: fixturesHash,
  };
  const version: ScraperTaskVersion = { ...content, content_hash: canonicalDigest(content) };
  task.versions.push(version);
  const scoped: ActionContext = { ...context, target: task.scraper_task_id };
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      scraper_task_version: version.version,
      content_hash: version.content_hash,
      fixtures_version: version.fixtures.version,
      fixtures_hash: version.fixtures_hash,
      output_fields: version.output.fields.length,
      credential_refs: version.credential_refs.length,
    },
  });
  session.save();
  return viewTask(task, version);
}

/** One Scraper Task Version and every fact it pins, never a credential value. */
export function viewTask(task: ScraperTaskArtifact, version: ScraperTaskVersion): Record<string, unknown> {
  return {
    scraper_task_id: task.scraper_task_id,
    workspace_id: task.workspace_id,
    name: task.name,
    scraper_task_version: version.version,
    content_hash: version.content_hash,
    fixtures_version: version.fixtures.version,
    fixtures_hash: version.fixtures_hash,
    target: { ...version.target },
    network_scope: { origins: [...version.network_scope.origins], paths: [...version.network_scope.paths] },
    output: {
      record_selector: version.output.record_selector,
      fields: version.output.fields.map((field) => ({ ...field })),
    },
    parameters: version.parameters.map((parameter) => ({ ...parameter })),
    constraints: { ...version.constraints },
    credential_refs: [...version.credential_refs],
    fixture_count: version.fixtures.pages.length,
    version_count: task.versions.length,
  };
}

/** Reads one Scraper Task Artifact and, when named, one exact Version. */
export function showScraperTask(options: {
  root: string;
  masterKey: string;
  token: string;
  taskId: string;
  version?: number;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = { action: 'scraper_task_read', scope: 'workspace', target: options.taskId };
  const actor = resolveActor(session, options.token, context);
  const task = session.state.scraper_tasks.find((candidate) => candidate.scraper_task_id === options.taskId);
  if (!task) {
    reject(session, actorLabel(actor.user), context, 'SCRAPER_TASK_NOT_FOUND', 'The requested Scraper Task does not exist.');
  }
  const scoped: ActionContext = { ...context, workspace_id: task.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, task.workspace_id);
  const version = options.version === undefined
    ? latestScraperTaskVersion(task)
    : task.versions.find((candidate) => candidate.version === options.version);
  if (!version) {
    reject(session, actorLabel(actor.user), scoped, 'SCRAPER_TASK_NOT_FOUND', 'The requested Scraper Task Version does not exist.');
  }
  session.audit({ ...scoped, actor: actorLabel(actor.user), outcome: 'succeeded', detail: { scraper_task_version: version.version } });
  return {
    ...viewTask(task, version),
    versions: task.versions.map((candidate) => ({
      scraper_task_version: candidate.version,
      content_hash: candidate.content_hash,
      published_at: candidate.published_at,
      fixtures_version: candidate.fixtures.version,
      fixtures_hash: candidate.fixtures_hash,
    })),
  };
}

/** Stores one credential reference a Scraper Service may present; the value stays sealed. */
export function publishScraperCredential(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  ref: string;
  location: string;
  cookieName?: string;
  credential?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'scraper_credential_publication',
    scope: 'workspace',
    workspace_id: options.workspaceId,
    target: options.ref,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const ref = options.ref.trim();
  if (ref.length < 1 || ref.length > NAME_MAXIMUM) {
    reject(session, actorLabel(actor.user), context, 'SCRAPER_CREDENTIAL_INVALID', 'A credential reference must contain 1 to 128 characters.');
  }
  if (options.location !== 'bearer' && options.location !== 'cookie') {
    reject(session, actorLabel(actor.user), context, 'SCRAPER_CREDENTIAL_INVALID', 'A credential reference is presented as bearer or cookie.');
  }
  const cookieName = options.location === 'cookie' ? (options.cookieName ?? '') : null;
  if (options.location === 'cookie' && !HEADER_NAME.test(cookieName ?? '')) {
    reject(session, actorLabel(actor.user), context, 'SCRAPER_CREDENTIAL_INVALID', 'A cookie credential must name the cookie it is presented in.');
  }
  if (options.credential === undefined || options.credential.length === 0) {
    reject(
      session,
      actorLabel(actor.user),
      context,
      'SCRAPER_CREDENTIAL_REQUIRED',
      'A credential reference is published with its value supplied on standard input.',
      'Publish the credential with --credential-stdin.',
    );
  }
  const sealed = encryptSecret(session.dataKey, options.credential);
  const existing = session.state.scraper_credentials.find(
    (candidate) => candidate.workspace_id === options.workspaceId && candidate.ref === ref,
  );
  const record: ScraperCredentialRecord = {
    ref,
    workspace_id: options.workspaceId,
    location: options.location,
    cookie_name: cookieName,
    sealed,
    created_at: new Date().toISOString(),
    created_by: actorLabel(actor.user),
  };
  if (existing === undefined) session.state.scraper_credentials.push(record);
  else Object.assign(existing, record);
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { location: options.location, cookie_name: cookieName ?? '' },
  });
  session.save();
  return {
    ref,
    workspace_id: options.workspaceId,
    location: options.location,
    cookie_name: cookieName,
    has_value: true,
  };
}
