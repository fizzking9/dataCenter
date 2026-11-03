import { useCallback, useEffect, useState } from 'react';
import { consoleApi, type SessionView } from './api.js';
import { t } from './i18n/zh-CN.js';
import { ConsoleScreen } from './screens/ConsoleScreen.js';
import { EnrollmentScreen } from './screens/EnrollmentScreen.js';
import { SignInScreen } from './screens/SignInScreen.js';
import { Shell } from './ui/Shell.js';

type Path = '/' | '/enroll';

function currentPath(): Path {
  return window.location.pathname.replace(/\/+$/u, '') === '/enroll' ? '/enroll' : '/';
}

/** The enrolment secret arrives in the fragment, so it never reaches the server log. */
function fragmentSecret(): string {
  return window.location.hash.replace(/^#/u, '');
}

export function App() {
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
        <ConsoleScreen onSessionLost={sessionLost} />
      </Shell>
    );
  }

  return (
    <Shell>
      <SignInScreen expired={expired} onSignedIn={setSession} onEnroll={() => navigate('/enroll')} />
    </Shell>
  );
}