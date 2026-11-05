import { useState, type FormEvent } from 'react';
import { platformApi, type PlatformSessionView } from '../api.js';
import { t } from '../i18n/zh-CN.js';
import { Alert } from '../ui/Panel.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';

export interface PlatformSignInScreenProps {
  expired: boolean;
  onSignedIn: (session: PlatformSessionView) => void;
}

/**
 * Platform User sign-in. The form never learns which part failed: the server has
 * already reduced every failure to one answer, and the browser repeats it as-is.
 */
export function PlatformSignInScreen({ expired, onSignedIn }: PlatformSignInScreenProps) {
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
    const trimmed = code.trim();
    const result = await platformApi.signIn({
      username: username.trim(),
      password,
      ...(trimmed === ''
        ? {}
        : useRecoveryCode
          ? { recovery_code: trimmed }
          : { totp: trimmed }),
    });
    setPending(false);
    if (!result.ok) {
      setFailure(result.status === 0 ? t('error.network') : t('platform.signIn.failed'));
      return;
    }
    setPassword('');
    setCode('');
    onSignedIn(result.data);
  }

  return (
    <div className="screen screen--auth">
      <section className="auth-panel" aria-labelledby="platform-sign-in-title">
        <p className="eyebrow">{t('nav.signIn')}</p>
        <h1 className="auth-panel__title" id="platform-sign-in-title">
          {t('platform.signIn.title')}
        </h1>
        <p className="auth-panel__description">{t('platform.signIn.description')}</p>

        {expired ? <Alert tone="warning">{t('platform.signIn.expired')}</Alert> : null}
        {failure ? <Alert tone="error">{failure}</Alert> : null}

        <form className="form" onSubmit={submit} noValidate>
          <Field
            id="platform-username"
            label={t('platform.signIn.username')}
            hint={t('platform.signIn.usernameHint')}
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoFocus
          />
          <Field
            id="platform-password"
            label={t('platform.signIn.password')}
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Field
            id="platform-code"
            label={useRecoveryCode ? t('platform.signIn.recoveryCode') : t('platform.signIn.otp')}
            hint={useRecoveryCode ? t('platform.signIn.recoveryCodeHint') : t('platform.signIn.otpHint')}
            value={code}
            onChange={setCode}
            mono
            inputMode={useRecoveryCode ? 'text' : 'numeric'}
            maxLength={64}
          />
          <div className="form__actions">
            <Button type="submit" busy={pending}>
              {pending ? t('platform.signIn.submitting') : t('platform.signIn.submit')}
            </Button>
            <Button variant="quiet" onClick={() => setUseRecoveryCode(!useRecoveryCode)}>
              {useRecoveryCode ? t('platform.signIn.useOtp') : t('platform.signIn.useRecovery')}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
