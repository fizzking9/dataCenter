import type { AuthorizedWorkspace } from '../api.js';
import { roleLabel } from '../format.js';
import { t } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Panel } from '../ui/Panel.js';

export interface PlatformPickerProps {
  workspaces: AuthorizedWorkspace[];
  onSelect: (workspaceId: string) => void;
}

/**
 * A User who belongs to several Workspaces names one before any content is read;
 * nothing is aggregated across the list.
 */
export function PlatformPicker({ workspaces, onSelect }: PlatformPickerProps) {
  return (
    <Panel level={1} title={t('picker.title')} description={t('picker.description')}>
      {workspaces.length === 0 ? (
        <p className="empty">{t('picker.empty')}</p>
      ) : (
        <ul className="picker">
          {workspaces.map((workspace) => (
            <li className="picker__item" key={workspace.workspace_id}>
              <Button variant="secondary" onClick={() => onSelect(workspace.workspace_id)}>
                {workspace.name}
              </Button>
              <span className="picker__role">{roleLabel(workspace.role)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
