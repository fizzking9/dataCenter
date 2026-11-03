import { useState, type FormEvent } from 'react';
import { consoleApi, type Credentials } from '../api.js';
import { t } from '../i18n/zh-CN.js';
import { Alert, DefinitionList, Panel } from '../ui/Panel.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';

export interface EnrollmentScreenProps {
  initialSecret: string;
  onContinue: () => void;
}

function messageFor(code: string): string {
  switch (code) {
    case 'OPERATOR_ENROLLMENT_EXPIRED':
      return t('enroll.expired');
    case 'OPERATOR_ENROLLMENT_CONSUMED':
      return t('enroll.consumed');
    case 'OPERATOR_ENROLLMENT_REVOKED':
      return t('enroll.revoked');
    case 'OPERATOR_PASSWORD_INVALID':
      return t('enroll.passwordTooShort');
    case 'NETWORK_UNAVAILABLE':
      return t('error.network');
    default:
      return t('enroll.failed');
  }
}

/** Establishes new credentials from a one-time secret; the result is shown once. */
export function EnrollmentScreen({ initialSecret, onContinue }: EnrollmentScreenProps) {
  const [secret, setSecret] = useState(initialSecret);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; code?: string } | null>(null);
  const [credentials, setCredentials] = useState<Credentials | null>(null);
  const mismatch = confirmation !== '' && confirmation !== password;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (secret.trim() === '') {
      setFailure({ message: t('enroll.secretRequired') });
      return;
    }
    if (mismatch) {
      setFailure({ message: t('enroll.passwordMismatch') });
      return;
    }
    setPending(true);
    setFailure(null);
    const result = await consoleApi.enroll({ enrollment_secret: secret.trim(), password });
    setPending(false);
    if (!result.ok) {
      setFailure({ message: messageFor(result.error.code), code: result.error.code });
      return;
    }
    setPassword('');
    setConfirmation('');
    setCredentials(result.data);
  }

  if (credentials) {
    return (
      <div className="screen">
        <Panel title={t('enroll.done.title')} description={t('enroll.done.description')}>
          <Alert tone="warning">{t('enroll.done.onlyOnce')}</Alert>
          <DefinitionList
            rows={[
              { term: t('signIn.username'), value: credentials.username, mono: true },
              { term: t('enroll.done.totp'), value: credentials.totp_secret, mono: true },
              { term: t('enroll.done.uri'), value: credentials.enrollment_uri, mono: true },
            ]}
          />
          <h3 className="subheading">{t('enroll.done.recovery')}</h3>
          <ul className="codes">
            {credentials.recovery_codes.map((code) => (
              <li className="codes__item" key={code}>
                {code}
              </li>
            ))}
          </ul>
          <div className="form__actions">
            <Button onClick={onContinue}>{t('enroll.done.continue')}</Button>
          </div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="screen">
      <Panel title={t('enroll.title')} description={t('enroll.description')}>
        {initialSecret === '' ? null : <Alert tone="info">{t('enroll.secretPrefilled')}</Alert>}
        {failure ? (
          <Alert tone="error" {...(failure.code ? { code: failure.code } : {})}>
            {failure.message}
          </Alert>
        ) : null}
        <form className="form" onSubmit={submit} noValidate>
          <Field
            id="enrollment-secret"
            label={t('enroll.secret')}
            hint={t('enroll.secretHint')}
            value={secret}
            onChange={setSecret}
            mono
            maxLength={256}
            autoFocus={initialSecret === ''}
          />
          <Field
            id="new-password"
            label={t('enroll.password')}
            hint={t('enroll.passwordHint')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
            autoFocus={initialSecret !== ''}
          />
          <Field
            id="confirm-password"
            label={t('enroll.confirm')}
            type="password"
            value={confirmation}
            onChange={setConfirmation}
            autoComplete="new-password"
            {...(mismatch ? { error: t('enroll.passwordMismatch') } : {})}
          />
          <div className="form__actions">
            <Button type="submit" busy={pending}>
              {pending ? t('enroll.submitting') : t('enroll.submit')}
            </Button>
          </div>
        </form>
      </Panel>
    </div>
  );
}