// Contatos que chegam pelo site (mensagens, disponibilidade, pré-aprovação)
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { date, q, supabase, whatsappNumber } from '../lib.js'
import { Badge, Empty, ErrorBox, Spinner, useAction, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'
import { fmtPhone } from './Customers.jsx'

const KIND = { contact: 'Mensagem', availability: 'Disponibilidade', financing: 'Pré-aprovação', trade_in: 'Troca / venda do carro', test_drive: 'Test drive' }
const STATUS = { new: ['Novo', 'error'], contacted: ['Em atendimento', 'warning'], closed: ['Encerrado', ''] }
const DETAIL = {
  vehicle: 'Carro escolhido', down_payment: 'Entrada disponível', monthly_income: 'Renda mensal', job_time: 'Tempo no emprego',
  address_time: 'Tempo no endereço', credit: 'Crédito', frequency: 'Pagamento preferido', consent_contact: 'Autorizou contato por SMS/WhatsApp',
}

export function useNewLeadsCount(key = 0) {
  const { data } = useLoad(() => q(supabase.from('website_leads').select('id').eq('status', 'new')).catch(() => []), [key])
  return data?.length || 0
}

export default function SiteLeads({ onChange }) {
  const { can } = useApp()
  const nav = useNavigate()
  const [filter, setFilter] = useState('open')
  const [run, busy] = useAction()
  const { data, error, loading, reload } = useLoad(() =>
    q(supabase.from('website_leads').select('*').order('created_at', { ascending: false }).limit(300)))

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const rows = data.filter((l) => (filter === 'open' ? l.status !== 'closed' : filter === 'closed' ? l.status === 'closed' : true))

  const setStatus = async (l, status) => {
    await run(() => q(supabase.from('website_leads').update({ status }).eq('id', l.id)), 'Contato atualizado')
    reload(); onChange?.()
  }
  const toCustomer = async (l) => {
    const c = await run(async () => {
      const existing = l.phone
        ? await q(supabase.from('customers').select('id').eq('phone', l.phone).maybeSingle())
        : l.email ? await q(supabase.from('customers').select('id').eq('email', l.email).maybeSingle()) : null
      const cust = existing || await q(supabase.from('customers').insert({ full_name: l.name, phone: l.phone, email: l.email, notes: `Veio pelo site (${KIND[l.kind]}) em ${date(l.created_at)}` }).select('id').single())
      await q(supabase.from('website_leads').update({ customer_id: cust.id, status: l.status === 'new' ? 'contacted' : l.status }).eq('id', l.id))
      return cust
    }, 'Cliente vinculado')
    onChange?.()
    nav(`/clientes/${c.id}`)
  }

  return (
    <div className="stack">
      <div className="row between">
        <p className="muted small" style={{ margin: 0 }}>Mensagens enviadas pelo site: perguntas, “confirmar disponibilidade” e pedidos de pré-aprovação.</p>
        <div className="seg">
          <button className={filter === 'open' ? 'active' : ''} onClick={() => setFilter('open')}>Em aberto</button>
          <button className={filter === 'closed' ? 'active' : ''} onClick={() => setFilter('closed')}>Encerrados</button>
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todos</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="card"><Empty title="Nenhum contato aqui">Quando alguém enviar uma mensagem pelo site, ela aparece nesta lista.</Empty></div>
      ) : rows.map((l) => {
        const wa = whatsappNumber(l.phone)
        const details = Object.entries(l.details || {}).filter(([k, v]) => v && DETAIL[k])
        return (
          <div key={l.id} className="card stack" style={{ gap: 10 }}>
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="row" style={{ gap: 8 }}>
                  <b>{l.name}</b>
                  <Badge tone={STATUS[l.status][1]}>{STATUS[l.status][0]}</Badge>
                  <Badge tone={l.kind === 'financing' ? 'gold' : 'info'}>{KIND[l.kind]}</Badge>
                </div>
                <div className="muted small">{new Date(l.created_at).toLocaleString('pt-BR', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' })}
                  {l.phone && ` · ${fmtPhone(l.phone)}`}{l.email && ` · ${l.email}`}</div>
              </div>
              {can('customers', 'edit') && (
                <select value={l.status} onChange={(e) => setStatus(l, e.target.value)} disabled={busy} style={{ width: 'auto' }}>
                  <option value="new">Novo</option><option value="contacted">Em atendimento</option><option value="closed">Encerrado</option>
                </select>
              )}
            </div>
            {l.vehicle_label && <div className="small">Carro: {l.vehicle_id ? <Link to={`/veiculos/${l.vehicle_id}`}>{l.vehicle_label}</Link> : l.vehicle_label}</div>}
            {l.message && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>“{l.message}”</div>}
            {details.length > 0 && (
              <div className="lines small">
                {details.map(([k, v]) => <div key={k}><span className="muted">{DETAIL[k]}</span><span>{v === true ? 'Sim' : String(v)}</span></div>)}
              </div>
            )}
            <div className="contact-actions">
              {l.phone && <a className="btn btn-sm" href={`tel:${l.phone}`}>Ligar</a>}
              {wa && <a className="btn btn-sm" href={`https://wa.me/${wa}?text=${encodeURIComponent(`Hi ${l.name.split(' ')[0]}, this is Car King Auto Sales. Thanks for contacting us${l.vehicle_label ? ` about the ${l.vehicle_label.split(' · ')[0]}` : ''}!`)}`} target="_blank" rel="noreferrer">WhatsApp</a>}
              {l.email && <a className="btn btn-sm" href={`mailto:${l.email}`}>E-mail</a>}
              {l.customer_id
                ? <Link className="btn btn-sm" to={`/clientes/${l.customer_id}`}>Abrir cliente</Link>
                : can('customers', 'create') && <button className="btn-sm" onClick={() => toCustomer(l)} disabled={busy}>Cadastrar como cliente</button>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
