import { randomUUID } from 'node:crypto';
import { resolveActor } from './auth.js';
import {
  actorLabel,
  deny,
  reject,
  requireWorkspaceAdministrator,
  type ActionContext,
} from './authz.js';
import {
  findDataProduct,
  findReportTemplate,
  findReportTemplateVersion,
  type ReportScheduleRecord,
  type ReportScheduleRunRecord,
  type ReportTemplateArtifact,
  type ReportTemplateVersion,
} from './catalog.js';
import { memberReader } from './grants.js';
import {
  findUser,
  findUserById,
  workspaceRoleOf,
  type UserRecord,
} from './platform.js';
import {
  freshStockReport,
  generateReport,
  ReportGenerationFailure,
  servingContract,
} from './reports.js';
import { openPlatform, type PlatformSession } from './session.js';

/** The shortest and longest schedule interval one Template may declare. */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 525_600;

/** The Chinese reason a scheduled run did not produce a Report. */
function runLimitation(code: string): string {
  if (code === 'SCHEDULE_CONSUMER_INACTIVE') return '指定消费者已停用或不存在，本次调度未执行查询。';
  if (code === 'SCHEDULE_CONSUMER_NOT_MEMBER') return '指定消费者已不是该工作空间成员，本次调度未执行查询。';
  if (code === 'SCHEDULE_CONSUMER_UNAUTHORIZED') return '指定消费者的授权已不覆盖该数据产品契约，本次调度未执行查询。';
  if (code === 'REPORT_TEMPLATE_WITHDRAWN') return '报告模板版本已撤回，本次调度不再生成新报告。';
  if (code === 'REPORT_TEMPLATE_NOT_PUBLISHED') return '报告模板当前没有已发布版本，本次调度未生成报告。';
  if (code === 'REPORT_TEMPLATE_NOT_AVAILABLE' || code === 'REPORT_TEMPLATE_VERSION_NOT_FOUND') {
    return '报告模板或指定版本不可用，本次调度未生成报告。';
  }
  if (code === 'DATA_PRODUCT_NOT_PUBLISHED' || code === 'DATA_PRODUCT_NOT_AVAILABLE') {
    return '报告模板对应的数据产品当前不可用，本次调度未生成报告。';
  }
  if (code === 'MODEL_ENDPOINT_UNREACHABLE') return '模型端点当前不可用，本次调度仅保留结构化结果或未生成报告。';
  return '本次调度未能生成报告，已记录原因且未改变任何已发布内容。';
}

function scheduleView(
  session: PlatformSession,
  schedule: ReportScheduleRecord,
): Record<string, unknown> {
  const user = findUserById(session.state, schedule.designated_user_id);
  return {
    schedule_id: schedule.schedule_id,
    workspace_id: schedule.workspace_id,
    report_template_id: schedule.report_template_id,
    template_version: schedule.template_version,
    designated_user_id: schedule.designated_user_id,
    designated_username: user?.username ?? null,
    interval_minutes: schedule.interval_minutes,
    next_due_at: schedule.next_due_at,
    created_at: schedule.created_at,
    created_by: schedule.created_by,
    withdrawn_at: schedule.withdrawn_at,
    runs: schedule.runs.map((run) => ({ ...run })),
  };
}

function runView(run: ReportScheduleRunRecord): Record<string, unknown> {
  return { ...run };
}

/** Records one durable schedule on the Template's current published Version. */
export function createReportSchedule(options: {
  root: string;
  masterKey: string;
  token: string;
  reportTemplateId: string;
  consumerUsername: string;
  intervalMinutes: number;
  startAt?: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_schedule_creation',
    scope: 'workspace',
    target: options.reportTemplateId,
  };
  const actor = resolveActor(session, options.token, context);
  const template = findReportTemplate(session.state.report_templates, options.reportTemplateId);
  if (!template) {
    deny(session, actorLabel(actor.user), context, 'REPORT_TEMPLATE_NOT_AVAILABLE', 'The Report Template is not available to this actor.');
  }
  const scoped: ActionContext = { ...context, workspace_id: template.workspace_id };
  requireWorkspaceAdministrator(session, actor, scoped, template.workspace_id);
  const version = template.published_version === null
    ? undefined
    : findReportTemplateVersion(template, template.published_version);
  if (!version) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_TEMPLATE_NOT_PUBLISHED', 'A schedule needs a published Report Template Version.');
  }
  if (version.withdrawn_at !== null) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_TEMPLATE_WITHDRAWN', 'A withdrawn Report Template Version accepts no schedule.');
  }
  if (!Number.isInteger(options.intervalMinutes)
    || options.intervalMinutes < MIN_INTERVAL_MINUTES
    || options.intervalMinutes > MAX_INTERVAL_MINUTES) {
    reject(
      session,
      actorLabel(actor.user),
      scoped,
      'REPORT_SCHEDULE_INTERVAL_INVALID',
      `A Report schedule must state a whole-number interval from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes.`,
    );
  }
  const consumer = findUser(session.state, options.consumerUsername);
  if (!consumer) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_SCHEDULE_CONSUMER_NOT_FOUND', 'The designated Consumer does not exist.');
  }
  const role = workspaceRoleOf(session.state, consumer.user_id, template.workspace_id);
  if (role === null) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_SCHEDULE_CONSUMER_NOT_MEMBER', 'The designated Consumer is not a member of this Workspace.');
  }
  if (consumer.status !== 'active') {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_SCHEDULE_CONSUMER_INACTIVE', 'The designated Consumer is not active.');
  }
  const start = options.startAt === undefined ? new Date() : new Date(options.startAt);
  if (Number.isNaN(start.getTime())) {
    reject(session, actorLabel(actor.user), scoped, 'REPORT_SCHEDULE_START_INVALID', 'A Report schedule start must be an ISO 8601 instant.');
  }
  const schedule: ReportScheduleRecord = {
    schedule_id: randomUUID(),
    workspace_id: template.workspace_id,
    report_template_id: template.report_template_id,
    template_version: version.version,
    designated_user_id: consumer.user_id,
    interval_minutes: options.intervalMinutes,
    next_due_at: start.toISOString(),
    created_at: new Date().toISOString(),
    created_by: actor.user.user_id,
    withdrawn_at: null,
    runs: [],
  };
  session.state.report_schedules.push(schedule);
  session.audit({
    ...scoped,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: {
      schedule_id: schedule.schedule_id,
      template_version: schedule.template_version,
      interval_minutes: schedule.interval_minutes,
      next_due_at: schedule.next_due_at,
    },
  });
  session.save();
  return {
    summary: '已按指定消费者创建报告计划：每次到期都会重新校验该消费者与授权后再生成。',
    schedule: scheduleView(session, schedule),
  };
}

/** Lists every durable schedule one Workspace governs. */
export function listReportSchedules(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
}): Record<string, unknown> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_schedule_listing',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const schedules = session.state.report_schedules
    .filter((schedule) => schedule.workspace_id === options.workspaceId)
    .map((schedule) => scheduleView(session, schedule));
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { schedules_returned: schedules.length },
  });
  return {
    workspace_id: options.workspaceId,
    summary: `当前工作空间共有 ${schedules.length} 个报告计划，按显式调度检查执行。`,
    schedules,
  };
}

interface DueRun {
  dueFrom: string;
  dueCount: number;
  catchUp: boolean;
}

function dueRunOf(schedule: ReportScheduleRecord, nowMs: number): DueRun | null {
  const dueMs = Date.parse(schedule.next_due_at);
  if (!Number.isFinite(dueMs) || nowMs < dueMs) return null;
  const intervalMs = schedule.interval_minutes * 60_000;
  const steps = Math.floor((nowMs - dueMs) / intervalMs) + 1;
  return {
    dueFrom: schedule.next_due_at,
    dueCount: steps,
    catchUp: steps > 1,
  };
}

/** The next instant strictly after the tick, so one run covers every due overlap. */
function advance(schedule: ReportScheduleRecord, nowMs: number): string {
  const dueMs = Date.parse(schedule.next_due_at);
  const intervalMs = schedule.interval_minutes * 60_000;
  const steps = Math.floor((nowMs - dueMs) / intervalMs) + 1;
  return new Date(dueMs + steps * intervalMs).toISOString();
}

function failedRun(options: {
  schedule: ReportScheduleRecord;
  at: string;
  due: DueRun;
  code: string;
}): ReportScheduleRunRecord {
  return {
    run_id: randomUUID(),
    schedule_id: options.schedule.schedule_id,
    template_version: options.schedule.template_version,
    triggered_at: options.at,
    due_from: options.due.dueFrom,
    due_count: options.due.dueCount,
    catch_up: options.due.catchUp,
    designated_user_id: options.schedule.designated_user_id,
    outcome: 'failed',
    report_id: null,
    reason_code: options.code,
    limitation: runLimitation(options.code),
    scope_fingerprint: null,
  };
}

/** Resolves the Template, Version, and designated reader a due run acts as. */
type ScheduleResolution =
  | { failure: string }
  | {
    failure: null;
    template: ReportTemplateArtifact;
    version: ReportTemplateVersion;
    user: UserRecord;
  };

function runReader(
  session: PlatformSession,
  schedule: ReportScheduleRecord,
): ScheduleResolution {
  const user = findUserById(session.state, schedule.designated_user_id);
  if (!user || user.status !== 'active') {
    return { failure: 'SCHEDULE_CONSUMER_INACTIVE' };
  }
  if (workspaceRoleOf(session.state, user.user_id, schedule.workspace_id) === null) {
    return { failure: 'SCHEDULE_CONSUMER_NOT_MEMBER' };
  }
  const template = findReportTemplate(session.state.report_templates, schedule.report_template_id);
  if (!template) {
    return { failure: 'REPORT_TEMPLATE_NOT_AVAILABLE' };
  }
  if (template.published_version === null) {
    return { failure: 'REPORT_TEMPLATE_NOT_PUBLISHED' };
  }
  const version = findReportTemplateVersion(template, template.published_version);
  if (!version) {
    return { failure: 'REPORT_TEMPLATE_VERSION_NOT_FOUND' };
  }
  if (version.withdrawn_at !== null) {
    return { failure: 'REPORT_TEMPLATE_WITHDRAWN' };
  }
  return { template, version, user, failure: null };
}

/**
 * Evaluates every due Report schedule at one explicit instant.
 *
 * Each due schedule produces at most one run: overlapping ticks coalesce, and
 * any number of missed instants becomes one catch-up. Every run re-resolves the
 * designated Consumer, its membership, its status, and its Grants from current
 * state; it then either reuses fresh stock or generates from the published
 * Template Version. No earlier authorization is remembered.
 */
export async function tickReportSchedules(options: {
  root: string;
  masterKey: string;
  token: string;
  workspaceId: string;
  scheduleId?: string;
  at?: string;
}): Promise<Record<string, unknown>> {
  const session = openPlatform(options.root, options.masterKey);
  const context: ActionContext = {
    action: 'report_schedule_tick',
    scope: 'workspace',
    workspace_id: options.workspaceId,
  };
  const actor = resolveActor(session, options.token, context);
  requireWorkspaceAdministrator(session, actor, context, options.workspaceId);
  const at = options.at ?? new Date().toISOString();
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) {
    reject(session, actorLabel(actor.user), context, 'REPORT_SCHEDULE_AT_INVALID', 'A schedule tick must state an ISO instant.');
  }
  const dueAt = new Date(atMs);
  const runs: ReportScheduleRunRecord[] = [];
  for (const schedule of session.state.report_schedules) {
    if (schedule.workspace_id !== options.workspaceId || schedule.withdrawn_at !== null) continue;
    if (options.scheduleId !== undefined && schedule.schedule_id !== options.scheduleId) continue;
    const due = dueRunOf(schedule, atMs);
    if (due === null) continue;

    const resolved = runReader(session, schedule);
    let run: ReportScheduleRunRecord;
    if (resolved.failure !== null) {
      run = failedRun({ schedule, at, due, code: resolved.failure });
    } else {
      const { template, version, user } = resolved;
      const role = workspaceRoleOf(session.state, user.user_id, schedule.workspace_id);
      const product = findDataProduct(session.state.data_products, version.data_product_id);
      const serving = product === undefined ? null : servingContract(session, product, version.contract_major);
      const reader = memberReader(session, user, role);
      const scope = product === undefined || serving === null ? null : reader.scopeOf(product, serving.contract);
      if (scope === null) {
        run = failedRun({ schedule, at, due, code: 'SCHEDULE_CONSUMER_UNAUTHORIZED' });
      } else {
        const stock = freshStockReport({ session, reader, template, version, now: dueAt });
        if (stock !== null) {
          run = {
            run_id: randomUUID(),
            schedule_id: schedule.schedule_id,
            template_version: version.version,
            triggered_at: at,
            due_from: due.dueFrom,
            due_count: due.dueCount,
            catch_up: due.catchUp,
            designated_user_id: user.user_id,
            outcome: 'reused',
            report_id: stock.report.report_id,
            reason_code: null,
            limitation: null,
            scope_fingerprint: stock.scope.fingerprint,
          };
        } else {
          try {
            const report = await generateReport({
              session,
              actor: { user },
              reader,
              template,
              version,
              now: dueAt,
              trigger: 'scheduled',
            });
            run = {
              run_id: randomUUID(),
              schedule_id: schedule.schedule_id,
              template_version: version.version,
              triggered_at: at,
              due_from: due.dueFrom,
              due_count: due.dueCount,
              catch_up: due.catchUp,
              designated_user_id: user.user_id,
              outcome: 'generated',
              report_id: report.report_id,
              reason_code: null,
              limitation: null,
              scope_fingerprint: report.security.scope_fingerprint,
            };
          } catch (error) {
            const code = error instanceof ReportGenerationFailure ? error.code : 'REPORT_GENERATION_FAILED';
            run = {
              ...failedRun({ schedule, at, due, code }),
              scope_fingerprint: scope.fingerprint,
            };
          }
        }
      }
    }
    schedule.runs.push(run);
    schedule.next_due_at = advance(schedule, atMs);
    runs.push(run);
    session.audit({
      ...context,
      target: schedule.schedule_id,
      actor: actorLabel(actor.user),
      outcome: run.outcome === 'failed' ? 'failed' : 'succeeded',
      detail: {
        run_id: run.run_id,
        template_version: run.template_version,
        outcome: run.outcome,
        due_count: run.due_count,
        catch_up: run.catch_up,
        ...(run.report_id === null ? {} : { report_id: run.report_id }),
        ...(run.reason_code === null ? {} : { reason_code: run.reason_code }),
      },
    });
    // Each run is durable before the next one evaluates: a crash between runs
    // never re-runs a schedule instant that already produced its Report.
    session.save();
  }
  session.audit({
    ...context,
    actor: actorLabel(actor.user),
    outcome: 'succeeded',
    detail: { at, runs: runs.length },
  });
  session.save();
  return {
    at,
    summary: runs.length === 0
      ? '本次调度检查没有到期的报告计划。'
      : `本次调度检查执行了 ${runs.length} 个到期计划；同一计划的多段到期已合并为一次运行。`,
    runs: runs.map(runView),
  };
}
