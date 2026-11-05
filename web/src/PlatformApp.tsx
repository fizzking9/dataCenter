import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { platformApi, type NavigationView, type PlatformSessionView } from './api.js';
import { t } from './i18n/zh-CN.js';
import { PlatformDeploymentScreen } from './screens/PlatformDeploymentScreen.js';
import { PlatformFrame } from './screens/PlatformFrame.js';
import { PlatformPicker } from './screens/PlatformPicker.js';
import { PlatformSignInScreen } from './screens/PlatformSignInScreen.js';
import { WorkspaceAudit, WorkspaceMembers } from './screens/PlatformWorkspaceAdminScreen.js';
import { WorkspaceContext, WorkspaceOverview, WorkspaceProducts } from './screens/PlatformWorkspaceScreen.js';
import { Alert, Panel } from './ui/Panel.js';
import { Shell } from './ui/Shell.js';

const VIEWS = ['overview', 'products', 'context', 'members', 'audit'] as const;
type View = (typeof VIEWS)[number];

interface Route {
  workspaceId: string | null;
  view: View;
  /** The deployment tree, which stays reachable whatever Workspaces exist. */
  deployment: boolean;
}

const HOME: Route = { workspaceId: null, view: 'overview', deployment: false };
const DEPLOYMENT: Route = { workspaceId: null, view: 'overview', deployment: true };

function viewOf(value: string | undefined): View {
  switch (value) {
    case 'products':
    case 'context':
    case 'members':
    case 'audit':
      return value;
    default:
      return 'overview';
  }
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * `/app` selects a Workspace, `/app/w/<id>/<view>` names one, and
 * `/app/deployment` is the deployment tree on its own.
 */
function parseRoute(pathname: string): Route {
  const normalized = pathname.replace(/\/+$/u, '');
  if (normalized === '/app/deployment') return DEPLOYMENT;
  const match = /^\/app\/w\/([^/]+)\/([^/]+)$/u.exec(normalized);
  if (match === null) return HOME;
  const id = match[1];
  const view = match[2];
  if (id === undefined || view === undefined) return HOME;
  return { workspaceId: decode(id), view: viewOf(view), deployment: false };
}

function Unavailable() {
  return (
    <Panel level={1} title={t('workspaceUnavailable.title')}>
      <p className="empty">{t('workspaceUnavailable.description')}</p>
    </Panel>
  );
}

/**
 * The platform User application. Every governed decision (who may sign in, which
 * Workspaces exist for this actor, what a Workspace request may return) stays on
 * the server; this component only renders what an authenticated response allowed.
 */
export function PlatformApp() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [session, setSession] = useState<PlatformSessionView | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);
  const [navigation, setNavigation] = useState<NavigationView | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reload, setReload] = useState(0);

  const navigate = useCallback((href: string) => {
    window.history.pushState({}, '', href);
    setRoute(parseRoute(href));
  }, []);

  // A lost or revoked session returns to sign-in on the next request, and the
  // browser forgets which Workspace it was showing.
  const reset = useCallback((lost: boolean) => {
    setSession(null);
    setNavigation(null);
    setFailed(false);
    setExpired(lost);
    window.history.replaceState({}, '', '/app');
    setRoute(HOME);
  }, []);

  const sessionLost = useCallback(() => reset(true), [reset]);

  const signOut = useCallback(async () => {
    await platformApi.signOut();
    reset(false);
  }, [reset]);

  useEffect(() => {
    let active = true;
    void platformApi.session().then((result) => {
      if (!active) return;
      if (result.ok) setSession(result.data);
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  useEffect(() => {
    if (session === null) return;
    let active = true;
    void platformApi.navigation(route.workspaceId ?? undefined).then((result) => {
      if (!active) return;
      setRefreshing(false);
      if (!result.ok) {
        if (result.status === 401) {
          sessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      // One authorized Workspace is selected by itself; several require a choice.
      if (!route.deployment && route.workspaceId === null && result.data.workspaces.length === 1) {
        const only = result.data.workspaces[0];
        if (only !== undefined) {
          const href = `/app/w/${encodeURIComponent(only.workspace_id)}/overview`;
          window.history.replaceState({}, '', href);
          setRoute(parseRoute(href));
          return;
        }
      }
      setFailed(false);
      setNavigation(result.data);
    });
    return () => {
      active = false;
    };
  }, [session, route.workspaceId, route.view, route.deployment, reload, sessionLost]);

  const enterWorkspace = useCallback(
    (workspaceId: string) => navigate(`/app/w/${encodeURIComponent(workspaceId)}/overview`),
    [navigate],
  );

  const refresh = useCallback(() => {
    setRefreshing(true);
    setReload((value) => value + 1);
  }, []);

  const signIn = useCallback((signedIn: PlatformSessionView) => {
    setExpired(false);
    setSession(signedIn);
  }, []);

  const topbar = {
    name: t('platform.name'),
    tagline: t('platform.tagline'),
  } as const;

  if (checking) {
    return (
      <Shell {...topbar}>
        <p className="empty" role="status">
          {t('app.checkingSession')}
        </p>
      </Shell>
    );
  }

  if (session === null) {
    return (
      <Shell {...topbar}>
        <PlatformSignInScreen expired={expired} onSignedIn={signIn} />
      </Shell>
    );
  }

  const chrome = {
    ...topbar,
    account: session.username,
    accountLabel: t('platform.accountLabel'),
    onSignOut: () => void signOut(),
  };

  const frame = (activeKey: string | null, content: ReactNode) => (
    <Shell {...chrome}>
      <PlatformFrame
        deploymentRole={navigation?.deployment_role ?? null}
        deployment={navigation?.deployment ?? []}
        workspace={navigation?.workspace ?? []}
        activeKey={activeKey}
        workspaceId={navigation?.workspace_id ?? null}
        workspaceName={navigation?.workspace_name ?? null}
        workspaceRole={navigation?.workspace_role ?? null}
        workspaces={navigation?.workspaces ?? []}
        username={navigation?.username ?? session.username}
        sessionExpiresAt={navigation?.session_expires_at ?? session.session_expires_at}
        activity={navigation?.activity ?? { background: [], attention: [] }}
        refreshing={refreshing}
        onNavigate={navigate}
        onSwitchWorkspace={enterWorkspace}
        onRefresh={refresh}
      >
        {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
        {content}
      </PlatformFrame>
    </Shell>
  );

  if (navigation === null) {
    return frame(null, failed ? <Unavailable /> : (
      <p className="empty" role="status">
        {t('app.checkingSession')}
      </p>
    ));
  }

  const activeId = navigation.workspace_id;
  const activeName = navigation.workspace_name;
  const activeRole = navigation.workspace_role;

  // A deep link to a Workspace the actor may not enter answers exactly like an
  // identifier that names nothing: no name, no role, no content.
  if (activeId === null && route.workspaceId !== null) {
    return frame(null, <Unavailable />);
  }

  // Deployment-level navigation is its own destination, never a detour through
  // the Workspace picker.
  if (route.deployment) {
    if (navigation.deployment.length === 0) return frame(null, <Unavailable />);
    return frame('deployment.workspaces', <PlatformDeploymentScreen onSessionLost={sessionLost} />);
  }

  if (activeId === null) {
    if (navigation.workspaces.length > 1) {
      return frame(null, <PlatformPicker workspaces={navigation.workspaces} onSelect={enterWorkspace} />);
    }
    if (navigation.deployment.length > 0) {
      return frame('deployment.workspaces', <PlatformDeploymentScreen onSessionLost={sessionLost} />);
    }
    if (navigation.workspaces.length === 0) {
      return frame(
        null,
        <Panel level={1} title={t('workspaceUnavailable.title')}>
          <p className="empty">{t('platform.noWorkspace')}</p>
        </Panel>,
      );
    }
    return frame(null, (
      <p className="empty" role="status">
        {t('app.checkingSession')}
      </p>
    ));
  }

  if (activeName === null || activeRole === null) {
    return frame(null, <Unavailable />);
  }

  const viewKey = `workspace.${route.view}`;
  if (!navigation.workspace.some((entry) => entry.key === viewKey)) {
    return frame(null, <Unavailable />);
  }

  const content = route.view === 'products' ? (
    <WorkspaceProducts workspaceId={activeId} onSessionLost={sessionLost} />
  ) : route.view === 'context' ? (
    <WorkspaceContext workspaceId={activeId} onSessionLost={sessionLost} />
  ) : route.view === 'members' ? (
    <WorkspaceMembers workspaceId={activeId} onSessionLost={sessionLost} />
  ) : route.view === 'audit' ? (
    <WorkspaceAudit workspaceId={activeId} onSessionLost={sessionLost} />
  ) : (
    <WorkspaceOverview
      workspaceName={activeName}
      role={activeRole}
      sessionExpiresAt={navigation.session_expires_at}
    />
  );
  return frame(viewKey, content);
}
