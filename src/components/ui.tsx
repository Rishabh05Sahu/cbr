// Shared, business-agnostic UI primitives (Tailwind). Accessible defaults: every input has a
// label, focus rings are visible, buttons have explicit types.
import {
  cloneElement,
  isValidElement,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export function Button({
  variant = 'primary',
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
}) {
  return (
    <button
      type={type}
      className={cx(
        'tap inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-blue-900 text-white shadow-sm hover:bg-blue-800',
        variant === 'secondary' &&
          'border border-slate-300 bg-white text-slate-900 shadow-sm hover:border-slate-400 hover:bg-slate-50',
        variant === 'danger' && 'bg-red-700 text-white shadow-sm hover:bg-red-600',
        variant === 'ghost' && 'text-slate-700 hover:bg-slate-100',
        className,
      )}
      {...props}
    />
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string[] | undefined;
  children: ReactNode;
}) {
  // A field with an error marks its control invalid and points it at the message (M5 U8).
  const errorId = `${htmlFor}-error`;
  const invalid = Boolean(error?.length);
  const control =
    invalid && isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, { 'aria-invalid': true, 'aria-describedby': errorId })
      : children;
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      {control}
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      {invalid && (
        <div id={errorId}>
          {error!.map((e) => (
            <p key={e} className="text-xs text-red-700" role="alert">
              {e}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/25 disabled:bg-slate-100',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        'block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-600/25 disabled:bg-slate-100',
        className,
      )}
      {...props}
    />
  );
}

export function Card({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm shadow-slate-900/5 sm:p-6">
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Alert({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'error' | 'success' | 'warn';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'rounded-lg border px-3 py-2 text-sm',
        tone === 'info' && 'border-blue-200 bg-blue-50 text-blue-900',
        tone === 'error' && 'border-red-200 bg-red-50 text-red-800',
        tone === 'success' && 'border-green-200 bg-green-50 text-green-800',
        tone === 'warn' && 'border-amber-200 bg-amber-50 text-amber-900',
      )}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warn' | 'good';
}) {
  return (
    <span
      className={cx(
        'inline-flex rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'neutral' && 'bg-slate-100 text-slate-700',
        tone === 'warn' && 'bg-amber-100 text-amber-800',
        tone === 'good' && 'bg-green-100 text-green-800',
      )}
    >
      {children}
    </span>
  );
}

export function PageHeader({ title, description }: { title: string; description?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
      <div aria-hidden="true" className="mt-2 h-0.5 w-12 rounded-full bg-gold-400" />
      {description && <p className="mt-2 text-sm text-slate-600">{description}</p>}
    </header>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-300 bg-white/60 p-6 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}
