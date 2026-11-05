import { useCallback, useEffect, useState } from 'react';
import { consoleApi, type SessionView } from './api.js';
import { t } from './i18n/zh-CN.js';
import { PlatformApp } from './PlatformApp.js';
import { ConsoleScreen } from './screens/ConsoleScreen.js';
import { EnrollmentScreen } from './screens/EnrollmentScreen.js';
import { LifecycleScreen } from './screens/LifecycleScreen.js';
import { SignInScreen } from './screens/SignInScreen.js';
import { Shell } from './ui/Shell.js';

type Path = '/' | '/upgrade' | '/enroll';

function currentPath(): Path {
  const pathname = window.location.pathname.replace(/\/+$/u, '');
  if (pathname === '/enroll') return '/enroll';
  if (pathname === '/upgrade') return '/upgrade';
  return '/';
}

/** The enrolment secret arrives in the fragment, so it never reaches the server log. */
function fragmentSecret(): string {
  return window.location.hash.replace(/^#/u, '');
}

/**
 * Two browser applications share one build and one origin: the Operator Console
 * (a separate authentication channel) at `/`, and the platform User application
 * at `/app`. Neither ever reads the other's session.
 */
export function App() {
  const pathname = window.location.pathname.replace(/\/+$/u, '');
  return pathname === '/app' || pathname.startsWith('/app/') ? <PlatformApp /> : <OperatorApp />;
}

function OperatorApp() {
  const [path, setPath] = useState<Path>(currentPath);
  const [fragment, setFragment] = useState<string>(fragmentSecret);
  const [session, setSession] = useState<SessionView | null>(null);
  const [checking, setChecking] = useState(true);
  const [expired, setExpired] = useState(false);

  const navigate = useCallback((next: Path) => {
    window.history.pushState({}, '', next);
    setPath(next);
  }, []);

  // A regenerated enrollment link changes only the fragment, which does not
  // reload the page, so the new secret still has to reach the form.
  useEffect(() => {
    const sync = () => {
      setPath(currentPath());
      setFragment(fragmentSecret());
    };
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, []);

  useEffect(() => {
    let active = true;
    void consoleApi.session().then((result) => {
      if (!active) return;
      if (result.ok) setSession(result.data);
      setChecking(false);
    });
    return () => {
      active = false;
    };
  }, []);

  const sessionLost = useCallback(() => {
    setSession(null);
    setExpired(true);
    navigate('/');
  }, [navigate]);

  const signOut = useCallback(async () => {
    await consoleApi.signOut();
    setSession(null);
    setExpired(false);
    navigate('/');
  }, [navigate]);

  if (checking) {
    return (
      <Shell>
        <p className="empty" role="status">
          {t('app.checkingSession')}
        </p>
      </Shell>
    );
  }

  if (path === '/enroll') {
    return (
      <Shell>
        <EnrollmentScreen key={fragment} initialSecret={fragment} onContinue={() => navigate('/')} />
      </Shell>
    );
  }

  if (session) {
    return (
      <Shell account={session.username} onSignOut={() => void signOut()}>
        <ConsoleNav path={path} onNavigate={navigate} />
        {path === '/upgrade' ? (
          <LifecycleScreen onSessionLost={sessionLost} />
        ) : (
          <ConsoleScreen onSessionLost={sessionLost} />
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <SignInScreen expired={expired} onSignedIn={setSession} onEnroll={() => navigate('/enroll')} />
    </Shell>
  );
}

/** The Operator Console's own navigation, distinct from platform Role navigation. */
function ConsoleNav({ path, onNavigate }: { path: Path; onNavigate: (next: Path) => void }) {
  const link = (target: Path, label: string) => (
    <a
      className={path === target ? 'console-nav__link console-nav__link--active' : 'console-nav__link'}
      href={target}
      aria-current={path === target ? 'page' : undefined}
      onClick={(event) => {
        event.preventDefault();
        onNavigate(target);
      }}
    >
      {label}
    </a>
  );
  return (
    <nav className="console-nav" aria-label={t('console.navLabel')}>
      {link('/', t('nav.console'))}
      {link('/upgrade', t('nav.lifecycle'))}
    </nav>
  );
}
