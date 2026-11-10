import { Link, useNavigate } from 'react-router-dom'
import { label, money, pct, q, supabase, today, vehicleName } from '../lib.js'
import { Badge, ErrorBox, Icon, Kpi, Spinner, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'

const SEVERITY_TONE = { critical: 'error', warning: 'warning' }

// Para onde cada alerta leva ao clicar
function alertLink(a) {
  const tabs = { document_pending: 'documents', budget_overrun: 'budget', part_late: 'parts', repair_overdue: 'labor', stale_vehicle: 'summary', profit_below_target: 'summary' }
  if (a.alert_type === 'payable_due') return `/financeiro?tab=pay${a.severity === 'critical' ? '&vencidas=1' : ''}`
  if (a.alert_type === 'sold_with_balance') return '/financeiro?tab=receive'
  if (a.vehicle_id) return `/veiculos/${a.vehicle_id}?tab=${tabs[a.alert_type] || 'summary'}`
  return null
}

export default function Dashboard() {
  const { profile, can } = useApp()
  const nav = useNavigate()
  const fin = can('finance', 'view')
  const { data, error, loading } = useLoad(async () => {
    const monthStart = `${today().slice(0, 8)}01`
    const [kpis, alerts, vehicles, overdue, paid, lateRecv] = await Promise.all([
      q(supabase.from('dashboard_kpis').select('*').maybeSingle()),
      q(supabase.from('alerts').select('*').order('severity').limit(40)),
      q(supabase.from('vehicles').select('id, year, make, model, trim, stock_number')),
      fin ? q(supabase.from('accounts_payable').select('balance').in('status', ['open', 'partial']).lt('due_date', today())) : [],
      fin ? q(supabase.from('financial_transactions').select('amount').eq('direction', 'out').eq('status', 'confirmed').is('transfer_id', null).gte('transaction_date', monthStart)) : [],
      fin ? q(supabase.from('accounts_receivable').select('balance, customer_id').in('status', ['open', 'partial']).lt('due_date', today())) : [],
    ])
    const names = Object.fromEntries(vehicles.map((v) => [v.id, `${vehicleName(v)}${v.stock_number ? ` · ${v.stock_number}` : ''}`]))
    const sum = (rows, k) => rows.reduce((s, r) => s + Number(r[k]), 0)
    return { kpis: kpis || {}, alerts, names, overdue: { count: overdue.length, total: sum(overdue, 'balance') }, paidMonth: { count: paid.length, total: sum(paid, 'amount') },
      lateRecv: { count: lateRecv.length, total: sum(lateRecv, 'balance'), customers: new Set(lateRecv.map((r) => r.customer_id)).size } }
  })

  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const k = data.kpis

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Olá, {profile.full_name.split(' ')[0]}</h1>
          <div className="muted small">Visão geral da operação</div>
        </div>
        <Link to="/leiloes?novo=1" className="btn btn-primary"><Icon name="plus" /> Analisar carro do leilão</Link>
      </div>

      <div className="grid grid-4">
        <Kpi to="/leiloes" label="Em análise" value={k.opportunities_in_analysis ?? 0} hint="carros de leilão" />
        <Kpi to="/veiculos?tab=prep" label="Em preparação" value={(k.vehicles_purchased_pending ?? 0) + (k.vehicles_in_preparation ?? 0)} hint="comprados até o reparo" />
        <Kpi to="/veiculos?tab=sale" label="Prontos p/ venda" value={k.vehicles_ready_for_sale ?? 0} hint="prontos e anunciados" />
        <Kpi to="/veiculos?tab=sold" label="Vendidos" value={k.vehicles_sold ?? 0} />
      </div>

      <div className="grid grid-4">
        <Kpi to="/veiculos?tab=prep" label="Estoque (investido)" value={money(k.inventory_value)} hint="custo real dos carros não vendidos" />
        <Kpi to="/veiculos?tab=sale" label="Lucro projetado do estoque" value={money(k.projected_profit_inventory)} tone={Number(k.projected_profit_inventory) < 0 ? 'neg' : 'pos'} />
        <Kpi to="/veiculos?tab=sold" label="Lucro realizado" value={money(k.realized_profit)} tone="gold" highlight hint={`Receita ${money(k.revenue)}`} />
        <Kpi to="/veiculos?tab=sold" label="Margem média" value={pct(k.avg_margin_pct)} hint={k.avg_days_to_sell ? `${k.avg_days_to_sell} dias em média para vender` : 'carros vendidos'} />
      </div>

      {fin && (
        <div className="grid grid-4">
          <Kpi to="/financeiro?tab=pay" label="Contas a pagar" value={money(k.accounts_payable_open)} tone={Number(k.accounts_payable_open) > 0 ? 'warn' : ''} hint="em aberto" />
          <Kpi to="/financeiro?tab=pay&vencidas=1" label="Contas vencidas" value={money(data.overdue.total)} tone={data.overdue.count ? 'neg' : 'pos'} hint={data.overdue.count ? `${data.overdue.count} conta(s) vencida(s)` : 'nenhuma vencida'} />
          <Kpi to="/financeiro?tab=paid" label="Pagas este mês" value={money(data.paidMonth.total)} hint={`${data.paidMonth.count} pagamento(s)`} />
          <Kpi to="/financeiro?tab=receive" label="Contas a receber" value={money(k.accounts_receivable_open)} hint="clientes" />
        </div>
      )}
      {fin && data.lateRecv.count > 0 && (
        <Kpi to="/financeiro?tab=receive&vencidas=1" label="Parcelas de clientes em atraso" value={money(data.lateRecv.total)} tone="neg"
          hint={`${data.lateRecv.count} parcela(s) de ${data.lateRecv.customers} cliente(s) · clique para cobrar pelo WhatsApp`} />
      )}

      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>Alertas</h2>
          <Badge tone={data.alerts.length ? 'warning' : 'success'}>{data.alerts.length || 'Tudo em dia'}</Badge>
        </div>
        {data.alerts.length === 0 ? (
          <div className="empty">Nenhum alerta no momento.</div>
        ) : (
          <div className="list">
            {data.alerts.map((a, i) => {
              const to = alertLink(a)
              const car = a.vehicle_id && data.names[a.vehicle_id]
              const title = a.alert_type === 'budget_overrun' ? label('budget_line', a.title)
                : a.alert_type === 'document_pending' ? label('document_type', a.title) : a.title
              return (
                <div key={i} className="list-item" onClick={() => to && nav(to)}>
                  <Badge tone={SEVERITY_TONE[a.severity]}>{label('alert_type', a.alert_type)}</Badge>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{title}</div>
                    <div className="muted small">{[car && car !== title ? car : null, a.message].filter(Boolean).join(' · ')}</div>
                  </div>
                  {to && <span className="muted" aria-hidden="true">›</span>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
