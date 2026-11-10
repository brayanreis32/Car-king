import { createContext, useCallback, useContext, useEffect, useState } from 'react'

// ---------- Ícones (traço simples, sem dependências) ----------
const paths = {
  dashboard: 'M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z',
  gavel: 'M14 3l7 7-3 3-7-7zM10 7l7 7M5 21l7-7M3 21h8',
  car: 'M5 17h14M3 13l2-6a2 2 0 0 1 2-1h10a2 2 0 0 1 2 1l2 6v5h-3v-2H6v2H3zM7 13h.01M17 13h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  money: 'M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  plus: 'M12 5v14M5 12h14',
  back: 'M15 18l-6-6 6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  close: 'M18 6L6 18M6 6l12 12',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
}
export function Icon({ name, size }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={size ? { width: size, height: size } : undefined}>
      <path d={paths[name]} />
    </svg>
  )
}

// Logo oficial (feita para fundo preto)
export function Brand() {
  return (
    <div className="logo-banner">
      <img src="./logo.webp" alt="Car King Auto Sales" width="900" height="262" />
    </div>
  )
}

export const Badge = ({ tone = '', children }) => <span className={`badge ${tone}`}>{children}</span>
export const Spinner = () => <div className="spinner" />
export const Empty = ({ title, children }) => (
  <div className="empty"><div style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</div>{children && <div className="small" style={{ marginTop: 6 }}>{children}</div>}</div>
)
export const ErrorBox = ({ error }) => (error ? <div className="alert-box error">{String(error.message || error)}</div> : null)

export function Kpi({ label, value, hint, tone, highlight }) {
  return (
    <div className={`kpi ${highlight ? 'highlight' : ''}`}>
      <div className="label">{label}</div>
      <div className={`value ${tone || ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Field({ label, children, span, full }) {
  return (
    <div className={`field ${span ? 'span-2' : ''} ${full ? 'full' : ''}`}>
      {label && <label>{label}</label>}
      {children}
    </div>
  )
}

export function MoneyInput({ value, onChange, placeholder, ...rest }) {
  return (
    <div className="money-input">
      <span>$</span>
      <input type="number" inputMode="decimal" step="0.01" min="0" value={value ?? ''} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  )
}

export function Select({ value, onChange, options, placeholder, ...rest }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs">
      {tabs.map(([key, text]) => (
        <button key={key} className={active === key ? 'active' : ''} onClick={() => onChange(key)}>{text}</button>
      ))}
    </div>
  )
}

export function Modal({ title, onClose, children, footer }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head"><h2>{title}</h2><button className="btn-ghost btn-sm" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button></div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

// ---------- Avisos rápidos ----------
const ToastCtx = createContext(() => {})
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)
  const show = useCallback((text, tone = 'success') => {
    setToast({ text, tone })
    setTimeout(() => setToast(null), tone === 'error' ? 6000 : 3000)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

// ---------- Carregamento de dados ----------
export function useLoad(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: null }))
    loader().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    )
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return { ...state, reload: () => setTick((t) => t + 1) }
}

// Executa uma ação mostrando erro/sucesso
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const run = async (fn, successMsg) => {
    setBusy(true)
    try {
      const r = await fn()
      if (successMsg) toast(successMsg)
      return r
    } catch (e) {
      toast(e.message || String(e), 'error')
      throw e
    } finally {
      setBusy(false)
    }
  }
  return [run, busy]
}
