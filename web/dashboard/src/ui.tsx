import { useEffect, useState, type ReactNode } from 'react'

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  )
}

export function Button({
  children,
  variant = 'ghost',
  ...rest
}: { variant?: 'primary' | 'ghost' | 'danger' } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`btn btn-${variant} ${rest.className ?? ''}`}>
      {children}
    </button>
  )
}

export function Field({
  label,
  hint,
  children,
}: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

/** Colour carries meaning here, so each status also carries its own word. */
export function Status({ value }: { value: string }) {
  const v = value.toLowerCase()
  const tone =
    v === 'delivered' || v === 'sent' || v === 'active' || v === 'verified'
      ? 'ok'
      : v === 'bounced' || v === 'failed' || v === 'disabled'
        ? 'err'
        : v === 'held' || v === 'paused' || v === 'past_due'
          ? 'warn'
          : 'neutral'
  return <span className={`status status-${tone}`}>{v.replace(/_/g, ' ')}</span>
}

export function Check({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`check ${ok ? 'check-ok' : 'check-no'}`} title={ok ? `${label} passes` : `${label} not passing`}>
      {ok ? '✓' : '×'} {label}
    </span>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children}
    </div>
  )
}

export function Banner({ level, children }: { level: 'info' | 'warning' | 'error'; children: ReactNode }) {
  return <div className={`banner banner-${level}`}>{children}</div>
}

/**
 * Secrets are shown exactly once. This makes that unmissable rather than a
 * line of body text the user scrolls past and then cannot recover.
 */
export function RevealOnce({ label, secret, onDone }: { label: string; secret: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="reveal">
      <p className="reveal-warn">
        <strong>Copy this now.</strong> It will not be shown again, and we cannot recover it.
      </p>
      <span className="field-label">{label}</span>
      <div className="reveal-row">
        <code>{secret}</code>
        <Button
          variant="primary"
          onClick={() => {
            void navigator.clipboard.writeText(secret)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <Button onClick={onDone} className="reveal-done">
        I have saved it
      </Button>
    </div>
  )
}

export function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      className="copyable"
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
      }}
    >
      <code>{value}</code>
      <span className="copyable-icon">{copied ? '✓' : '⧉'}</span>
    </button>
  )
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />
}

export function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(iso).toLocaleDateString()
}
