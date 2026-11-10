import { useState } from 'react'
import { rpc, supabase } from '../lib.js'
import { Brand, ErrorBox, Field } from '../components/ui.jsx'

export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError(null)
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) setError(error.message.includes('Invalid login') ? 'E-mail ou senha incorretos.' : error.message)
    setBusy(false)
  }

  const reset = async () => {
    if (!email) { setError('Digite seu e-mail para receber o link de nova senha.'); return }
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin + window.location.pathname })
    if (error) setError(error.message); else setResetSent(true)
  }

  return (
    <div className="login-split login-dark">
      <div className="login-brand">
        <div className="logo-shine">
          <img src="./logo-dark-lg.webp" alt="Car King Auto Sales" width="1100" height="317" />
        </div>
      </div>
      <div className="login-side">
        <form className="login-card" onSubmit={submit}>
          <div className="card stack">
            <h2>Entrar</h2>
            <Field label="E-mail">
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Senha">
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorBox error={error} />
            {resetSent && <div className="alert-box success">Enviamos um link para redefinir a senha.</div>}
            <button className="btn-primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
            <button type="button" className="btn-ghost btn-sm" onClick={reset}>Esqueci minha senha</button>
          </div>
        </form>
      </div>
    </div>
  )
}

// Primeiro acesso de um usuário sem empresa
export function CreateCompany({ onDone }) {
  const [name, setName] = useState('Car King Auto Sales')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState(null)
  const submit = async (e) => {
    e.preventDefault()
    try {
      const { data } = await supabase.auth.getUser()
      await rpc('create_company', { p_company_name: name, p_full_name: fullName, p_email: data.user.email })
      onDone()
    } catch (err) { setError(err) }
  }
  return (
    <div className="login">
      <form className="login-card card stack" onSubmit={submit}>
        <Brand big />
        <h2>Configurar empresa</h2>
        <p className="muted small">Seu usuário ainda não está vinculado a uma empresa.</p>
        <Field label="Nome da empresa"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Seu nome"><input required value={fullName} onChange={(e) => setFullName(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <button className="btn-primary">Criar empresa</button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => supabase.auth.signOut()}>Sair</button>
      </form>
    </div>
  )
}
