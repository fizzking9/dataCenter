import type { ReactNode } from 'react';
import { t } from '../i18n/zh-CN.js';

export interface AlertProps {
  tone: 'error' | 'warning' | 'info';
  children: ReactNode;
  code?: string;
}

/** Errors assert; everything else announces politely. */
export function Alert({ tone, children, code }: AlertProps) {
  return (
    <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <p className="alert__body">{children}</p>
      {code ? (
        <p className="alert__code">
          {t('error.code')}
          <code>{code}</code>
        </p>
      ) : null}
    </div>
  );
}

export interface PanelProps {
  title: string;
  description?: string;
  /** A page-level panel is the document heading; a nested one stays a section. */
  level?: 1 | 2;
  children: ReactNode;
}

/** A titled region; every console view is composed from these. */
export function Panel({ title, description, level = 2, children }: PanelProps) {
  const headingId = `panel-${title.replace(/\s+/gu, '-')}`;
  const Heading = level === 1 ? 'h1' : 'h2';
  return (
    <section className="panel" aria-labelledby={headingId}>
      <header className="panel__header">
        <div>
          <Heading className={level === 1 ? 'panel__title panel__title--page' : 'panel__title'} id={headingId}>
            {title}
          </Heading>
          {description ? <p className="panel__description">{description}</p> : null}
        </div>
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export interface DefinitionRow {
  term: string;
  value: ReactNode;
  mono?: boolean;
}

/** A dense term/value list, which is how read-only deployment facts read best. */
export function DefinitionList({ rows }: { rows: DefinitionRow[] }) {
  return (
    <dl className="definitions">
      {rows.map((row) => (
        <div className="definitions__row" key={row.term}>
          <dt className="definitions__term">{row.term}</dt>
          <dd className={row.mono ? 'definitions__value definitions__value--mono' : 'definitions__value'}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StatusPill({ tone, label }: { tone: 'ok' | 'warn'; label: string }) {
  return (
    <span className={`pill pill--${tone}`}>
      <span className="pill__dot" aria-hidden="true" />
      {label}
    </span>
  );
}
