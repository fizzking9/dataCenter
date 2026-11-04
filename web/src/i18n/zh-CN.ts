/**
 * The Simplified Chinese text catalog. Every user-facing string in the browser
 * application comes from here, so a workflow can never ship half-translated.
 */
export const catalog = {
  'app.name': '数据中心运维控制台',
  'app.tagline': '安装后生命周期与只读运行状态',
  'app.skipToContent': '跳到主要内容',
  'app.sessionLabel': '当前运维账号',
  'app.checkingSession': '正在确认会话…',

  'nav.signIn': '登录',
  'nav.enroll': '登记运维账号',
  'nav.console': '运行状态',
  'nav.signOut': '退出登录',

  'signIn.title': '登录运维控制台',
  'signIn.description': '运维账号与平台用户相互独立，登录必须同时提供密码和动态验证码。',
  'signIn.username': '运维账号',
  'signIn.usernameHint': '形如 name@domain，由运维命令行签发登记密钥时指定。',
  'signIn.password': '密码',
  'signIn.otp': '动态验证码',
  'signIn.otpHint': '输入验证器应用生成的 6 位数字，或改用恢复码。',
  'signIn.useRecovery': '改用恢复码',
  'signIn.useOtp': '改回动态验证码',
  'signIn.recoveryCode': '恢复码',
  'signIn.recoveryCodeHint': '每个恢复码只能使用一次。',
  'signIn.submit': '登录',
  'signIn.submitting': '正在登录…',
  'signIn.failed': '登录失败：账号、密码或验证码不正确。',
  'signIn.expired': '会话已失效，请重新登录。',
  'signIn.enrollHint': '尚未登记运维账号？',
  'signIn.enrollLink': '使用登记密钥登记',

  'enroll.title': '登记运维账号',
  'enroll.description': '登记密钥由运维命令行一次性签发，过期或撤销后立即失效。登记过程会同时建立密码和动态验证码。',
  'enroll.secret': '登记密钥',
  'enroll.secretHint': '从命令行输出中复制；密钥只在签发时显示一次。',
  'enroll.secretPrefilled': '已从链接中读取登记密钥，请确认后设置密码。',
  'enroll.password': '设置密码',
  'enroll.passwordHint': '长度 12 到 1024 个字符。',
  'enroll.passwordTooShort': '密码至少需要 12 个字符。',
  'enroll.secretRequired': '请填写登记密钥。',
  'enroll.confirm': '确认密码',
  'enroll.passwordMismatch': '两次输入的密码不一致。',
  'enroll.submit': '登记并生成验证器',
  'enroll.submitting': '正在登记…',
  'enroll.failed': '登记失败，请确认密钥未被使用、未过期且未被撤销。',
  'enroll.expired': '登记密钥已过期，请在命令行重新签发。',
  'enroll.consumed': '登记密钥已被使用，请在命令行重新签发。',
  'enroll.revoked': '登记密钥已被撤销，请在命令行重新签发。',
  'enroll.done.title': '验证器已生成',
  'enroll.done.description': '以下内容只显示这一次，请立即保存到验证器应用和离线位置。',
  'enroll.done.totp': '动态验证码密钥',
  'enroll.done.uri': '验证器链接',
  'enroll.done.recovery': '恢复码',
  'enroll.done.onlyOnce': '离开本页后无法再次查看。',
  'enroll.done.continue': '前往登录',

  'console.title': '运行状态',
  'console.description': '本视图只读取部署健康与许可证状态，不提供任何写入操作。',
  'console.refresh': '刷新',
  'console.refreshing': '正在刷新…',
  'console.unavailable': '暂时无法读取该视图，请稍后重试。',
  'console.empty': '尚未取得数据。',

  'health.title': '部署健康',
  'health.state': '部署状态',
  'health.overall': '健康状况',
  'health.services': '运行服务',
  'health.serviceOpen': '服务开放',
  'health.mfa': '管理员多因素认证',
  'health.defaultCredentials': '默认凭据',
  'health.masterKey': '主密钥外部托管',
  'health.evidence': '证据编号',
  'health.checkedAt': '检查时间',

  'license.title': '许可证',
  'license.id': '许可证编号',
  'license.release': '当前版本',
  'license.highestEligible': '最高可用版本',
  'license.notBefore': '生效时间',
  'license.expiresAt': '到期时间',
  'license.remaining': '剩余天数',
  'license.state': '部署状态',

  'value.yes': '是',
  'value.no': '否',
  'value.healthy': '健康',
  'value.degraded': '降级',
  'value.closed': '已关闭',
  'value.open': '已开放',
  'value.days': '天',
  'value.service.minio': '对象存储 MinIO',
  'value.service.postgres': '数据库 PostgreSQL',
  'value.state.verified_open': '已验证开放',
  'value.state.ready_to_initialize': '等待初始化',
  'value.state.license_required': '等待导入许可证',
  'value.state.initializing': '正在初始化',
  'value.state.closed': '已关闭',

  'error.network': '无法连接运维控制台服务。',
  'error.unknown': '出现未预期的错误，请重试。',
  'error.code': '错误代码',
  'error.retry': '重试',
  // Acquisition status the connector reports: the governed value stays ASCII in
  // the API and the CLI, and only its disclosure is translated here.
  'value.state.queued': '排队中',
  'value.state.running': '采集中',
  'value.state.complete': '已完成',
  'value.state.failed': '失败',
  'value.state.cancelled': '已取消',
  'value.state.intervention_required': '需要人工干预',
  'value.state.valid': '有效',
  'value.state.invalid': '已失效',
  'value.pacing.fifo': '按连接先后排队',
  'value.pacing.serialization': '串行执行中',
  'value.pacing.concurrency': '并发额度已满',
  'value.pacing.interval': '最小间隔未到',
  'value.pacing.rate': '速率额度已满',
  'value.window.fixed': '固定窗口',
  'value.window.incremental': '增量窗口',
  'value.window.backfill': '手工回补',
} as const;

export type MessageKey = keyof typeof catalog;

/** Text lookup; the catalog is the only source of user-facing copy. */
export function t(key: MessageKey): string {
  return catalog[key];
}

/** Looks up an optional value key, so unknown server codes never leak raw English. */
export function optional(key: string): string | undefined {
  return Object.hasOwn(catalog, key) ? catalog[key as MessageKey] : undefined;
}