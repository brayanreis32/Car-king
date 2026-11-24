import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { date, label, money, options, pct, q, signedMoney, supabase, toNum, VEHICLE_STATUS_TONE, vehicleName } from '../lib.js'
import { Badge, ErrorBox, Field, Icon, Kpi, Modal, MoneyInput, Select, Spinner, Tabs, useAction, useLoad, useToast } from '../components/ui.jsx'
import { Documents, Expenses, Labor, Parts, Sale, Transport } from './VehicleTabs.jsx'
import { AuctionPhotos, VehiclePhotos } from '../components/photos.jsx'
import { InstagramCard } from '../components/instagramPost.jsx'
import { useApp } from '../App.jsx'
import { DeleteRecordButton } from '../components/deleteRecord.jsx'

const MANUAL_STATUS = ['purchased', 'awaiting_pickup', 'in_transit', 'received', 'in_inspection', 'in_preparation',
  'awaiting_parts', 'in_repair', 'in_detailing', 'ready_for_sale', 'listed', 'reserved']

export default function VehicleDetail() {
  const { id } = useParams()
  const [params] = useSearchParams()
  const [tab, setTab] = useState(params.get('tab') || 'summary')
  useEffect(() => { if (params.get('tab')) setTab(params.get('tab')) }, [params])
  const [editingPrices, setEditingPrices] = useState(false)
  const [run, busy] = useAction()
  const { company } = useApp()
  const toast = useToast()

  const { data, error, loading, reload } = useLoad(async () => {
    const [v, pa, budget, purchase, ledger, pendParts, pendTow, services] = await Promise.all([
      q(supabase.from('vehicles').select('*').eq('id', id).single()),
      q(supabase.from('vehicle_profit_analysis').select('*').eq('vehicle_id', id).maybeSingle()),
      q(supabase.from('vehicle_budget_vs_actual').select('*').eq('vehicle_id', id).order('sort_order')),
      q(supabase.from('vehicle_purchases').select('*, auction_sources(name)').eq('vehicle_id', id).maybeSingle()),
      q(supabase.from('vehicle_cost_ledger').select('cost_group, amount').eq('vehicle_id', id)).catch(() => []),
      q(supabase.from('parts').select('estimated_total').eq('vehicle_id', id).in('status', ['identified', 'awaiting_quote', 'to_buy'])).catch(() => []),
      q(supabase.from('transport_orders').select('estimated_cost').eq('vehicle_id', id).is('actual_cost', null).neq('status', 'cancelled')).catch(() => []),
      q(supabase.from('repair_items_overview').select('status, estimated_cost, actual_cost').eq('vehicle_id', id)).catch(() => []),
    ])
    const sum = (rows, k) => rows.reduce((t, r) => t + Number(r[k] || 0), 0)
    const groups = {}
    for (const l of ledger) groups[l.cost_group] = (groups[l.cost_group] || 0) + Number(l.amount || 0)
    const costs = { groups, pendingParts: { n: pendParts.length, total: sum(pendParts, 'estimated_total') }, pendingTow: { n: pendTow.length, total: sum(pendTow, 'estimated_cost') } }
    const unpaidLabor = services.filter((i) => i.status !== 'cancelled' && Number(i.estimated_cost) > Number(i.actual_cost || 0))
    costs.pendingLabor = { n: unpaidLabor.length, total: unpaidLabor.reduce((t, i) => t + Number(i.estimated_cost) - Number(i.actual_cost || 0), 0) }
    return { v, pa, budget, purchase, costs }
  }, [id])

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { v, pa, budget, purchase, costs } = data
  const sold = v.status === 'sold'

  const setStatus = async (status) => {
    await run(() => q(supabase.from('vehicles').update({ status }).eq('id', id)), 'Status atualizado')
    reload()
  }

  const overruns = (budget || []).filter((b) => b.alert_level !== 'ok')

  return (
    <div className="stack">
      <div>
        <Link to="/veiculos" className="back"><Icon name="back" size={16} /> Veículos</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>{vehicleName(v)}</h1>
            <div className="muted small">
              {v.stock_number && `${v.stock_number} · `}VIN {v.vin} · {label('title_status', v.title_status)}
              {purchase && ` · ${purchase.auction_sources?.name || purchase.auction_name || 'compra direta'}${purchase.lot_number ? ` lote ${purchase.lot_number}` : ''} em ${date(purchase.purchase_date)}`}
            </div>
          </div>
          <div className="row">
            {sold ? <Badge tone="success">Vendido</Badge> : (
              <Select value={v.status} onChange={setStatus} disabled={busy} style={{ width: 'auto', minWidth: 190 }}
                options={MANUAL_STATUS.map((s) => [s, label('vehicle_status', s)])} />
            )}
            <DeleteRecordButton kind="vehicle" id={v.id} name={vehicleName(v)} sold={sold} redirectTo="/veiculos" />
          </div>
        </div>
      </div>

      {overruns.length > 0 && !sold && (
        <div className="alert-box warning">
          Acima do orçamento: {overruns.map((o) => `${label('budget_line', o.line)} (${signedMoney(o.difference)})`).join(' · ')}
        </div>
      )}

      <Tabs active={tab} onChange={setTab} tabs={[
        ['summary', 'Resumo'], ['photos', 'Fotos'], ['budget', 'Orçamento'], ['transport', 'Reboque'], ['parts', 'Peças'],
        ['labor', 'Mão de obra'], ['expenses', 'Despesas'], ['documents', 'Documentos'], ['sale', sold ? 'Venda' : 'Vender'],
      ]} />

      {tab === 'summary' && <Summary v={v} pa={pa} costs={costs} onEditPrices={() => setEditingPrices(true)} />}
      {tab === 'photos' && <div className="stack">
        <VehiclePhotos vehicle={v} />
        <InstagramCard vehicle={v} />
        {v.opportunity_id && <AuctionPhotos opportunityId={v.opportunity_id} vehicle={v} title="Fotos do leilão (como foi comprado)" canPull={false} />}
      </div>}
      {tab === 'budget' && <Budget budget={budget} />}
      {tab === 'transport' && <Transport vehicle={v} onChange={reload} />}
      {tab === 'parts' && <Parts vehicle={v} onChange={reload} />}
      {tab === 'labor' && <Labor vehicle={v} onChange={reload} />}
      {tab === 'expenses' && <Expenses vehicle={v} onChange={reload} />}
      {tab === 'documents' && <Documents vehicle={v} />}
      {tab === 'sale' && <Sale vehicle={v} pa={pa} onChange={reload} />}

      {editingPrices && <PricesModal v={v} onClose={() => setEditingPrices(false)} onDone={() => { setEditingPrices(false); reload() }} />}
    </div>
  )
}

function Summary({ v, pa, costs, onEditPrices }) {
  if (!pa) return <div className="card muted">Você não tem acesso à análise financeira deste veículo.</div>
  const sold = v.status === 'sold'
  const profit = sold ? pa.real_profit : pa.projected_profit
  const margin = sold ? pa.real_margin_pct : pa.projected_margin_pct
  const roi = sold ? pa.real_roi_pct : pa.projected_roi_pct
  return (
    <div className="stack">
      <div className="grid grid-4">
        <Kpi label={sold ? 'Lucro real' : 'Lucro projetado'} value={money(profit)} tone={Number(profit) < 0 ? 'neg' : 'gold'} highlight
          hint={pa.planned_profit !== null ? `Previsto na compra: ${money(pa.planned_profit)}` : undefined} />
        <Kpi label="Margem" value={pct(margin)} hint={`ROI ${pct(roi)}`} />
        <Kpi label="Investido até agora" value={money(pa.actual_cost)} hint={!sold ? `Projetado: ${money(pa.projected_cost)}` : undefined} />
        <Kpi label={sold ? 'Vendido por' : 'Venda esperada'} value={money(sold ? pa.sale_price : pa.expected_sale_price)}
          hint={sold ? date(pa.sale_date) : pa.listed_price ? `Anunciado: ${money(pa.listed_price)}` : undefined} />
      </div>

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-title"><h2>Preços</h2>{!sold && <button className="btn-sm" onClick={onEditPrices}><Icon name="edit" /> Editar</button>}</div>
          <div className="lines num">
            <div><span>Preço mínimo sem prejuízo</span><b>{money(pa.break_even_price)}</b></div>
            <div><span>Mínimo para atingir suas metas</span><b>{money(pa.min_target_price)}</b></div>
            <div><span>Preço recomendado</span><b className="gold">{money(pa.recommended_price)}</b></div>
            {pa.planned_sale_price && <div><span className="muted">Venda planejada na compra</span><span>{money(pa.planned_sale_price)}</span></div>}
          </div>
          {!sold && (pa.conservative_sale_price || pa.optimistic_sale_price) && (
            <>
              <div className="divider" />
              <h3 style={{ marginBottom: 6 }}>Cenários</h3>
              <div className="lines num small">
                {pa.conservative_sale_price && <div><span>Conservador · {money(pa.conservative_sale_price)}</span><span className={Number(pa.conservative_profit) < 0 ? 'neg' : ''}>{money(pa.conservative_profit)}</span></div>}
                <div><span>Esperado · {money(pa.expected_sale_price)}</span><span>{money(pa.projected_profit)}</span></div>
                {pa.optimistic_sale_price && <div><span>Otimista · {money(pa.optimistic_sale_price)}</span><span>{money(pa.optimistic_profit)}</span></div>}
              </div>
            </>
          )}
        </div>
        <CostBreakdown costs={costs} total={pa.actual_cost} projected={pa.projected_cost} budget={budget} sold={sold} />
        <div className="card">
          <h2 style={{ marginBottom: 10 }}>Tempo</h2>
          <div className="lines num">
            <div><span>Dias desde a compra</span><b>{pa.days_since_purchase ?? '—'}</b></div>
            <div><span>Dias em preparação</span><b>{pa.days_in_preparation ?? '—'}</b></div>
            <div><span>Dias anunciado</span><b>{pa.days_listed ?? '—'}</b></div>
            {pa.holding_cost_per_day && <div><span>Custo de estadia por dia</span><b>{money(pa.holding_cost_per_day, true)}</b></div>}
          </div>
        </div>
      </div>
    </div>
  )
}

// Todos os gastos do carro somados, por tipo — é isso que sai do lucro
// Gasto real (já lançado) + o que ainda está só previsto no orçamento da compra
const WHERE = { parts: 'Peças', labor: 'Mão de obra', transport: 'Reboque', documentation: 'Despesas', inspection: 'Despesas', other: 'Despesas' }
function CostBreakdown({ costs, total, projected, budget, sold }) {
  if (!costs) return null
  const order = ['purchase', 'auction_fees', 'transport', 'parts', 'labor', 'documentation', 'inspection', 'storage', 'detailing', 'marketing', 'other']
  const rows = order.filter((g) => costs.groups[g])
  const pending = sold ? [] : (budget || [])
    .filter((b) => !['contingency', 'selling'].includes(b.line) && Number(b.projected) - Number(b.actual) > 0.5)
    .map((b) => ({ line: b.line, amount: Number(b.projected) - Number(b.actual) }))
  const pendingTotal = pending.reduce((t, p) => t + p.amount, 0)
  return (
    <div className="card">
      <h2 style={{ marginBottom: 10 }}>Gastos com este carro</h2>
      <div className="lines num">
        {rows.length === 0 && <div className="muted">Nenhum gasto lançado ainda.</div>}
        {rows.map((g) => <div key={g}><span>{label('budget_line', g)}</span><span>{money(costs.groups[g])}</span></div>)}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}><b>Total gasto (já pago)</b><b>{money(total)}</b></div>
        {costs.groups.selling > 0 && <div><span className="muted">Despesas da venda (saem do lucro na venda)</span><span>{money(costs.groups.selling)}</span></div>}
      </div>
      {pending.length > 0 && (
        <>
          <h3 style={{ margin: '16px 0 6px' }}>Ainda previsto (falta lançar)</h3>
          <div className="lines num">
            {pending.map((p) => (
              <div key={p.line}>
                <span>{label('budget_line', p.line)}{WHERE[p.line] && <span className="muted small"> · lançar na aba {WHERE[p.line]}</span>}</span>
                <span className="muted">{money(p.amount)}</span>
              </div>
            ))}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6 }}><b>Custo total previsto</b><b>{money(projected ?? Number(total) + pendingTotal)}</b></div>
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>
            Valores do orçamento feito na compra. Quando pagar, lance na aba indicada: aí sai de “previsto” e entra no “Total gasto”.
            O lucro projetado já desconta o custo total previsto.
          </p>
        </>
      )}
    </div>
  )
}

function Budget({ budget }) {
  if (!budget?.length) return <div className="card muted">Sem orçamento para este veículo.</div>
  const totals = budget.filter((b) => b.line !== 'selling').reduce((t, b) => ({
    budget: t.budget + Number(b.budget), actual: t.actual + Number(b.actual), projected: t.projected + Number(b.projected),
  }), { budget: 0, actual: 0, projected: 0 })
  const tone = { critical: 'error', warning: 'warning' }
  return (
    <div className="stack">
      <div className="grid grid-3">
        <Kpi label="Orçamento inicial" value={money(totals.budget)} />
        <Kpi label="Gasto real" value={money(totals.actual)} />
        <Kpi label="Custo projetado final" value={money(totals.projected)}
          tone={totals.projected > totals.budget ? 'neg' : 'pos'} hint={`${signedMoney(totals.projected - totals.budget)} vs orçamento`} />
      </div>
      <div className="card pad-0">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Previsto</th><th className="num hide-mobile">Real</th><th className="num">Projetado</th><th className="num">Diferença</th></tr></thead>
            <tbody>
              {budget.map((b) => (
                <tr key={b.line}>
                  <td>
                    {label('budget_line', b.line)} {b.alert_level !== 'ok' && <Badge tone={tone[b.alert_level]}>{b.difference_pct ? `+${b.difference_pct}%` : 'fora do orçamento'}</Badge>}
                    {b.line !== 'contingency' && Number(b.budget) > 0 && (
                      <div className={`bar ${Number(b.actual) > Number(b.budget) ? 'over' : ''}`} style={{ marginTop: 6, maxWidth: 220 }}>
                        <i style={{ width: `${Math.min(100, (Number(b.actual) / Number(b.budget)) * 100)}%` }} />
                      </div>
                    )}
                    {b.line === 'contingency' && <div className="muted small">restante após estouros: {money(b.projected)}</div>}
                  </td>
                  <td className="num">{money(b.budget)}</td>
                  <td className="num hide-mobile">{b.line === 'contingency' ? '—' : money(b.actual)}</td>
                  <td className="num">{money(b.projected)}</td>
                  <td className={`num ${Number(b.projected_difference) > 0 && b.line !== 'contingency' ? 'neg' : Number(b.projected_difference) < 0 ? 'pos' : 'muted'}`}>{b.line === 'contingency' ? '—' : signedMoney(b.projected_difference)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        <b>Projetado</b> = gasto real + o que ainda falta (peças a comprar, serviços em aberto, reboque não pago). <b>Diferença</b> = projetado − previsto.
        Estouros consomem a reserva de imprevistos.
      </p>
    </div>
  )
}

function PricesModal({ v, onClose, onDone }) {
  const [f, setF] = useState({
    expected_sale_price: v.expected_sale_price ?? '', conservative_sale_price: v.conservative_sale_price ?? '',
    optimistic_sale_price: v.optimistic_sale_price ?? '', listed_price: v.listed_price ?? '', market_value_clean: v.market_value_clean ?? '',
  })
  const [body, setBody] = useState(v.body_style || '')
  const set = (k) => (val) => setF((s) => ({ ...s, [k]: val }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = { ...Object.fromEntries(Object.entries(f).map(([k, val]) => [k, toNum(val)])), body_style: body || null }
    await run(() => q(supabase.from('vehicles').update(row).eq('id', v.id)), 'Preços atualizados')
    onDone()
  }
  return (
    <Modal title="Preços e anúncio no site" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Venda esperada"><MoneyInput value={f.expected_sale_price} onChange={set('expected_sale_price')} /></Field>
        <Field label="Preço anunciado"><MoneyInput value={f.listed_price} onChange={set('listed_price')} /></Field>
        <Field label="Cenário conservador"><MoneyInput value={f.conservative_sale_price} onChange={set('conservative_sale_price')} /></Field>
        <Field label="Cenário otimista"><MoneyInput value={f.optimistic_sale_price} onChange={set('optimistic_sale_price')} /></Field>
        <Field label="Valor de mercado (clean)"><MoneyInput value={f.market_value_clean} onChange={set('market_value_clean')} /></Field>
        <Field label="Tipo de carroceria (site)"><Select value={body} onChange={setBody} placeholder="—" options={options('body_style')} /></Field>
      </div>
      <p className="small muted">O <b>preço anunciado</b> e o <b>tipo</b> aparecem no site quando o carro está "Pronto para venda" ou "Anunciado".</p>
    </Modal>
  )
}
