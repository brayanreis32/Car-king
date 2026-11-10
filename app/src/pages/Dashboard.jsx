import { Link, useNavigate } from 'react-router-dom'
import { label, money, pct, q, supabase } from '../lib.js'
import { Badge, ErrorBox, Icon, Kpi, Spinner, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'

const SEVERITY_TONE = { critical: 'error', warning: 'warning' }

export default function Dashboard() {
  const { profile } = useApp()
  const nav = useNavigate()
  const { data, error, loading } = useLoad(async () => {
    const [kpis, alerts] = await Promise.all([
      q(supabase.from('dashboard_kpis').select('*').maybeSingle()),
      q(supabase.from('alerts').select('*').order('severity').limit(30)),
    ])
    return { kpis: kpis || {}, alerts }
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
        <Kpi label="Em análise" value={k.opportunities_in_analysis ?? 0} hint="carros de leilão" />
        <Kpi label="Em preparação" value={(k.vehicles_purchased_pending ?? 0) + (k.vehicles_in_preparation ?? 0)} hint="comprados até o reparo" />
        <Kpi label="Prontos p/ venda" value={k.vehicles_ready_for_sale ?? 0} hint="prontos e anunciados" />
        <Kpi label="Vendidos" value={k.vehicles_sold ?? 0} />
      </div>

      <div className="grid grid-4">
        <Kpi label="Estoque (investido)" value={money(k.inventory_value)} hint="custo real dos carros não vendidos" />
        <Kpi label="Lucro projetado do estoque" value={money(k.projected_profit_inventory)} tone={Number(k.projected_profit_inventory) < 0 ? 'neg' : 'pos'} />
        <Kpi label="Lucro realizado" value={money(k.realized_profit)} tone="gold" highlight hint={`Receita ${money(k.revenue)}`} />
        <Kpi label="Margem média" value={pct(k.avg_margin_pct)} hint={k.avg_days_to_sell ? `${k.avg_days_to_sell} dias em média para vender` : 'carros vendidos'} />
      </div>

      <div className="grid grid-2">
        <Kpi label="Contas a pagar" value={money(k.accounts_payable_open)} tone={Number(k.accounts_payable_open) > 0 ? 'warn' : ''} />
        <Kpi label="Contas a receber" value={money(k.accounts_receivable_open)} />
      </div>

      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>Alertas</h2>
          <Badge tone={data.alerts.length ? 'warning' : 'success'}>{data.alerts.length || 'Tudo em dia'}</Badge>
        </div>
        {data.alerts.length === 0 ? (
          <div className="empty">✅ Nenhum alerta no momento.</div>
        ) : (
          <div className="list">
            {data.alerts.map((a, i) => (
              <div key={i} className="list-item" onClick={() => a.vehicle_id && nav(`/veiculos/${a.vehicle_id}`)}>
                <Badge tone={SEVERITY_TONE[a.severity]}>{label('alert_type', a.alert_type)}</Badge>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{a.alert_type === 'budget_overrun' ? label('budget_line', a.title) : label('document_type', a.title)}</div>
                  <div className="muted small">{a.message}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
