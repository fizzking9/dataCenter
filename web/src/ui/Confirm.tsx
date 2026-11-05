import { t } from '../i18n/zh-CN.js';
import { Button } from './Button.js';
import { DefinitionList, Panel } from './Panel.js';

export interface ConfirmationProps {
  /** A heading unique on the page, so the pending action is unambiguous. */
  title: string;
  /** The exact governed identifier the action names. */
  target: string;
  /** The one scope the action reaches. */
  scope: string;
  /** What changes, in the catalog's words, before anything is sent. */
  consequence: string;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The one consequential-action gate: the exact target, the exact scope, and the
 * consequence are stated before the confirmation that performs it. Nothing is
 * sent to the server until the confirmation is pressed.
 */
export function Confirmation({
  title,
  target,
  scope,
  consequence,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmationProps) {
  return (
    <Panel level={2} title={title} description={t('confirm.description')}>
      <DefinitionList
        rows={[
          { term: t('confirm.target'), value: target, mono: true },
          { term: t('confirm.scope'), value: scope },
          { term: t('confirm.consequence'), value: consequence },
        ]}
      />
      <div className="form__actions">
        <Button busy={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
        <Button variant="quiet" busy={busy} onClick={onCancel}>
          {t('confirm.cancel')}
        </Button>
      </div>
    </Panel>
  );
}
