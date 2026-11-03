import { useState, type FormEvent } from 'react';
import { consoleApi, type SessionView } from '../api.js';
import { t } from '../i18n/zh-CN.js';
import { Alert } from '../ui/Panel.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';

export interface SignInScreenProps {
  expired: boolean;
  onSignedIn: (session: SessionView) => void;
  onEnroll: () => void;
}

/** Operator sign-in: a password plus a dynamic code, every time. */
export function SignInScreen({ expired, onSignedIn, onEnroll }: SignInScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setFailure(null);
    const result = await consoleApi.signIn({
      username: username.trim(),
      password,
      ...(useRecoveryCode ? { recovery_code: code.trim() } : { totp: code.trim() }),
    });
    setPending(false);
    if (!result.ok) {
      setFailure(result.status === 0 ? t('error.network') : t('signIn.failed'));
      return;
    }
    setPassword('');
    setCode('');
    onSignedIn(result.data);
  }

  return (
    <div className="screen screen--auth">
      <section className="auth-panel" aria-labelledby="sign-in-title">
        <p className="eyebrow">{t('nav.signIn')}</p>
        <h1 className="auth-panel__title" id="sign-in-title">
          {t('signIn.title')}
        </h1>
        <p className="auth-panel__description">{t('signIn.description')}</p>

        {expired ? <Alert tone="warning">{t('signIn.expired')}</Alert> : null}
        {failure ? <Alert tone="error">{failure}</Alert> : null}

        <form className="form" onSubmit={submit} noValidate>
          <Field
            id="username"
            label={t('signIn.username')}
            hint={t('signIn.usernameHint')}
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
          />
          <Field
            id="password"
            label={t('signIn.password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Field
            id="code"
            label={useRecoveryCode ? t('signIn.recoveryCode') : t('signIn.otp')}
            hint={useRecoveryCode ? t('signIn.recoveryCodeHint') : t('signIn.otpHint')}
            value={code}
            onChange={setCode}
            mono
            inputMode={useRecoveryCode ? 'text' : 'numeric'}
            maxLength={64}
          />
          <div className="form__actions">
            <Button type="submit" busy={pending}>
              {pending ? t('signIn.submitting') : t('signIn.submit')}
            </Button>
            <Button variant="quiet" onClick={() => setUseRecoveryCode(!useRecoveryCode)}>
              {useRecoveryCode ? t('signIn.useOtp') : t('signIn.useRecovery')}
            </Button>
          </div>
        </form>

        <p className="auth-panel__aside">
          {t('signIn.enrollHint')}
          <button className="link" type="button" onClick={onEnroll}>
            {t('signIn.enrollLink')}
          </button>
        </p>
      </section>
    </div>
  );
}