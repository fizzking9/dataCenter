import type { ReactNode } from 'react';

export interface ButtonProps {
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'quiet';
  type?: 'button' | 'submit';
  busy?: boolean;
  onClick?: () => void;
}

/** The one button primitive: focus, pending, and disabled behaviour are shared. */
export function Button({ children, variant = 'primary', type = 'button', busy = false, onClick }: ButtonProps) {
  return (
    <button
      className={`button button--${variant}`}
      type={type}
      disabled={busy}
      aria-busy={busy || undefined}
      {...(onClick ? { onClick } : {})}
    >
      {children}
    </button>
  );
}