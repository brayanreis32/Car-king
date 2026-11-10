import { useState } from 'react'
import { q, supabase } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Icon, Modal, Select, Spinner, useAction, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'

// Chama a Edge Function que cria/altera logins com segurança no servidor
async function manage(body) {
  const { data, error } = await supabase.functions.invoke('manage-employees', { body })
  if (error) {
    let msg = error.message
    try { const j = await error.context.json(); msg = j.error || msg } catch { /* sem corpo */ }
    if (/Failed to send|not found|404/i.test(msg)) msg = 'O serviço de logins ainda não foi instalado no Supabase (Edge Function "manage-employees").'
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

const ROLE_TONE = { super_admin: 'gold', admin: 'info', seller: 'success' }

function randomPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const arr = new Uint32Array(10); crypto.getRandomValues(arr)
  return Array.from(arr, (n) => chars[n % chars.length]).join('')
}

export default function Employees() {
  const { profile, can } = useApp()
  const myRole = profile.roles?.code
  const { data, error, loading, reload } = useLoad(async () => {
    const [people, roles] = await Promise.all([
      q(supabase.from('profiles').select('id, full_name, email, phone, is_active, created_at, roles(code, name)').order('full_name')),
      q(supabase.from('roles').select('code, name, description').order('name')),
    ])
    return { people, roles }
  })
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(null)
  const [created, setCreated] = useState(null)

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const assignable = data.roles.filter((r) => r.code !== 'super_admin' || myRole === 'super_admin')
  const canManage = (p) => p.roles?.code !== 'super_admin' || myRole === 'super_admin'

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Funcionários e logins</h1><div className="muted small">Quem acessa o sistema e o que cada um pode fazer</div></div>
        {can('employees', 'create') && <button className="btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> Novo login</button>}
      </div>

      <div className="card pad-0">
        {data.people.length === 0 ? <Empty title="Nenhum funcionário" /> : (
          <div className="list">
            {data.people.map((p) => (
              <div key={p.id} className="list-item" style={{ cursor: 'default', opacity: p.is_active ? 1 : 0.55 }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div><b>{p.full_name}</b>{p.id === profile.id && <span className="muted small"> (você)</span>}</div>
                  <div className="muted small">{p.email || 'sem e-mail'}{p.phone && ` · ${p.phone}`}</div>
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <Badge tone={ROLE_TONE[p.roles?.code]}>{p.roles?.name}</Badge>
                  {!p.is_active && <Badge tone="error">inativo</Badge>}
                  {can('employees', 'edit') && canManage(p) && (
                    <button className="btn-sm" onClick={() => setEditing(p)}><Icon name="edit" /> Gerenciar</button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <h2 style={{ marginBottom: 10 }}>Perfis de acesso</h2>
        <div className="lines small">
          {data.roles.map((r) => <div key={r.code}><b style={{ minWidth: 170 }}>{r.name}</b><span className="muted" style={{ textAlign: 'right' }}>{r.description}</span></div>)}
        </div>
      </div>

      {creating && <CreateModal roles={assignable} onClose={() => setCreating(false)} onDone={(c) => { setCreating(false); setCreated(c); reload() }} />}
      {editing && <ManageModal person={editing} roles={assignable} isSelf={editing.id === profile.id} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload() }} />}
      {created && <CreatedModal info={created} onClose={() => setCreated(null)} />}
    </div>
  )
}

function CreateModal({ roles, onClose, onDone }) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '', password: randomPassword(), role_code: 'seller' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const role = roles.find((r) => r.code === f.role_code)
  const save = async () => {
    await run(() => manage({ action: 'create', ...f }), 'Login criado')
    onDone({ ...f, role_name: role?.name })
  }
  return (
    <Modal title="Novo login" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.full_name || !f.email || f.password.length < 8}>{busy ? 'Criando…' : 'Criar login'}</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Nome *"><input value={f.full_name} onChange={(e) => set('full_name')(e.target.value)} /></Field>
          <Field label="E-mail (login) *"><input type="email" value={f.email} onChange={(e) => set('email')(e.target.value)} autoComplete="off" /></Field>
          <Field label="Senha inicial *">
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <input value={f.password} onChange={(e) => set('password')(e.target.value)} autoComplete="new-password" style={{ fontFamily: 'monospace' }} />
              <button type="button" className="btn-sm" onClick={() => set('password')(randomPassword())}>Gerar</button>
            </div>
          </Field>
          <Field label="Telefone"><input type="tel" value={f.phone} onChange={(e) => set('phone')(e.target.value)} /></Field>
          <Field label="Perfil" span><Select value={f.role_code} onChange={set('role_code')} options={roles.map((r) => [r.code, r.name])} /></Field>
        </div>
        {role && <div className="alert-box info">{role.description}</div>}
        {f.password.length > 0 && f.password.length < 8 && <div className="alert-box warning">A senha precisa ter pelo menos 8 caracteres.</div>}
      </div>
    </Modal>
  )
}

function CreatedModal({ info, onClose }) {
  const text = `Acesso ao sistema Car King\nEndereço: ${window.location.origin}${window.location.pathname}\nE-mail: ${info.email}\nSenha: ${info.password}`
  const [copied, setCopied] = useState(false)
  return (
    <Modal title="Login criado" onClose={onClose}
      footer={<><button onClick={() => { navigator.clipboard?.writeText(text); setCopied(true) }}>{copied ? 'Copiado' : 'Copiar dados de acesso'}</button><button className="btn-primary" onClick={onClose}>Concluir</button></>}>
      <div className="stack">
        <p style={{ margin: 0 }}><b>{info.full_name}</b> já pode entrar como <b>{info.role_name}</b>.</p>
        <pre className="card" style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 14 }}>{text}</pre>
        <p className="small muted" style={{ margin: 0 }}>Envie esses dados para a pessoa por um canal seguro. Ela pode trocar a senha depois em “Esqueci minha senha”.</p>
      </div>
    </Modal>
  )
}

function ManageModal({ person, roles, isSelf, onClose, onDone }) {
  const [role, setRole] = useState(person.roles?.code)
  const [password, setPassword] = useState('')
  const [run, busy] = useAction()
  const changeRole = async () => { await run(() => manage({ action: 'update', user_id: person.id, role_code: role }), 'Perfil atualizado'); onDone() }
  const resetPassword = async () => { await run(() => manage({ action: 'reset_password', user_id: person.id, password }), 'Senha redefinida'); onDone() }
  const toggle = async () => {
    if (person.is_active && !window.confirm(`Desativar o acesso de ${person.full_name}? A pessoa não conseguirá mais entrar.`)) return
    await run(() => manage({ action: 'set_active', user_id: person.id, is_active: !person.is_active }), person.is_active ? 'Acesso desativado' : 'Acesso reativado')
    onDone()
  }
  return (
    <Modal title={person.full_name} onClose={onClose} footer={<button onClick={onClose}>Fechar</button>}>
      <div className="stack">
        {!isSelf && (
          <div className="stack" style={{ gap: 8 }}>
            <h3>Perfil de acesso</h3>
            <div className="row" style={{ flexWrap: 'nowrap' }}>
              <Select value={role} onChange={setRole} options={roles.map((r) => [r.code, r.name])} />
              <button onClick={changeRole} disabled={busy || role === person.roles?.code}>Salvar</button>
            </div>
          </div>
        )}
        <div className="stack" style={{ gap: 8 }}>
          <h3>Redefinir senha</h3>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Nova senha (mín. 8)" autoComplete="new-password" style={{ fontFamily: 'monospace' }} />
            <button className="btn-sm" type="button" onClick={() => setPassword(randomPassword())}>Gerar</button>
            <button onClick={resetPassword} disabled={busy || password.length < 8}>Salvar</button>
          </div>
        </div>
        {!isSelf && (
          <div className="stack" style={{ gap: 8 }}>
            <h3>Acesso</h3>
            <div><button className={person.is_active ? 'btn-danger' : ''} onClick={toggle} disabled={busy}>{person.is_active ? 'Desativar acesso' : 'Reativar acesso'}</button></div>
          </div>
        )}
      </div>
    </Modal>
  )
}
