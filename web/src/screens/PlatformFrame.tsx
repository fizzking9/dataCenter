import type { ReactNode } from 'react';
import type {
  ActivityCentreView,
  ActivityEntry,
  AuthorizedWorkspace,
  NavigationEntry,
  WorkspaceRoleValue,
} from '../api.js';
import { formatInstant, roleLabel } from '../format.js';
import { optional, t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';

export interface PlatformFrameProps {
  deploymentRole: string | null;
  deployment: NavigationEntry[];
  workspace: NavigationEntry[];
  /** The destination the shell is showing, in the same ASCII keys the server sent. */
  activeKey: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceRole: WorkspaceRoleValue | null;
  workspaces: AuthorizedWorkspace[];
  username: string;
  sessionExpiresAt: string;
  activity: ActivityCentreView;
  refreshing: boolean;
  onNavigate: (href: string) => void;
  onSwitchWorkspace: (workspaceId: string) => void;
  onRefresh: () => void;
  children: ReactNode;
}

/**
 * Every navigation label comes from the catalog by ASCII key, so a surface this
 * build does not name is dropped rather than rendered as raw English.
 */
function labelOf(key: string): string | undefined {
  return optional(`nav.entry.${key}`);
}

function hrefOf(key: string, workspaceId: string | null): string | undefined {
  if (key === 'deployment.workspaces') return '/app/deployment';
  if (key === 'deployment.users') return '/app/deployment/users';
  if (key === 'deployment.modelProfiles') return '/app/deployment/model-profiles';
  if (workspaceId === null || !key.startsWith('workspace.')) return undefined;
  const view = key.slice('workspace.'.length);
  if (view !== 'overview' && view !== 'sources' && view !== 'scrapers' && view !== 'products' && view !== 'context'
    && view !== 'members' && view !== 'audit' && view !== 'models' && view !== 'proposals'
    && view !== 'productProposals' && view !== 'agents') return undefined;
  if (view === 'productProposals') {
    return `/app/w/${encodeURIComponent(workspaceId)}/product-proposals`;
  }
  return `/app/w/${encodeURIComponent(workspaceId)}/${view}`;
}

interface TreeProps {
  label: string;
  entries: NavigationEntry[];
  workspaceId: string | null;
  activeKey: string | null;
  onNavigate: (href: string) => void;
}

/** One navigation tree. Deployment and Workspace trees never merge into one. */
function Tree({ label, entries, workspaceId, activeKey, onNavigate }: TreeProps) {
  const items = entries.flatMap((entry) => {
    const text = labelOf(entry.key);
    const href = hrefOf(entry.key, workspaceId);
    return text === undefined || href === undefined ? [] : [{ key: entry.key, text, href }];
  });
  if (items.length === 0) return null;
  return (
    <nav className="platform-nav" aria-label={label}>
      <ul className="platform-nav__list">
        {items.map((item) => (
          <li key={item.key}>
            <a
              className={item.key === activeKey ? 'platform-nav__link platform-nav__link--active' : 'platform-nav__link'}
              href={item.href}
              {...(item.key === activeKey ? { 'aria-current': 'page' as const } : {})}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onNavigate(item.href);
              }}
            >
              {item.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function ActivityList({ id, title, empty, items }: {
  id: string;
  title: string;
  empty: string;
  items: ActivityEntry[];
}) {
  return (
    <section className="platform-activity__section" aria-labelledby={id}>
      <h3 className="platform-activity__heading" id={id}>
        {title}
      </h3>
      {items.length === 0 ? (
        <p className="platform-activity__empty">{empty}</p>
      ) : (
        <ul className="platform-activity__items">
          {items.map((item) => (
            <li className="platform-activity__item" key={item.activity_id}>
              <span className="platform-activity__state">
                {optional(`value.activity.${item.state}`) ?? item.state}
              </span>
              <span className="platform-activity__since">{formatInstant(item.since)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The persistent shell around every signed-in surface: the active Workspace and
 * session state, the two navigation trees, and the activity centre later tickets
 * extend with their own work.
 */
export function PlatformFrame({
  deploymentRole,
  deployment,
  workspace,
  activeKey,
  workspaceId,
  workspaceName,
  workspaceRole,
  workspaces,
  username,
  sessionExpiresAt,
  activity,
  refreshing,
  onNavigate,
  onSwitchWorkspace,
  onRefresh,
  children,
}: PlatformFrameProps) {
  const role = workspaceRole ?? deploymentRole;
  return (
    <div className="platform">
      <section className="platform-session" aria-label={t('session.current')}>
        <dl className="platform-session__facts">
          <div className="platform-session__fact">
            <dt>{t('session.account')}</dt>
            <dd>{username}</dd>
          </div>
          <div className="platform-session__fact">
            <dt>{t('session.workspace')}</dt>
            <dd>{workspaceName ?? '—'}</dd>
          </div>
          <div className="platform-session__fact">
            <dt>{t('session.role')}</dt>
            <dd>{roleLabel(role)}</dd>
          </div>
          <div className="platform-session__fact">
            <dt>{t('session.expires')}</dt>
            <dd>{formatInstant(sessionExpiresAt)}</dd>
          </div>
        </dl>
        {(workspaceId === null ? workspaces.length > 0 : workspaces.length > 1) ? (
          <div className="platform-session__switch">
            <label className="field__label" htmlFor="platform-workspace-switch">
              {workspaceId === null ? t('picker.title') : t('session.switchWorkspace')}
            </label>
            <select
              className="field__input"
              id="platform-workspace-switch"
              value={workspaceId ?? ''}
              onChange={(event) => {
                if (event.target.value !== '') onSwitchWorkspace(event.target.value);
              }}
            >
              {workspaceId === null ? <option value="">{t('picker.title')}</option> : null}
              {workspaces.map((entry) => (
                <option key={entry.workspace_id} value={entry.workspace_id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </section>

      <div className="platform__body">
        <div className="platform__trees">
          <Tree
            label={t('nav.label.deployment')}
            entries={deployment}
            workspaceId={workspaceId}
            activeKey={activeKey}
            onNavigate={onNavigate}
          />
          <Tree
            label={t('nav.label.workspace')}
            entries={workspace}
            workspaceId={workspaceId}
            activeKey={activeKey}
            onNavigate={onNavigate}
          />
        </div>

        <div className="platform__content">{children}</div>

        <aside className="platform-activity" aria-label={t('activity.title')}>
          <div className="platform-activity__head">
            <h2 className="platform-activity__title">{t('activity.title')}</h2>
            <Button variant="quiet" busy={refreshing} onClick={onRefresh}>
              {refreshing ? t('activity.refreshing') : t('activity.refresh')}
            </Button>
          </div>
          <ActivityList
            id="activity-background"
            title={t('activity.background')}
            empty={t('activity.backgroundEmpty')}
            items={activity.background}
          />
          <ActivityList
            id="activity-attention"
            title={t('activity.attention')}
            empty={t('activity.attentionEmpty')}
            items={activity.attention}
          />
        </aside>
      </div>
    </div>
  );
}
