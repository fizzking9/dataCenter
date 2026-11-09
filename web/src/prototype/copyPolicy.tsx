/**
 * PROTOTYPE — THROWAWAY. Wayfinder ticket #82 "Prototype the concise UI content
 * baseline" (map #77).
 *
 * The question is not "what should these screens look like" but "what content
 * model should every screen default to". So the four variants below keep the
 * real layout, the real CSS, the real navigation and the real Simplified Chinese
 * catalog strings, and disagree only about *where explanation is allowed to sit*:
 * always inline, never, on demand, or graded by whether the sentence is a
 * narrative, an enforced rule, or an input contract.
 *
 * Nothing in this folder is production code. The winning variant's rules get
 * folded into `ui/Panel.tsx`, `ui/Field.tsx` and `ui/Confirm.tsx`, and this
 * folder is deleted.
 */
import type { ReactNode } from 'react';
import { Button } from '../ui/Button.js';
import { DefinitionList } from '../ui/Panel.js';

export type CopyVariant = 'A' | 'B' | 'C' | 'D';

/**
 * What a sentence *is*, which is the only thing the graded policy (D) reads.
 *
 * - `narrative`: explains the domain or the panel's purpose. The navigation and
 *   the title already say where the reader is, so this is the layer that goes.
 * - `rule`: states a constraint the form or the server actually enforces here.
 * - `contract`: states the exact shape an input must have (JSON, path, delimiter,
 *   length bound) or a show-once warning the reader cannot recover from later.
 */
export type CopyKind = 'narrative' | 'rule' | 'contract';

export interface Copy {
  /** The string exactly as shipped today. */
  text: string;
  kind: CopyKind;
  /** The rewrite the concise policies use, when the rule keeps the item at all. */
  concise?: string | undefined;
}

export const VARIANTS: CopyVariant[] = ['A', 'B', 'C', 'D'];

export interface CopyPolicy {
  key: CopyVariant;
  name: string;
  /** The one claim this variant makes about default content. */
  claim: string;
  /** The global rules the variant encodes, rendered beside the screens. */
  rules: string[];
  panelDescription: 'always' | 'never' | 'disclosure' | 'graded';
  fieldHint: 'always' | 'never' | 'disclosure' | 'graded';
  /** Whether the generic Confirmation preamble survives. */
  confirmationPreamble: boolean;
}

export const POLICIES: Record<CopyVariant, CopyPolicy> = {
  A: {
    key: 'A',
    name: '现状',
    claim: '每个面板都自述用途，每个字段都自带提示。',
    rules: [
      '面板说明始终显示，页面级与嵌套级一视同仁。',
      '字段提示始终显示，不区分格式契约与背景叙述。',
      '空状态一句话说明现状并指出下一步。',
      '确认面板保留通用前言，再列对象、范围与影响。',
      '错误与警告完整成句。',
    ],
    panelDescription: 'always',
    fieldHint: 'always',
    confirmationPreamble: true,
  },
  B: {
    key: 'B',
    name: '剥离',
    claim: '默认只有标题、标签、数据与错误。',
    rules: [
      '面板说明一律不显示，标题承担全部定位。',
      '字段提示一律不显示，标签必须自足。',
      '空状态只陈述事实，不给下一步指引。',
      '确认面板去掉通用前言，只列对象、范围与影响。',
      '错误与警告保留完整句子：出错是唯一已经赢得解释的时刻。',
    ],
    panelDescription: 'never',
    fieldHint: 'never',
    confirmationPreamble: false,
  },
  C: {
    key: 'C',
    name: '按需',
    claim: '解释不消失，只是默认折叠。',
    rules: [
      '面板说明折叠进标题右侧的「说明」 disclosure，需要时展开。',
      '字段提示折叠进标签旁的小 disclosure；输入框始终用 aria-describedby 指向它。',
      '空状态默认只显示事实，指引折叠在 disclosure 内。',
      '确认面板的通用前言折叠，对象、范围与影响保持展开。',
      '错误与警告永不折叠。',
    ],
    panelDescription: 'disclosure',
    fieldHint: 'disclosure',
    confirmationPreamble: false,
  },
  D: {
    key: 'D',
    name: '分级',
    claim: '删叙述，留规则与契约，并改写得更短。',
    rules: [
      '页面级面板说明一律删除：导航与标题已经说明位置。',
      '嵌套面板说明只在陈述本表单实际强制的规则时保留，且改写至 20 字以内。',
      '字段提示只在承载格式契约（JSON、路径、分隔符、长度）或只显示一次的警告时保留。',
      '空状态一句话说明事实，并直接点出解决它的操作。',
      '确认面板删除通用前言；对象、范围、影响三行原样保留。',
      '错误保留完整句子，并在存在恢复步骤时附上该步骤。',
    ],
    panelDescription: 'graded',
    fieldHint: 'graded',
    confirmationPreamble: false,
  },
};

export function policyOf(variant: CopyVariant): CopyPolicy {
  return POLICIES[variant];
}

/** Does this panel description survive, and in which words? */
export function panelDescriptionOf(
  policy: CopyPolicy,
  level: 1 | 2,
  copy: Copy | undefined,
): string | null {
  if (copy === undefined) return null;
  switch (policy.panelDescription) {
    case 'always':
      return copy.text;
    case 'never':
      return null;
    case 'disclosure':
      return copy.text;
    case 'graded':
      return level === 2 && copy.kind === 'rule' ? (copy.concise ?? copy.text) : null;
  }
}

/** Does this field hint survive, and in which words? */
export function fieldHintOf(policy: CopyPolicy, copy: Copy | undefined): string | null {
  if (copy === undefined) return null;
  switch (policy.fieldHint) {
    case 'always':
      return copy.text;
    case 'never':
      return null;
    case 'disclosure':
      return copy.text;
    case 'graded':
      return copy.kind === 'contract' ? (copy.concise ?? copy.text) : null;
  }
}

/** Visible characters the policy spends on one content item. */
export type CopyRole = 'panel' | 'hint' | 'empty' | 'preamble';

export interface CopyItem {
  role: CopyRole;
  level?: 1 | 2 | undefined;
  copy: Copy;
}

function charsOf(value: string | null): number {
  return value === null ? 0 : value.length;
}

/**
 * The objective readout in the switcher: how much prose is on screen by default.
 * Variant C scores zero because its content is collapsed until asked for.
 */
export function visibleChars(policy: CopyPolicy, items: CopyItem[]): number {
  let total = 0;
  for (const item of items) {
    if (item.role === 'panel') {
      total += charsOf(panelDescriptionOf(policy, item.level ?? 2, item.copy));
    } else if (item.role === 'hint') {
      total += charsOf(fieldHintOf(policy, item.copy));
    } else if (item.role === 'preamble') {
      total += policy.confirmationPreamble ? item.copy.text.length : 0;
    } else {
      total += policy.key === 'A' ? item.copy.text.length : (item.copy.concise ?? item.copy.text).length;
    }
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Policy-bearing primitives: mirrors of the real ones, plus the policy. */
/* ------------------------------------------------------------------ */

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="proto-disclosure">
      <summary className="proto-disclosure__summary">{label}</summary>
      <div className="proto-disclosure__body">{children}</div>
    </details>
  );
}

export interface ProtoPanelProps {
  title: string;
  description?: Copy | undefined;
  level?: 1 | 2;
  policy: CopyPolicy;
  children: ReactNode;
}

/** Same DOM as `ui/Panel.tsx`; only the description's fate differs. */
export function ProtoPanel({ title, description, level = 2, policy, children }: ProtoPanelProps) {
  const headingId = `panel-${title.replace(/\s+/gu, '-')}`;
  const Heading = level === 1 ? 'h1' : 'h2';
  const text = panelDescriptionOf(policy, level, description);
  const collapsed = text !== null && policy.panelDescription === 'disclosure';
  return (
    <section className="panel" aria-labelledby={headingId}>
      <header className="panel__header">
        <div>
          <Heading className={level === 1 ? 'panel__title panel__title--page' : 'panel__title'} id={headingId}>
            {title}
          </Heading>
          {text === null || collapsed ? null : <p className="panel__description">{text}</p>}
        </div>
        {collapsed ? (
          <Disclosure label="说明">
            <p className="panel__description">{text}</p>
          </Disclosure>
        ) : null}
      </header>
      <div className="panel__body">{children}</div>
    </section>
  );
}

export interface ProtoFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: Copy | undefined;
  error?: string | undefined;
  mono?: boolean;
  area?: boolean;
  policy: CopyPolicy;
}

/** Same DOM as `ui/Field.tsx`; only the hint's fate differs. */
export function ProtoField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  mono = false,
  area = false,
  policy,
}: ProtoFieldProps) {
  const text = fieldHintOf(policy, hint);
  const collapsed = text !== null && policy.fieldHint === 'disclosure';
  const describedBy = [collapsed || text === null ? '' : `${id}-hint`, error ? `${id}-error` : '']
    .filter(Boolean)
    .join(' ');
  const inputClass = [
    'field__input',
    mono ? 'field__input--mono' : '',
    area ? 'field__input--area' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const shared = {
    className: inputClass,
    id,
    name: id,
    value,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy === '' ? undefined : describedBy,
    spellCheck: false,
  };
  return (
    <div className="field">
      <div className="proto-field__labelrow">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        {collapsed ? (
          <Disclosure label="格式">
            <p className="field__hint" id={`${id}-hint`}>
              {text}
            </p>
          </Disclosure>
        ) : null}
      </div>
      {area ? <textarea rows={6} {...shared} /> : <input type="text" autoComplete="off" maxLength={1024} {...shared} />}
      {text === null || collapsed ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {text}
        </p>
      )}
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface ProtoEmptyProps {
  copy: Copy;
  policy: CopyPolicy;
  /** The action that resolves the empty state, named by variant D's rule. */
  action?: { label: string; onClick: () => void } | undefined;
}

/**
 * The empty state. A keeps the shipped sentence; B states the fact only; C
 * collapses the guidance; D states the fact and names the way out.
 */
export function ProtoEmpty({ copy, policy, action }: ProtoEmptyProps) {
  const fact = copy.concise ?? copy.text;
  if (policy.key === 'A') return <p className="empty">{copy.text}</p>;
  if (policy.key === 'C') {
    return (
      <div className="proto-empty">
        <p className="empty">{fact}</p>
        <Disclosure label="怎么办">
          <p className="field__hint">{copy.text}</p>
        </Disclosure>
      </div>
    );
  }
  if (policy.key === 'D' && action !== undefined) {
    return (
      <p className="empty">
        {fact}
        <button className="link proto-empty__action" type="button" onClick={action.onClick}>
          {action.label}
        </button>
      </p>
    );
  }
  return <p className="empty">{fact}</p>;
}

export interface ProtoConfirmationProps {
  title: string;
  target: string;
  scope: string;
  consequence: string;
  preamble: Copy;
  confirmLabel: string;
  policy: CopyPolicy;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Same DOM as `ui/Confirm.tsx`; only the generic preamble's fate differs. */
export function ProtoConfirmation({
  title,
  target,
  scope,
  consequence,
  preamble,
  confirmLabel,
  policy,
  onConfirm,
  onCancel,
}: ProtoConfirmationProps) {
  return (
    <ProtoPanel level={2} title={title} policy={policy}>
      {policy.confirmationPreamble ? (
        <p className="panel__description">{preamble.text}</p>
      ) : policy.panelDescription === 'disclosure' ? (
        <Disclosure label="说明">
          <p className="panel__description">{preamble.text}</p>
        </Disclosure>
      ) : null}
      <DefinitionList
        rows={[
          { term: '对象', value: target, mono: true },
          { term: '范围', value: scope },
          { term: '影响', value: consequence },
        ]}
      />
      <div className="form__actions">
        <Button onClick={onConfirm}>{confirmLabel}</Button>
        <Button variant="quiet" onClick={onCancel}>
          取消
        </Button>
      </div>
    </ProtoPanel>
  );
}
