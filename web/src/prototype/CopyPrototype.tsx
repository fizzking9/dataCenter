/**
 * PROTOTYPE — THROWAWAY. Wayfinder ticket #82 "Prototype the concise UI content
 * baseline" (map #77). Route: `/prototype/copy?variant=A|B|C|D&screen=…`.
 *
 * Four content policies over three faithful screen replicas, inside the real
 * Platform and Operator frames, with the real catalog strings and the real CSS.
 * The bar at the bottom is prototype chrome, not part of the design being judged.
 */
import { useCallback, useEffect, useState } from 'react';
import { t } from '../i18n/zh-CN.js';
import { PlatformFrame } from '../screens/PlatformFrame.js';
import { Shell } from '../ui/Shell.js';
import * as fx from './copyFixtures.js';
import { POLICIES, VARIANTS, visibleChars, type CopyItem, type CopyVariant } from './copyPolicy.js';
import { AgentsScreen, ContextScreen, LicenseScreen } from './copyScreens.js';
import './copy-prototype.css';

type ScreenKey = 'context' | 'agents' | 'license';

const SCREEN_KEYS: ScreenKey[] = ['context', 'agents', 'license'];

interface ScreenEntry {
  key: ScreenKey;
  label: string;
  items: CopyItem[];
}

const SCREENS: ScreenEntry[] = [
  { key: 'context', label: '工作区 · 业务上下文', items: fx.CONTEXT_ITEMS },
  { key: 'agents', label: '工作区 · 代理授权', items: fx.AGENT_ITEMS },
  { key: 'license', label: '运维 · 许可证与续期', items: fx.LICENSE_ITEMS },
];

function screenOf(key: ScreenKey): ScreenEntry {
  const found = SCREENS.find((entry) => entry.key === key);
  return found === undefined ? SCREENS[1]! : found;
}

/** Reads one URL search param and writes it back, so a variant is shareable. */
function useParam<T extends string>(name: string, allowed: readonly T[], fallback: T): [T, (next: T) => void] {
  const read = useCallback((): T => {
    const value = new URLSearchParams(window.location.search).get(name);
    return value !== null && allowed.includes(value as T) ? (value as T) : fallback;
  }, [name, allowed, fallback]);

  const [value, setValue] = useState<T>(read);

  const set = useCallback(
    (next: T) => {
      const params = new URLSearchParams(window.location.search);
      params.set(name, next);
      window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`);
      setValue(next);
    },
    [name],
  );

  useEffect(() => {
    const sync = (): void => setValue(read());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, [read]);

  return [value, set];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

const noop = (): void => {};

export function CopyPrototype() {
  const [variant, setVariant] = useParam<CopyVariant>('variant', VARIANTS, 'A');
  const [screenKey, setScreenKey] = useParam<ScreenKey>('screen', SCREEN_KEYS, 'agents');
  const [rulesOpen, setRulesOpen] = useState(true);

  // The fixed bar would otherwise cover the last panel of a screen.
  useEffect(() => {
    document.body.classList.add('proto-copy-prototype');
    return () => document.body.classList.remove('proto-copy-prototype');
  }, []);

  const policy = POLICIES[variant];
  const screen = screenOf(screenKey);
  const index = VARIANTS.indexOf(variant);

  const cycle = useCallback(
    (step: number): void => {
      const next = VARIANTS[(index + step + VARIANTS.length) % VARIANTS.length];
      if (next !== undefined) setVariant(next);
    },
    [index, setVariant],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (isTypingTarget(event.target)) return;
      if (event.key === 'ArrowLeft') cycle(-1);
      else if (event.key === 'ArrowRight') cycle(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cycle]);

  const chars = visibleChars(policy, screen.items);
  const baseline = visibleChars(POLICIES.A, screen.items);

  const body =
    screenKey === 'context' ? (
      <ContextScreen policy={policy} />
    ) : screenKey === 'license' ? (
      <LicenseScreen policy={policy} />
    ) : (
      <AgentsScreen policy={policy} />
    );

  const framed =
    screenKey === 'license' ? (
      <Shell
        account={fx.OPERATOR_USERNAME}
        accountLabel={t('app.sessionLabel')}
        onSignOut={noop}
      >
        <nav className="console-nav" aria-label={t('console.navLabel')}>
          <a className="console-nav__link" href="/" onClick={(event) => event.preventDefault()}>
            {t('nav.console')}
          </a>
          <a
            className="console-nav__link console-nav__link--active"
            href="/license"
            aria-current="page"
            onClick={(event) => event.preventDefault()}
          >
            {t('nav.license')}
          </a>
          <a className="console-nav__link" href="/upgrade" onClick={(event) => event.preventDefault()}>
            {t('nav.lifecycle')}
          </a>
        </nav>
        {body}
      </Shell>
    ) : (
      <Shell
        name={t('platform.name')}
        tagline={t('platform.tagline')}
        account={fx.FRAME_USERNAME}
        accountLabel={t('platform.accountLabel')}
        onSignOut={noop}
      >
        <PlatformFrame
          deploymentRole={null}
          deployment={fx.FRAME_DEPLOYMENT_NAV}
          workspace={fx.FRAME_WORKSPACE_NAV}
          activeKey={screenKey === 'context' ? 'workspace.context' : 'workspace.agents'}
          workspaceId={fx.FRAME_WORKSPACE_ID}
          workspaceName={fx.FRAME_WORKSPACE_NAME}
          workspaceRole="Workspace Administrator"
          workspaces={fx.FRAME_WORKSPACES}
          username={fx.FRAME_USERNAME}
          sessionExpiresAt={fx.FRAME_SESSION_EXPIRES_AT}
          activity={fx.FRAME_ACTIVITY}
          refreshing={false}
          onNavigate={noop}
          onSwitchWorkspace={noop}
          onRefresh={noop}
        >
          {body}
        </PlatformFrame>
      </Shell>
    );

  return (
    <>
      {framed}

      {rulesOpen ? (
        <aside className="proto-rules" aria-label="当前变体的内容规则">
          <h2 className="proto-rules__title">
            变体 {variant}（{policy.name}）的规则
          </h2>
          <p className="proto-rules__claim">{policy.claim}</p>
          <ol className="proto-rules__list">
            {policy.rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ol>
          {variant === 'C' ? (
            <p className="proto-rules__note">
              待决：折叠内容仍在 DOM 中并保留 aria-describedby，但部分读屏软件会跳过未展开的
              disclosure。若选 C，无障碍规则需要单独定稿。
            </p>
          ) : null}
        </aside>
      ) : null}

      <div className="proto-bar" role="group" aria-label="原型变体切换">
        <div className="proto-bar__row">
          <button className="proto-bar__arrow" type="button" aria-label="上一个变体" onClick={() => cycle(-1)}>
            ←
          </button>
          <span className="proto-bar__label">
            <strong>{variant}</strong>（{policy.name}）· {policy.claim}
          </span>
          <button className="proto-bar__arrow" type="button" aria-label="下一个变体" onClick={() => cycle(1)}>
            →
          </button>
        </div>
        <div className="proto-bar__row">
          {SCREENS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={
                entry.key === screenKey ? 'proto-bar__screen proto-bar__screen--active' : 'proto-bar__screen'
              }
              onClick={() => setScreenKey(entry.key)}
            >
              {entry.label}
            </button>
          ))}
          <span className="proto-bar__metric">
            默认可见说明文案 {String(chars)} 字 / 现状 {String(baseline)} 字
          </span>
          <button className="proto-bar__rules" type="button" onClick={() => setRulesOpen((open) => !open)}>
            {rulesOpen ? '隐藏规则' : '显示规则'}
          </button>
        </div>
      </div>
    </>
  );
}
