import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { money, q, supabase, today, vehicleName } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Icon, Modal, Spinner, Tabs, useAction, useLoad } from '../components/ui.jsx'
import SiteLeads, { useNewLeadsCount } from './SiteLeads.jsx'
import { useApp } from '../App.jsx'

const onlyDigits = (v) => String(v || '').replace(/\D/g, '')
export const fmtPhone = (v) => {
  const d = onlyDigits(v)
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  if (d.length === 11 && d[0] === '1') return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`
  return v || ''
}

// Resumo financeiro de um cliente a partir das faturas (contas a receber)
export function receivableSummary(rows = []) {
  const open = rows.filter((r) => ['open', 'partial'].includes(r.status))
  const late = open.filter((r) => r.due_date && r.due_date < today())
  const sum = (list, k) => list.reduce((s, r) => s + Number(r[k] || 0), 0)
  return {
    total: sum(rows.filter((r) => r.status !== 'cancelled'), 'amount'),
    received: sum(rows, 'received_amount'),
    open: sum(open, 'balance'),
    late: sum(late, 'balance'),
    lateCount: late.length,
    next: open.filter((r) => r.due_date && r.due_date >= today()).sort((a, b) => a.due_date.localeCompare(b.due_date))[0],
  }
}

export default function Customers() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') === 'site' ? 'site' : 'list'
  const [leadsKey, setLeadsKey] = useState(0)
  const newLeads = useNewLeadsCount(leadsKey)
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Clientes</h1><div className="muted small">Cadastro, documentos, carros comprados, faturas e contatos do site</div></div>
      </div>
      <Tabs tabs={[['list', 'Clientes'], ['site', `Contatos do site${newLeads ? ` (${newLeads} novo${newLeads > 1 ? 's' : ''})` : ''}`]]}
        active={tab} onChange={(t) => setParams(t === 'site' ? { tab: 'site' } : {})} />
      {tab === 'site' ? <SiteLeads onChange={() => setLeadsKey((k) => k + 1)} /> : <CustomerList />}
    </div>
  )
}

function CustomerList() {
  const nav = useNavigate()
  const { can } = useApp()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const { data, error, loading, reload } = useLoad(async () => {
    const [customers, sales, recs] = await Promise.all([
      q(supabase.from('customers').select('*').order('full_name')),
      q(supabase.from('sales').select('customer_id, sale_date, vehicles(year, make, model, trim)').neq('status', 'cancelled').order('sale_date', { ascending: false })),
      q(supabase.from('accounts_receivable').select('customer_id, amount, received_amount, balance, due_date, status').neq('status', 'cancelled')),
    ])
    return customers.map((c) => ({
      ...c,
      cars: sales.filter((s) => s.customer_id === c.id).map((s) => vehicleName(s.vehicles)),
      fin: receivableSummary(recs.filter((r) => r.customer_id === c.id)),
    }))
  })

  const term = search.trim().toLowerCase()
  const digits = onlyDigits(search)
  const rows = (data || []).filter((c) => {
    if (filter === 'late' && !c.fin.lateCount) return false
    if (filter === 'open' && !(c.fin.open > 0)) return false
    if (!term) return true
    return [c.full_name, c.email, c.city, ...c.cars].some((v) => String(v || '').toLowerCase().includes(term))
      || (digits.length >= 3 && [c.phone, c.phone_alt].some((p) => onlyDigits(p).includes(digits)))
  })
  const lateTotal = (data || []).filter((c) => c.fin.lateCount).length
  const openTotal = (data || []).filter((c) => c.fin.open > 0).length

  return (
    <div className="stack">
      <div className="row" style={{ gap: 8 }}>
        {can('customers', 'create') && <button className="btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Novo cliente</button>}
        <input className="grow" style={{ minWidth: 200 }} placeholder="Buscar por nome, telefone, e-mail ou carro" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="seg">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todos</button>
          <button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>Pagando ({openTotal})</button>
          <button className={filter === 'late' ? 'active' : ''} onClick={() => setFilter('late')}>Em atraso ({lateTotal})</button>
        </div>
      </div>

      {loading ? <Spinner /> : error ? <ErrorBox error={error} /> : rows.length === 0 ? (
        <div className="card"><Empty title={data.length ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}>
          {data.length ? 'Tente outro nome ou filtro.' : 'Cadastre pelo botão “Novo cliente” ou ao registrar uma venda.'}
        </Empty></div>
      ) : (
        <div className="card pad-0">
          <div className="table-wrap hide-mobile">
            <table>
              <thead><tr><th>Cliente</th><th>Telefone</th><th>Carro</th><th className="num">Em aberto</th><th>Situação</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => nav(`/clientes/${c.id}`)}>
                    <td><b>{c.full_name}</b><div className="muted small">{[c.email, c.city && `${c.city}${c.state ? `, ${c.state}` : ''}`].filter(Boolean).join(' · ') || '—'}</div></td>
                    <td>{fmtPhone(c.phone) || '—'}</td>
                    <td>{c.cars.length ? c.cars.join(', ') : <span className="muted">—</span>}</td>
                    <td className="num">{c.fin.open > 0 ? money(c.fin.open) : '—'}</td>
                    <td><Status fin={c.fin} hasCar={c.cars.length > 0} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="list only-mobile">
            {rows.map((c) => (
              <div key={c.id} className="list-item" onClick={() => nav(`/clientes/${c.id}`)}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row between"><b>{c.full_name}</b><Status fin={c.fin} hasCar={c.cars.length > 0} /></div>
                  <div className="muted small">{fmtPhone(c.phone) || 'sem telefone'}{c.cars.length ? ` · ${c.cars.join(', ')}` : ''}</div>
                  {c.fin.open > 0 && <div className="small">Em aberto <b>{money(c.fin.open)}</b></div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {adding && <CustomerModal onClose={() => setAdding(false)} onDone={(id) => { setAdding(false); reload(); if (id) nav(`/clientes/${id}`) }} />}
    </div>
  )
}

export function Status({ fin, hasCar }) {
  if (fin.lateCount) return <Badge tone="error">{fin.lateCount} vencida(s)</Badge>
  if (fin.open > 0) return <Badge tone="warning">Pagando</Badge>
  if (hasCar) return <Badge tone="success">Quitado</Badge>
  return <Badge>Sem compra</Badge>
}

const EMPTY = {
  full_name: '', customer_type: 'individual', phone: '', phone_alt: '', email: '',
  address: '', address2: '', city: '', state: '', zip: '',
  document_id: '', license_state: '', license_expires: '', birth_date: '', notes: '',
}

export function CustomerModal({ customer, onClose, onDone }) {
  const [f, setF] = useState(() => ({ ...EMPTY, ...Object.fromEntries(Object.entries(customer || {}).filter(([k]) => k in EMPTY).map(([k, v]) => [k, v ?? ''])) }))
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? (v.trim() || null) : v]))
    row.full_name = f.full_name.trim()
    row.customer_type = f.customer_type
    if (row.state) row.state = row.state.toUpperCase()
    if (row.license_state) row.license_state = row.license_state.toUpperCase()
    const saved = await run(() => customer?.id
      ? q(supabase.from('customers').update(row).eq('id', customer.id).select('id').single())
      : q(supabase.from('customers').insert(row).select('id').single()), 'Cliente salvo')
    onDone(customer?.id ? null : saved.id)
  }
  return (
    <Modal title={customer?.id ? 'Editar cliente' : 'Novo cliente'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.full_name.trim()}>Salvar</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Nome completo *" span><input value={f.full_name} onChange={set('full_name')} autoComplete="off" /></Field>
          <Field label="Telefone (WhatsApp)"><input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} placeholder="(407) 555-0100" /></Field>
          <Field label="Outro telefone"><input type="tel" inputMode="tel" value={f.phone_alt} onChange={set('phone_alt')} /></Field>
          <Field label="E-mail" span><input type="email" value={f.email} onChange={set('email')} /></Field>
        </div>
        <h3 style={{ margin: '4px 0 0' }}>Endereço</h3>
        <div className="form-grid">
          <Field label="Rua e número" span><input value={f.address} onChange={set('address')} placeholder="123 Main St" autoComplete="off" /></Field>
          <Field label="Apto / unidade"><input value={f.address2} onChange={set('address2')} placeholder="Apt 4B" /></Field>
          <Field label="Cidade"><input value={f.city} onChange={set('city')} /></Field>
          <Field label="Estado"><input value={f.state} onChange={set('state')} maxLength={2} placeholder="FL" style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="ZIP"><input value={f.zip} onChange={set('zip')} inputMode="numeric" maxLength={10} /></Field>
        </div>
        <h3 style={{ margin: '4px 0 0' }}>Documento</h3>
        <div className="form-grid">
          <Field label="Driver license nº"><input value={f.document_id} onChange={set('document_id')} /></Field>
          <Field label="Estado da license"><input value={f.license_state} onChange={set('license_state')} maxLength={2} style={{ textTransform: 'uppercase' }} /></Field>
          <Field label="Validade"><input type="date" value={f.license_expires} onChange={set('license_expires')} /></Field>
          <Field label="Data de nascimento"><input type="date" value={f.birth_date} onChange={set('birth_date')} /></Field>
        </div>
        <Field label="Observações"><textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>
        {!customer?.id && <p className="small muted" style={{ margin: 0 }}>As fotos dos documentos você anexa na ficha do cliente, depois de salvar.</p>}
      </div>
    </Modal>
  )
}
