import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { date, label, money, options, pct, q, signedMoney, supabase, toNum, VEHICLE_STATUS_TONE, vehicleName } from '../lib.js'
import { Badge, ErrorBox, Field, Icon, Kpi, Modal, MoneyInput, Select, Spinner, Tabs, useAction, useLoad } from '../components/ui.jsx'
import { Documents, Expenses, Labor, Parts, Sale, Transport } from './VehicleTabs.jsx'

const MANUAL_STATUS = ['purchased', 'awaiting_pickup', 'in_transit', 'received', 'in_inspection', 'in_preparation',
  'awaiting_parts', 'in_repair', 'in_detailing', 'ready_for_sale', 'listed', 'reserved']

export default function VehicleDetail() {
  const { id } = useParams()
  const [tab, setTab] = useState('summary')
  const [editingPrices, setEditingPrices] = useState(false)
  const [run, busy] = useAction()

  const { data, error, loading, reload } = useLoad(async () => {
    const [v, pa, budget, purchase] = await Promise.all([
      q(supabase.from('vehicles').select('*').eq('id', id).single()),
      q(supabase.from('vehicle_profit_analysis').select('*').eq('vehicle_id', id).maybeSingle()),
      q(supabase.from('vehicle_budget_vs_actual').select('*').eq('vehicle_id', id).order('sort_order')),
      q(supabase.from('vehicle_purchases').select('*, auction_sources(name)').eq('vehicle_id', id).maybeSingle()),
    ])
    return { v, pa, budget, purchase }
  }, [id])

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { v, pa, budget, purchase } = data
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
          {sold ? <Badge tone="success">Vendido</Badge> : (
            <Select value={v.status} onChange={setStatus} disabled={busy} style={{ width: 'auto', minWidth: 190 }}
              options={MANUAL_STATUS.map((s) => [s, label('vehicle_status', s)])} />
          )}
        </div>
      </div>

      {overruns.length > 0 && !sold && (
        <div className="alert-box warning">
          Acima do orçamento: {overruns.map((o) => `${label('budget_line', o.line)} (${signedMoney(o.difference)})`).join(' · ')}
        </div>
      )}

      <Tabs active={tab} onChange={setTab} tabs={[
        ['summary', 'Resumo'], ['budget', 'Orçamento'], ['transport', 'Reboque'], ['parts', 'Peças'],
        ['labor', 'Mão de obra'], ['expenses', 'Despesas'], ['documents', 'Documentos'], ['sale', sold ? 'Venda' : 'Vender'],
      ]} />

      {tab === 'summary' && <Summary v={v} pa={pa} onEditPrices={() => setEditingPrices(true)} />}
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

function Summary({ v, pa, onEditPrices }) {
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
  const set = (k) => (val) => setF((s) => ({ ...s, [k]: val }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = Object.fromEntries(Object.entries(f).map(([k, val]) => [k, toNum(val)]))
    await run(() => q(supabase.from('vehicles').update(row).eq('id', v.id)), 'Preços atualizados')
    onDone()
  }
  return (
    <Modal title="Preços de venda" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Venda esperada"><MoneyInput value={f.expected_sale_price} onChange={set('expected_sale_price')} /></Field>
        <Field label="Preço anunciado"><MoneyInput value={f.listed_price} onChange={set('listed_price')} /></Field>
        <Field label="Cenário conservador"><MoneyInput value={f.conservative_sale_price} onChange={set('conservative_sale_price')} /></Field>
        <Field label="Cenário otimista"><MoneyInput value={f.optimistic_sale_price} onChange={set('optimistic_sale_price')} /></Field>
        <Field label="Valor de mercado (clean)"><MoneyInput value={f.market_value_clean} onChange={set('market_value_clean')} /></Field>
      </div>
    </Modal>
  )
}
