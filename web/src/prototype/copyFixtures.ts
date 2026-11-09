/**
 * PROTOTYPE — THROWAWAY. Wayfinder ticket #82.
 *
 * The three screens below are faithful replicas: every sentence is the real
 * string from `web/src/i18n/zh-CN.ts`, classified by what it *is* so the graded
 * policy has something to read. Only the data is invented, and only because the
 * prototype must run without a backend.
 */
import type { ActivityCentreView, AuthorizedWorkspace, NavigationEntry } from '../api.js';
import type { Copy, CopyItem } from './copyPolicy.js';

/* ---------------------------------------------------------------- */
/* Screen 1 — 工作区 · 业务上下文 (platform, nested panels + empty)   */
/* ---------------------------------------------------------------- */

export const CONTEXT_PAGE_DESCRIPTION: Copy = {
  text: '当前工作区已发布的业务上下文，不会与其他工作区合并。',
  kind: 'narrative',
};

export const CONTEXT_PUBLISH_DESCRIPTION: Copy = {
  text: '工作区扩展是通用上下文的附加项，不能覆盖通用定义，也不能引用其他工作区。',
  kind: 'rule',
  concise: '仅可新增，不能覆盖通用定义。',
};

export const CONTEXT_HISTORY_EMPTY: Copy = {
  text: '当前工作区尚未发布业务上下文版本。',
  kind: 'narrative',
  concise: '尚无已发布版本。',
};

export const CONTEXT_TABLE_EMPTY: Copy = {
  text: '当前工作区尚未发布业务上下文。',
  kind: 'narrative',
  concise: '尚无已发布条目。',
};

export const CONTEXT_INVALID_JSON = '条目必须是合法的 JSON 数组。';
export const CONTEXT_PUBLISHED = '工作区上下文版本已发布。';

export interface ContextRow {
  key: string;
  value: string;
  unit: string | null;
  source: string;
}

export const CONTEXT_ROWS: ContextRow[] = [
  { key: 'service_sla_hours', value: '4', unit: '小时', source: 'deployment' },
  { key: 'warranty_months', value: '12', unit: '月', source: 'deployment' },
  { key: 'first_line_queue', value: '华东一线', unit: null, source: 'workspace' },
];

export const CONTEXT_ITEMS: CopyItem[] = [
  { role: 'panel', level: 1, copy: CONTEXT_PAGE_DESCRIPTION },
  { role: 'panel', level: 2, copy: CONTEXT_PUBLISH_DESCRIPTION },
  { role: 'empty', copy: CONTEXT_TABLE_EMPTY },
  { role: 'empty', copy: CONTEXT_HISTORY_EMPTY },
];

/* ---------------------------------------------------------------- */
/* Screen 2 — 工作区 · 代理授权 (longest description, contract hints) */
/* ---------------------------------------------------------------- */

export const AGENTS_PAGE_DESCRIPTION: Copy = {
  text: '工作区管理员为绑定到本工作区的外部代理身份发布数据产品授权，并记录或撤销委托同意；委托访问的有效权限始终是代理身份授权与委托用户当前权限的交集。',
  kind: 'narrative',
};

export const AGENTS_GRANT_DESCRIPTION: Copy = {
  text: '授权只缩小代理身份能读取的字段与行，永远不会放大代理身份、委托用户或 OAuth 权限范围。',
  kind: 'rule',
  concise: '只缩小可读取的字段与行，不会放大权限。',
};

export const AGENTS_DELEGATION_DESCRIPTION: Copy = {
  text: '记录我的同意后，代理身份可以代表我在本工作区内读取两侧授权交集允许的数据；我的成员身份、角色或授权变化会在下一次请求时生效。',
  kind: 'narrative',
};

export const AGENTS_COLUMNS_HINT: Copy = {
  text: '用逗号分隔；留空表示契约发布的全部字段。',
  kind: 'contract',
  concise: '逗号分隔；留空表示全部字段。',
};

export const AGENTS_ROW_FILTERS_HINT: Copy = {
  text: '可选；格式与数据产品筛选一致，例如 [{"field":"city","op":"equals","value":"上海"}]。',
  kind: 'contract',
  concise: '例如 [{"field":"city","op":"equals","value":"上海"}]',
};

export const AGENTS_EMPTY: Copy = {
  text: '本工作区尚无绑定到此处的外部代理身份。',
  kind: 'narrative',
  concise: '尚无绑定的代理身份。',
};

export const AGENTS_GRANT_EMPTY_PRODUCTS: Copy = {
  text: '本工作区尚无已发布的数据产品，无法发布代理授权。',
  kind: 'narrative',
  concise: '尚无已发布的数据产品。',
};

export const AGENTS_CONFIRM_PREAMBLE: Copy = {
  text: '此操作会立即生效并记入审计事件，请核对对象、范围与影响。',
  kind: 'narrative',
};

export const AGENTS_GRANT_CONSEQUENCE =
  '该代理身份将只能读取此数据产品中列出的字段与符合条件的行；授权不扩大委托用户自身的权限。';
export const AGENTS_GRANT_FAILED = '数据产品授权发布失败。';

export interface AgentRow {
  name: string;
  scopes: string;
  grants: string;
  delegations: string;
  status: string;
}

export const AGENT_ROWS: AgentRow[] = [
  {
    name: 'agent-aftermarket-east',
    scopes: 'product.read',
    grants: '产品 华东保外维修月报：字段：sn, city, handled_count',
    delegations: '账号 liwei@datacenter（工作区管理员）：生效中',
    status: '已绑定',
  },
];

export const AGENT_ITEMS: CopyItem[] = [
  { role: 'panel', level: 1, copy: AGENTS_PAGE_DESCRIPTION },
  { role: 'panel', level: 2, copy: AGENTS_GRANT_DESCRIPTION },
  { role: 'panel', level: 2, copy: AGENTS_DELEGATION_DESCRIPTION },
  { role: 'hint', copy: AGENTS_COLUMNS_HINT },
  { role: 'hint', copy: AGENTS_ROW_FILTERS_HINT },
  { role: 'empty', copy: AGENTS_EMPTY },
  { role: 'empty', copy: AGENTS_GRANT_EMPTY_PRODUCTS },
  { role: 'preamble', copy: AGENTS_CONFIRM_PREAMBLE },
];

/* ---------------------------------------------------------------- */
/* Screen 3 — 运维控制台 · 许可证导入 (operator shell, warning)       */
/* ---------------------------------------------------------------- */

export const LICENSE_PAGE_DESCRIPTION: Copy = {
  text: '查看当前部署许可证、离线导入续期许可证、核对许可证历史与证据，并确认许可证过期后仍然可用的操作。',
  kind: 'narrative',
};

export const LICENSE_IMPORT_DESCRIPTION: Copy = {
  text: '许可证由提供商离线签发并绑定当前部署。导入前会校验签名、部署绑定、有效期与主机时钟；校验失败时当前许可证保持不变。',
  kind: 'rule',
  concise: '校验失败时当前许可证保持不变。',
};

export const LICENSE_PATH_HINT: Copy = {
  text: '填写本机可读的许可证文件绝对路径，例如可移动介质上的许可证文件。',
  kind: 'contract',
  concise: '本机可读的绝对路径。',
};

export const LICENSE_WARNING = '许可将在 9 天内到期，请离线导入续期许可证。';
export const LICENSE_REFUSED = '导入被拒绝，当前许可证保持不变。';
export const LICENSE_PATH_REQUIRED = '请填写许可证文件路径。';
export const LICENSE_IMPORT_CONSEQUENCE =
  '导入后当前许可证进入许可证历史，服务继续以新许可证运行；业务数据、会话和部署标识保持不变。';

export const LICENSE_ROWS: { term: string; value: string; mono?: boolean }[] = [
  { term: '许可证编号', value: 'LIC-2026-0417-0092', mono: true },
  { term: '当前版本', value: '1.4.0' },
  { term: '到期时间', value: '2026年11月18日 00:00' },
  { term: '许可证状态', value: '有效' },
];

export const LICENSE_ITEMS: CopyItem[] = [
  { role: 'panel', level: 1, copy: LICENSE_PAGE_DESCRIPTION },
  { role: 'panel', level: 2, copy: LICENSE_IMPORT_DESCRIPTION },
  { role: 'hint', copy: LICENSE_PATH_HINT },
  { role: 'preamble', copy: AGENTS_CONFIRM_PREAMBLE },
];

/* ---------------------------------------------------------------- */
/* Frame fixtures, so the replicas sit inside the real shell.         */
/* ---------------------------------------------------------------- */

export const FRAME_USERNAME = 'liwei@datacenter';
export const FRAME_WORKSPACE_ID = 'ws-east';
export const FRAME_WORKSPACE_NAME = '华东售后服务区';
export const FRAME_SESSION_EXPIRES_AT = '2026-11-09T18:30:00.000Z';

export const FRAME_WORKSPACES: AuthorizedWorkspace[] = [
  { workspace_id: FRAME_WORKSPACE_ID, name: FRAME_WORKSPACE_NAME, role: 'Workspace Administrator' },
];

export const FRAME_DEPLOYMENT_NAV: NavigationEntry[] = [
  { key: 'deployment.workspaces' },
  { key: 'deployment.users' },
  { key: 'deployment.modelProfiles' },
  { key: 'deployment.retention' },
];

export const FRAME_WORKSPACE_NAV: NavigationEntry[] = [
  { key: 'workspace.overview' },
  { key: 'workspace.sources' },
  { key: 'workspace.scrapers' },
  { key: 'workspace.products' },
  { key: 'workspace.productGovernance' },
  { key: 'workspace.productProposals' },
  { key: 'workspace.context' },
  { key: 'workspace.nlq' },
  { key: 'workspace.reports' },
  { key: 'workspace.reportGovernance' },
  { key: 'workspace.models' },
  { key: 'workspace.proposals' },
  { key: 'workspace.members' },
  { key: 'workspace.agents' },
  { key: 'workspace.audit' },
  { key: 'workspace.retention' },
];

export const FRAME_ACTIVITY: ActivityCentreView = {
  background: [{ activity_id: 'act-1', kind: 'acquisition.run', state: 'running', since: '2026-11-09T09:12:00.000Z' }],
  attention: [],
};

export const OPERATOR_USERNAME = 'ops@datacenter';
export const OPERATOR_ACCOUNT_LABEL = '当前运维账号';
