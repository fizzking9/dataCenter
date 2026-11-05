import { useCallback, useEffect, useState } from 'react';
import {
  platformApi,
  type BindableModelProfile,
  type ModelBindingView,
  type ModelProfileEvaluationView,
  type ModelProfileView,
  type WorkspaceModelBindingList,
} from '../api.js';
import { formatInstant } from '../format.js';
import { t, type MessageKey } from '../i18n/zh-CN.js';
import { Button } from '../ui/Button.js';
import { Field } from '../ui/Field.js';
import { Alert, DefinitionList, Panel, StatusPill } from '../ui/Panel.js';

/** Governed values stay ASCII; only the label a reader sees is Chinese. */
const PURPOSES = ['integration_proposal', 'grounded_narration', 'clarification'] as const;
const DATA_CATEGORIES = ['dataset_schema', 'cleaning_rules', 'source_mapping', 'sample_records'] as const;
const ADAPTERS = ['hosted', 'generic_local'] as const;

/**
 * The three prompts a Version pins by default. Each one names Simplified Chinese
 * outright, because a prompt that does not is refused at publication.
 */
const DEFAULT_PROMPTS: Record<string, string> = {
  integration_proposal: '你是数据集成助手，只输出简体中文说明，并按结构化输出返回候选 Integration Configuration。',
  grounded_narration: '只依据给定证据作答，只输出简体中文叙述，不得推测证据之外的数据。',
  clarification: '只输出简体中文澄清问题，用于补齐缺失的业务范围。',
};

const CHECK_LABELS: Record<string, MessageKey> = {
  preflight: 'model.profile.check.preflight',
  pinned_identity: 'model.profile.check.pinnedIdentity',
  structured_output: 'model.profile.check.structuredOutput',
  constrained_tools: 'model.profile.check.constrainedTools',
  simplified_chinese_prompt: 'model.profile.check.simplifiedChinesePrompt',
  grounded_narration: 'model.profile.check.groundedNarration',
  simplified_chinese_narrative: 'model.profile.check.simplifiedChineseNarrative',
  simplified_chinese_clarification: 'model.profile.check.simplifiedChineseClarification',
};

const ADAPTER_LABELS: Record<string, MessageKey> = {
  hosted: 'model.profile.adapter.hosted',
  generic_local: 'model.profile.adapter.genericLocal',
};

function checkLabel(name: string): string {
  const key = CHECK_LABELS[name];
  return key === undefined ? name : t(key);
}

function adapterLabel(adapter: string): string {
  const key = ADAPTER_LABELS[adapter];
  return key === undefined ? adapter : t(key);
}

interface Notice {
  tone: 'info' | 'error';
  text: string;
  code?: string;
}

function NoticeLine({ notice }: { notice: Notice | null }) {
  if (notice === null) return null;
  return (
    <Alert tone={notice.tone} {...(notice.code === undefined ? {} : { code: notice.code })}>
      {notice.text}
    </Alert>
  );
}

/** The recorded activation evidence, naming every check in Chinese and ASCII. */
function Evidence({ evaluation }: { evaluation: ModelProfileEvaluationView | undefined }) {
  return (
    <div className="evidence">
      <h3 className="subheading">{t('model.profile.evaluation.title')}</h3>
      {evaluation === undefined ? (
        <p className="empty">{t('model.profile.evaluation.empty')}</p>
      ) : (
        <>
          <p className="context__meta">
            <span>
              {t('model.profile.evaluation.evaluatedAt')} {formatInstant(evaluation.evaluated_at)}
            </span>
            <span>
              {t('model.profile.evaluation.evidenceHash')} <code>{evaluation.evidence_hash}</code>
            </span>
          </p>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">{t('model.profile.check.column')}</th>
                <th scope="col">{t('model.profile.check.result')}</th>
                <th scope="col">{t('model.profile.check.detail')}</th>
              </tr>
            </thead>
            <tbody>
              {evaluation.checks.map((check) => (
                <tr key={check.name}>
                  <td>
                    <span>{checkLabel(check.name)}</span>
                    <span className="evidence__code">{check.name}</span>
                  </td>
                  <td>
                    <span
                      className={
                        check.passed ? 'evidence__state evidence__state--passed' : 'evidence__state evidence__state--failed'
                      }
                    >
                      {check.passed ? t('model.profile.check.passed') : t('model.profile.check.failed')}
                    </span>
                  </td>
                  <td className="data-table__mono">{check.detail ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

interface CheckboxGroupProps {
  id: string;
  legend: string;
  hint: string;
  options: readonly string[];
  selected: Record<string, boolean>;
  onToggle: (value: string) => void;
}

/** A governed value set: the ASCII identifier is the label, so nothing is renamed. */
function CheckboxGroup({ id, legend, hint, options, selected, onToggle }: CheckboxGroupProps) {
  return (
    <fieldset className="fieldset">
      <legend className="field__label">{legend}</legend>
      <p className="field__hint">{hint}</p>
      <div className="choices">
        {options.map((option) => (
          <label className="choice" key={option} htmlFor={`${id}-${option}`}>
            <input
              id={`${id}-${option}`}
              type="checkbox"
              checked={selected[option] === true}
              onChange={() => onToggle(option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

interface ProfileDraft {
  name: string;
  adapter: string;
  endpointUrl: string;
  modelId: string;
  credential: string;
  tools: string;
  maxOutputBytes: string;
  purposes: Record<string, boolean>;
  dataCategories: Record<string, boolean>;
  prompts: Record<string, string>;
}

const INITIAL_DRAFT: ProfileDraft = {
  name: '',
  adapter: 'hosted',
  endpointUrl: '',
  modelId: '',
  credential: '',
  tools: 'read_data_dictionary, read_governed_result',
  maxOutputBytes: '65536',
  purposes: { integration_proposal: true, grounded_narration: true, clarification: true },
  dataCategories: {
    dataset_schema: true,
    cleaning_rules: true,
    source_mapping: true,
    sample_records: true,
  },
  prompts: { ...DEFAULT_PROMPTS },
};

interface ProfilePanelProps {
  profile: ModelProfileView;
  onRefresh: () => Promise<boolean>;
  onSessionLost: () => void;
}

/** One Model Profile: what the latest Version pins, its evidence, and its gates. */
function ProfilePanel({ profile, onRefresh, onSessionLost }: ProfilePanelProps) {
  const [pending, setPending] = useState<'evaluate' | 'activate' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const latest = profile.versions[profile.versions.length - 1];

  const latestEvaluation = latest === undefined
    ? undefined
    : [...profile.evaluations]
      .reverse()
      .find(
        (evaluation) => evaluation.model_profile_version === latest.model_profile_version
          && evaluation.model_profile_content_hash === latest.content_hash,
      );

  async function evaluate() {
    if (latest === undefined || pending !== null) return;
    setPending('evaluate');
    setNotice(null);
    const result = await platformApi.evaluateModelProfile(profile.model_profile_id, latest.model_profile_version);
    if (!result.ok) {
      setPending(null);
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: t('model.profile.evaluateRequestFailed'), code: result.error.code });
      return;
    }
    // The stored evidence has to be on screen before the notice claims a result.
    const refreshed = await onRefresh();
    setPending(null);
    if (!refreshed) {
      setNotice({ tone: 'error', text: t('model.profile.evaluateRequestFailed') });
      return;
    }
    setNotice({
      tone: result.data.passed ? 'info' : 'error',
      text: result.data.passed ? t('model.profile.evaluation.passed') : t('model.profile.evaluation.failed'),
    });
  }

  async function activate() {
    if (latest === undefined || pending !== null) return;
    setPending('activate');
    setNotice(null);
    const result = await platformApi.activateModelProfile(profile.model_profile_id, latest.model_profile_version);
    if (!result.ok) {
      setPending(null);
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      const refused = result.error.code === 'MODEL_PROFILE_EVALUATION_FAILED'
        || result.error.code === 'MODEL_PROFILE_EVALUATION_REQUIRED';
      setNotice({
        tone: 'error',
        text: refused ? t('model.profile.activationRefused') : t('model.profile.activationRequestFailed'),
        code: result.error.code,
      });
      return;
    }
    const refreshed = await onRefresh();
    setPending(null);
    if (!refreshed) {
      setNotice({ tone: 'error', text: t('model.profile.activationRequestFailed') });
      return;
    }
    setNotice({ tone: 'info', text: t('model.profile.activatedNotice') });
  }

  if (latest === undefined) return null;

  return (
    <Panel title={profile.name}>
      <NoticeLine notice={notice} />
      <h3 className="subheading">{t('model.profile.versionHistory')}</h3>
      <DefinitionList
        rows={[
          {
            term: t('model.profile.activated'),
            value: profile.activated_version === null ? t('model.profile.notActivated') : String(profile.activated_version),
          },
          { term: t('model.profile.version'), value: `v${latest.model_profile_version}` },
          {
            term: t('model.profile.adapter'),
            value: (
              <>
                {adapterLabel(latest.adapter)} <code>{latest.adapter}</code>
              </>
            ),
          },
          { term: t('model.profile.modelId'), value: latest.model_id, mono: true },
          { term: t('model.profile.purposes'), value: latest.purposes.join(', ') },
          { term: t('model.profile.dataCategories'), value: latest.data_categories.join(', ') },
          { term: t('model.profile.tools'), value: latest.tools.length === 0 ? '—' : latest.tools.join(', ') },
          { term: t('model.profile.maxOutputBytes'), value: String(latest.max_output_bytes) },
          {
            term: t('model.profile.credentialRef'),
            value: latest.has_credential ? latest.credential_ref : '—',
            mono: true,
          },
          { term: t('model.profile.contentHash'), value: latest.content_hash, mono: true },
          { term: t('model.profile.publishedAt'), value: formatInstant(latest.published_at) },
        ]}
      />
      <div className="form__actions">
        <Button variant="secondary" busy={pending === 'evaluate'} onClick={() => void evaluate()}>
          {pending === 'evaluate' ? t('model.profile.evaluating') : t('model.profile.evaluate')}
        </Button>
        <Button busy={pending === 'activate'} onClick={() => void activate()}>
          {pending === 'activate' ? t('model.profile.activating') : t('model.profile.activate')}
        </Button>
      </div>
      <p className="field__hint">{t('model.profile.evaluateHint')}</p>
      <Evidence evaluation={latestEvaluation} />
    </Panel>
  );
}

/** The Deployment Administrator's Model Profile surface. */
export function DeploymentModelProfiles({ onSessionLost }: { onSessionLost: () => void }) {
  const [profiles, setProfiles] = useState<ModelProfileView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<ProfileDraft>(INITIAL_DRAFT);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    const result = await platformApi.modelProfiles();
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return false;
      }
      setFailed(true);
      return false;
    }
    setFailed(false);
    setProfiles(result.data.model_profiles);
    return true;
  }, [onSessionLost]);

  useEffect(() => {
    let active = true;
    void platformApi.modelProfiles().then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setProfiles(result.data.model_profiles);
    });
    return () => {
      active = false;
    };
  }, [onSessionLost]);

  async function publish() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    const purposes = PURPOSES.filter((purpose) => draft.purposes[purpose] === true);
    const result = await platformApi.publishModelProfile({
      name: draft.name.trim(),
      adapter: draft.adapter,
      endpoint_url: draft.endpointUrl.trim(),
      model_id: draft.modelId.trim(),
      purposes,
      data_categories: DATA_CATEGORIES.filter((category) => draft.dataCategories[category] === true),
      tools: draft.tools.split(',').map((tool) => tool.trim()).filter((tool) => tool !== ''),
      max_output_bytes: Number(draft.maxOutputBytes),
      prompts: Object.fromEntries(purposes.map((purpose) => [purpose, draft.prompts[purpose] ?? ''])),
      ...(draft.credential.trim() === '' ? {} : { credential: draft.credential }),
    });
    if (!result.ok) {
      setPending(false);
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: t('model.profile.publishRequestFailed'), code: result.error.code });
      return;
    }
    // The credential is write-only: once the Version pins it, the browser forgets it.
    setDraft((current) => ({ ...current, credential: '' }));
    const refreshed = await refresh();
    setPending(false);
    if (!refreshed) {
      setNotice({ tone: 'error', text: t('model.profile.publishRequestFailed') });
      return;
    }
    setNotice({ tone: 'info', text: t('model.profile.published') });
  }

  function toggle(field: 'purposes' | 'dataCategories', value: string) {
    setDraft((current) => ({ ...current, [field]: { ...current[field], [value]: current[field][value] !== true } }));
  }

  return (
    <Panel level={1} title={t('model.profile.title')} description={t('model.profile.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      <NoticeLine notice={notice} />
      <Panel title={t('model.profile.newVersion')}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void publish();
          }}
        >
          <div className="form__grid">
            <Field
              id="model-profile-name"
              label={t('model.profile.name')}
              hint={t('model.profile.nameHint')}
              value={draft.name}
              onChange={(value) => setDraft((current) => ({ ...current, name: value }))}
              maxLength={120}
            />
            <div className="field">
              <label className="field__label" htmlFor="model-profile-adapter">
                {t('model.profile.adapter')}
              </label>
              <select
                className="field__input"
                id="model-profile-adapter"
                value={draft.adapter}
                onChange={(event) => setDraft((current) => ({ ...current, adapter: event.target.value }))}
              >
                {ADAPTERS.map((adapter) => (
                  <option value={adapter} key={adapter}>
                    {adapterLabel(adapter)}
                  </option>
                ))}
              </select>
            </div>
            <Field
              id="model-profile-endpoint"
              label={t('model.profile.endpoint')}
              hint={t('model.profile.endpointHint')}
              value={draft.endpointUrl}
              onChange={(value) => setDraft((current) => ({ ...current, endpointUrl: value }))}
              mono
            />
            <Field
              id="model-profile-model-id"
              label={t('model.profile.modelId')}
              hint={t('model.profile.modelIdHint')}
              value={draft.modelId}
              onChange={(value) => setDraft((current) => ({ ...current, modelId: value }))}
              mono
            />
            <Field
              id="model-profile-credential"
              label={t('model.profile.credential')}
              hint={t('model.profile.credentialHint')}
              type="password"
              value={draft.credential}
              onChange={(value) => setDraft((current) => ({ ...current, credential: value }))}
              autoComplete="new-password"
            />
            <Field
              id="model-profile-tools"
              label={t('model.profile.tools')}
              hint={t('model.profile.toolsHint')}
              value={draft.tools}
              onChange={(value) => setDraft((current) => ({ ...current, tools: value }))}
              mono
            />
            <Field
              id="model-profile-max-output"
              label={t('model.profile.maxOutputBytes')}
              value={draft.maxOutputBytes}
              onChange={(value) => setDraft((current) => ({ ...current, maxOutputBytes: value }))}
              inputMode="numeric"
            />
          </div>
          <CheckboxGroup
            id="model-profile-purpose"
            legend={t('model.profile.purposes')}
            hint={t('model.profile.purposesHint')}
            options={PURPOSES}
            selected={draft.purposes}
            onToggle={(value) => toggle('purposes', value)}
          />
          <CheckboxGroup
            id="model-profile-category"
            legend={t('model.profile.dataCategories')}
            hint={t('model.profile.dataCategoriesHint')}
            options={DATA_CATEGORIES}
            selected={draft.dataCategories}
            onToggle={(value) => toggle('dataCategories', value)}
          />
          <fieldset className="fieldset">
            <legend className="field__label">{t('model.profile.prompts')}</legend>
            <p className="field__hint">{t('model.profile.prompt.simplifiedChineseRequired')}</p>
            {PURPOSES.map((purpose) => (
              <div className="field" key={purpose}>
                <label className="field__label" htmlFor={`model-profile-prompt-${purpose}`}>
                  {t('model.profile.prompts')} · {purpose}
                </label>
                <textarea
                  className="field__input field__input--area"
                  id={`model-profile-prompt-${purpose}`}
                  value={draft.prompts[purpose] ?? ''}
                  rows={2}
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      prompts: { ...current.prompts, [purpose]: event.target.value },
                    }))
                  }
                />
              </div>
            ))}
          </fieldset>
          <div className="form__actions">
            <Button type="submit" busy={pending}>
              {pending ? t('model.profile.publishing') : t('model.profile.publish')}
            </Button>
          </div>
        </form>
      </Panel>
      {profiles === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : profiles.length === 0 ? (
        <p className="empty">{t('model.profile.empty')}</p>
      ) : (
        profiles.map((profile) => (
          <ProfilePanel
            key={profile.model_profile_id}
            profile={profile}
            onRefresh={refresh}
            onSessionLost={onSessionLost}
          />
        ))
      )}
    </Panel>
  );
}

interface BindingPanelProps {
  binding: ModelBindingView;
  onRevoked: () => Promise<boolean>;
  onSessionLost: () => void;
}

/** One Binding: the Profile it references and the scope it narrows it to. */
function BindingPanel({ binding, onRevoked, onSessionLost }: BindingPanelProps) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const revoked = binding.revoked_at !== null;

  async function revoke() {
    if (pending) return;
    setPending(true);
    setNotice(null);
    const result = await platformApi.revokeModelBinding(binding.binding_id);
    if (!result.ok) {
      setPending(false);
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: t('binding.revokeRequestFailed'), code: result.error.code });
      return;
    }
    const refreshed = await onRevoked();
    setPending(false);
    if (!refreshed) {
      setNotice({ tone: 'error', text: t('binding.revokeRequestFailed') });
      return;
    }
    setNotice({ tone: 'info', text: t('binding.revokedNotice') });
  }

  return (
    <Panel title={`${t('binding.region')} ${binding.binding_id}`}>
      <p className="binding__state">
        <StatusPill tone={revoked ? 'warn' : 'ok'} label={revoked ? t('binding.revoked') : t('binding.active')} />
      </p>
      <NoticeLine notice={notice} />
      <DefinitionList
        rows={[
          { term: t('binding.modelProfileName'), value: binding.model_profile_name ?? binding.model_profile_id },
          { term: t('binding.version'), value: `v${binding.model_profile_version}` },
          { term: t('binding.purposes'), value: binding.purposes.join(', ') },
          { term: t('binding.dataCategories'), value: binding.data_categories.join(', ') },
          {
            term: t('binding.preflight'),
            value: binding.preflight.passed ? t('binding.preflight.passed') : t('binding.preflight.failed'),
          },
          { term: t('binding.createdBy'), value: binding.created_by },
          { term: t('binding.createdAt'), value: formatInstant(binding.created_at) },
        ]}
      />
      <p className="field__hint">{t('binding.credentialsHidden')}</p>
      {revoked ? null : (
        <div className="form__actions">
          <Button variant="secondary" busy={pending} onClick={() => void revoke()}>
            {pending ? t('binding.revoking') : t('binding.revoke')}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/** The Workspace Administrator's Binding surface: references only, never settings. */
export function WorkspaceModelBindings({
  workspaceId,
  onSessionLost,
}: {
  workspaceId: string;
  onSessionLost: () => void;
}) {
  const [list, setList] = useState<WorkspaceModelBindingList | null>(null);
  const [failed, setFailed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [purposes, setPurposes] = useState<Record<string, boolean>>({});
  const [categories, setCategories] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const refresh = useCallback(async (): Promise<boolean> => {
    const result = await platformApi.modelBindings(workspaceId);
    if (!result.ok) {
      if (result.status === 401) {
        onSessionLost();
        return false;
      }
      setFailed(true);
      return false;
    }
    setFailed(false);
    setList(result.data);
    setSelectedId((current) => {
      const stillThere = result.data.model_profiles.some((profile) => profile.model_profile_id === current);
      return stillThere ? current : (result.data.model_profiles[0]?.model_profile_id ?? null);
    });
    return true;
  }, [workspaceId, onSessionLost]);

  useEffect(() => {
    let active = true;
    setList(null);
    setFailed(false);
    void platformApi.modelBindings(workspaceId).then((result) => {
      if (!active) return;
      if (!result.ok) {
        if (result.status === 401) {
          onSessionLost();
          return;
        }
        setFailed(true);
        return;
      }
      setList(result.data);
      setSelectedId(result.data.model_profiles[0]?.model_profile_id ?? null);
    });
    return () => {
      active = false;
    };
  }, [workspaceId, onSessionLost]);

  const bindable: BindableModelProfile[] = list?.model_profiles ?? [];
  const selected = bindable.find((profile) => profile.model_profile_id === selectedId);

  async function create() {
    if (selected === undefined || pending) return;
    const allowedPurposes = selected.purposes.filter((purpose) => purposes[purpose] === true);
    const allowedCategories = selected.data_categories.filter((category) => categories[category] === true);
    if (allowedPurposes.length === 0 || allowedCategories.length === 0) {
      setNotice({ tone: 'error', text: t('binding.selectionRequired') });
      return;
    }
    setPending(true);
    setNotice(null);
    const result = await platformApi.publishModelBinding(workspaceId, {
      model_profile_id: selected.model_profile_id,
      model_profile_version: selected.model_profile_version,
      purposes: allowedPurposes,
      data_categories: allowedCategories,
    });
    if (!result.ok) {
      setPending(false);
      if (result.status === 401) {
        onSessionLost();
        return;
      }
      setNotice({ tone: 'error', text: t('binding.createRequestFailed'), code: result.error.code });
      return;
    }
    const refreshed = await refresh();
    setPending(false);
    if (!refreshed) {
      setNotice({ tone: 'error', text: t('binding.createRequestFailed') });
      return;
    }
    setPurposes({});
    setCategories({});
    setNotice({ tone: 'info', text: t('binding.created') });
  }

  return (
    <Panel level={1} title={t('binding.title')} description={t('binding.description')}>
      {failed ? <Alert tone="error">{t('platform.unavailable')}</Alert> : null}
      <NoticeLine notice={notice} />
      {list === null ? (
        failed ? null : (
          <p className="empty" role="status">
            {t('platform.loading')}
          </p>
        )
      ) : bindable.length === 0 ? (
        <p className="empty">{t('binding.profileEmpty')}</p>
      ) : (
        <Panel title={t('binding.create')}>
          <form
            className="form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="field">
              <label className="field__label" htmlFor="binding-profile">
                {t('binding.profile')}
              </label>
              <select
                className="field__input"
                id="binding-profile"
                value={selected?.model_profile_id ?? ''}
                onChange={(event) => {
                  setSelectedId(event.target.value);
                  setPurposes({});
                  setCategories({});
                }}
              >
                {bindable.map((profile) => (
                  <option value={profile.model_profile_id} key={profile.model_profile_id}>
                    {`${profile.name} · v${profile.model_profile_version}`}
                  </option>
                ))}
              </select>
            </div>
            {selected === undefined ? null : (
              <>
                <CheckboxGroup
                  id="binding-purpose"
                  legend={t('binding.purposes')}
                  hint={t('binding.optionsHint')}
                  options={selected.purposes}
                  selected={purposes}
                  onToggle={(value) => setPurposes((current) => ({ ...current, [value]: current[value] !== true }))}
                />
                <CheckboxGroup
                  id="binding-category"
                  legend={t('binding.dataCategories')}
                  hint={t('model.profile.dataCategoriesHint')}
                  options={selected.data_categories}
                  selected={categories}
                  onToggle={(value) => setCategories((current) => ({ ...current, [value]: current[value] !== true }))}
                />
              </>
            )}
            <div className="form__actions">
              <Button type="submit" busy={pending}>
                {pending ? t('binding.creating') : t('binding.create')}
              </Button>
            </div>
          </form>
        </Panel>
      )}
      {list === null || list.bindings.length === 0 ? (
        list === null ? null : <p className="empty">{t('binding.empty')}</p>
      ) : (
        <>
          <h3 className="subheading">{t('binding.list')}</h3>
          {list.bindings.map((binding) => (
            <BindingPanel
              key={binding.binding_id}
              binding={binding}
              onRevoked={refresh}
              onSessionLost={onSessionLost}
            />
          ))}
        </>
      )}
    </Panel>
  );
}
