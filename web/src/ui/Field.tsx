export interface FieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  hint?: string;
  error?: string;
  mono?: boolean;
  autoComplete?: string;
  inputMode?: 'text' | 'numeric';
  maxLength?: number;
  autoFocus?: boolean;
}

/** One labelled input, so every workflow shares the same label, hint, and error wiring. */
export function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  hint,
  error,
  mono = false,
  autoComplete,
  inputMode,
  maxLength,
  autoFocus = false,
}: FieldProps) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        className={mono ? 'field__input field__input--mono' : 'field__input'}
        id={id}
        name={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        autoComplete={autoComplete ?? 'off'}
        inputMode={inputMode ?? 'text'}
        maxLength={maxLength ?? 1024}
        autoFocus={autoFocus}
        spellCheck={false}
      />
      {hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}