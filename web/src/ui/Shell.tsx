import type { ReactNode } from 'react';
import { t } from '../i18n/zh-CN.js';
import { Button } from './Button.js';

export interface ShellProps {
  /** The surface may name itself; both default to the Operator Console copy. */
  name?: string;
  tagline?: string;
  account?: string;
  accountLabel?: string;
  onSignOut?: () => void;
  children: ReactNode;
}

/** The application frame: skip link, deployment identity, and the main landmark. */
export function Shell({ name, tagline, account, accountLabel, onSignOut, children }: ShellProps) {
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <header className="topbar">
        <div className="topbar__identity">
          <span className="topbar__mark" aria-hidden="true">
            {t('app.mark')}
          </span>
          <span className="topbar__titles">
            <span className="topbar__name">{name ?? t('app.name')}</span>
            <span className="topbar__tagline">{tagline ?? t('app.tagline')}</span>
          </span>
        </div>
        {account && onSignOut ? (
          <div className="topbar__account">
            <span className="topbar__account-label">{accountLabel ?? t('app.sessionLabel')}</span>
            <span className="topbar__account-name">{account}</span>
            <Button variant="quiet" onClick={onSignOut}>
              {t('nav.signOut')}
            </Button>
          </div>
        ) : null}
      </header>
      <main className="main" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
