// Histórico de pagamentos e recebimentos, com filtro de período, total e exportação para Excel (CSV)
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { date, money, q, supabase, today, vehicleName } from '../lib.js'
import { Empty, ErrorBox, Field, Kpi, Select, Spinner, useLoad } from '../components/ui.jsx'
import { AttachmentsButton } from '../components/attachments.jsx'

const pad = (n) => String(n).padStart(2, '0')
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
function range(kind) {
  const t = new Date(`${today()}T12:00:00`)
  const y = t.getFullYear(), m = t.getMonth()
  switch (kind) {
    case 'this_month': return [iso(new Date(y, m, 1)), iso(new Date(y, m + 1, 0))]
    case 'last_month': return [iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))]
    case 'last_30': return [iso(new Date(y, m, t.getDate() - 29)), today()]
    case 'this_year': return [`${y}-01-01`, `${y}-12-31`]
    default: return null
  }
}

function toCsv(rows) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n')
}
function download(name, text) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  a.download = name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}

export default function FinanceHistory({ direction }) {
  const [period, setPeriod] = useState('this_month')
  const [custom, setCustom] = useState({ from: range('this_month')[0], to: today() })
  const [accountId, setAccountId] = useState('')
  const [from, to] = period === 'custom' ? [custom.from, custom.to] : range(period)

  const accounts = useLoad(() => q(supabase.from('financial_accounts').select('id, name').order('name')))
  const { data, error, loading } = useLoad(async () => {
    let query = supabase.from('financial_transactions')
      .select('id, transaction_date, description, amount, status, vehicle_id, transfer_id, reversal_reason, account_id, financial_accounts(name), suppliers(name), customers(full_name), vehicles(year, make, model, stock_number)')
      .eq('direction', direction).in('status', ['confirmed', 'reversed'])
      .gte('transaction_date', from).lte('transaction_date', to)
      .order('transaction_date', { ascending: false }).order('created_at', { ascending: false })
    if (accountId) query = query.eq('account_id', accountId)
    return q(query)
  }, [direction, from, to, accountId])

  const rows = data || []
  const valid = rows.filter((r) => r.status === 'confirmed' && !r.transfer_id)
  const total = valid.reduce((s, r) => s + Number(r.amount), 0)
  const byVehicle = useMemo(() => valid.filter((r) => r.vehicle_id).reduce((s, r) => s + Number(r.amount), 0), [valid])

  const exportCsv = () => {
    const head = ['Data', 'Descrição', direction === 'out' ? 'Pago a' : 'Recebido de', 'Veículo', 'Conta', 'Valor', 'Situação']
    const body = rows.map((r) => [
      date(r.transaction_date), r.description, r.suppliers?.name || r.customers?.full_name || '',
      r.vehicles ? `${vehicleName(r.vehicles)}${r.vehicles.stock_number ? ` (${r.vehicles.stock_number})` : ''}` : '',
      r.financial_accounts?.name || '', Number(r.amount).toFixed(2),
      r.status === 'reversed' ? `Estornado: ${r.reversal_reason || ''}` : r.transfer_id ? 'Transferência' : 'Confirmado',
    ])
    download(`car-king-${direction === 'out' ? 'pagamentos' : 'recebimentos'}-${from}-a-${to}.csv`, toCsv([head, ...body]))
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="form-grid">
          <Field label="Período">
            <Select value={period} onChange={setPeriod} options={[
              ['this_month', 'Este mês'], ['last_month', 'Mês passado'], ['last_30', 'Últimos 30 dias'], ['this_year', 'Este ano'], ['custom', 'Escolher datas'],
            ]} />
          </Field>
          {period === 'custom' && <>
            <Field label="De"><input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} /></Field>
            <Field label="Até"><input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} /></Field>
          </>}
          <Field label="Conta">
            <Select value={accountId} onChange={setAccountId} placeholder="Todas" options={(accounts.data || []).map((a) => [a.id, a.name])} />
          </Field>
        </div>
      </div>

      <div className="grid grid-3">
        <Kpi label={direction === 'out' ? 'Total pago' : 'Total recebido'} value={money(total, true)} highlight hint={`${valid.length} lançamento(s) · ${date(from)} a ${date(to)}`} />
        <Kpi label={direction === 'out' ? 'Ligado a carros' : 'De vendas de carros'} value={money(byVehicle, true)} />
        <Kpi label={direction === 'out' ? 'Despesas gerais' : 'Outras entradas'} value={money(total - byVehicle, true)} />
      </div>

      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>{direction === 'out' ? 'Pagamentos feitos' : 'Recebimentos'}</h2>
          <button className="btn-sm" onClick={exportCsv} disabled={!rows.length}>Exportar para Excel</button>
        </div>
        {loading && !data ? <Spinner /> : error ? <div style={{ padding: 16 }}><ErrorBox error={error} /></div> : rows.length === 0 ? (
          <Empty title="Nada neste período" />
        ) : (
          <div className="list">
            {rows.map((r) => (
              <div key={r.id} className="list-item" style={{ cursor: 'default', opacity: r.status === 'reversed' ? 0.55 : 1 }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b>{r.description}</b>
                  <div className="muted small">
                    {date(r.transaction_date)} · {r.financial_accounts?.name}
                    {(r.suppliers?.name || r.customers?.full_name) && ` · ${r.suppliers?.name || r.customers?.full_name}`}
                    {r.vehicles && <> · <Link to={`/veiculos/${r.vehicle_id}`}>{vehicleName(r.vehicles)}</Link></>}
                    {r.transfer_id && ' · transferência'}
                    {r.status === 'reversed' && ` · estornado${r.reversal_reason ? `: ${r.reversal_reason}` : ''}`}
                  </div>
                </div>
                <div className={`num ${direction === 'out' ? 'neg' : 'pos'}`} style={{ fontWeight: 600 }}>{direction === 'out' ? '−' : '+'}{money(r.amount, true)}</div>
                <AttachmentsButton entityType="financial_transaction" entityId={r.id} vehicleId={r.vehicle_id} title="Comprovante" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
