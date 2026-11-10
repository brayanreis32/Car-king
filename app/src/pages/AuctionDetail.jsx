import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { date, label, money, options, OPP_STATUS_TONE, pct, q, rpc, supabase, toNum, today, vehicleName } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Icon, Modal, MoneyInput, Select, Spinner, useAction, useLoad, useToast } from '../components/ui.jsx'
import { OpportunityForm } from './Auctions.jsx'
import { useApp } from '../App.jsx'
import { DeleteRecordButton } from '../components/deleteRecord.jsx'

const MANUAL_STATUS = ['analyzing', 'awaiting_inspection', 'awaiting_quote', 'approved', 'lost', 'discarded']

export default function AuctionDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const [run, busy] = useAction()
  const [editing, setEditing] = useState(false)
  const [buying, setBuying] = useState(false)
  const [discarding, setDiscarding] = useState(false)

  const { data, error, loading, reload } = useLoad(async () => {
    const [opp, damages, sims, bids, vehicle] = await Promise.all([
      q(supabase.from('auction_opportunities').select('*, auction_sources(id, name, default_transport_cost, bid_increment)').eq('id', id).single()),
      q(supabase.from('vehicle_damage_assessments').select('*').eq('opportunity_id', id).order('created_at')),
      q(supabase.from('auction_simulations').select('*').eq('opportunity_id', id).order('is_baseline', { ascending: false }).order('created_at', { ascending: false })),
      q(supabase.from('auction_bids').select('*').eq('opportunity_id', id).order('placed_at', { ascending: false })),
      q(supabase.from('vehicles').select('id').eq('opportunity_id', id).maybeSingle()),
    ])
    return { opp, damages, sims, bids, vehicle }
  }, [id])

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { opp, damages, sims, bids, vehicle } = data
  const won = opp.status === 'won'

  const setStatus = async (status) => {
    if (status === 'discarded') { setDiscarding(true); return }
    await run(() => q(supabase.from('auction_opportunities').update({ status }).eq('id', id)), 'Status atualizado')
    reload()
  }

  return (
    <div className="stack">
      <div>
        <Link to="/leiloes" className="back"><Icon name="back" size={16} /> Leilões</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>{vehicleName(opp)}</h1>
            <div className="muted small">
              {opp.auction_sources?.name || opp.auction_name || 'Leilão não informado'}
              {opp.lot_number && ` · Lote ${opp.lot_number}`} · {date(opp.auction_date)}
              {opp.listing_url && <> · <a href={opp.listing_url} target="_blank" rel="noreferrer">ver anúncio</a></>}
            </div>
          </div>
          <div className="row">
            <Badge tone={OPP_STATUS_TONE[opp.status]}>{label('opportunity_status', opp.status)}</Badge>
            {!won && <button className="btn-sm" onClick={() => setEditing(true)}><Icon name="edit" /> Editar</button>}
            <DeleteRecordButton kind="opportunity" id={opp.id} name={vehicleName(opp)} withVehicle={Boolean(vehicle)} redirectTo="/leiloes" />
          </div>
        </div>
      </div>

      {won && vehicle && (
        <div className="alert-box success row between">
          <span>Carro arrematado e cadastrado no estoque.</span>
          <Link to={`/veiculos/${vehicle.id}`} className="btn btn-sm btn-primary">Abrir veículo</Link>
        </div>
      )}

      <div className="grid grid-2" style={{ alignItems: 'start' }}>
        <div className="stack">
          <Simulator opp={opp} sims={sims} damages={damages} readOnly={won} onSaved={reload} />
        </div>
        <div className="stack">
          <InfoCard opp={opp} />
          <TitleCard opp={opp} onChange={reload} readOnly={won} />
          <Damages opp={opp} damages={damages} onChange={reload} readOnly={won} />
          {!won && <Bids opp={opp} bids={bids} maxBid={sims[0]?.max_bid} onChange={reload} />}

          {!won && (
            <div className="card stack">
              <h2>Decisão</h2>
              <Field label="Status da análise">
                <Select value={MANUAL_STATUS.includes(opp.status) ? opp.status : ''} onChange={setStatus}
                  placeholder={MANUAL_STATUS.includes(opp.status) ? undefined : label('opportunity_status', opp.status)}
                  options={MANUAL_STATUS.map((s) => [s, label('opportunity_status', s)])} disabled={busy} />
              </Field>
              <button className="btn-primary" onClick={() => setBuying(true)}>Arrematei: registrar compra</button>
            </div>
          )}
        </div>
      </div>

      {editing && <OpportunityForm initial={opp} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload() }} />}
      {buying && <PurchaseModal opp={opp} bids={bids} onClose={() => setBuying(false)} onDone={(vid) => nav(`/veiculos/${vid}`)} />}
      {discarding && <DiscardModal opp={opp} onClose={() => setDiscarding(false)} onDone={() => { setDiscarding(false); reload() }} />}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Simulador ao vivo
// -----------------------------------------------------------------------------
function Simulator({ opp, sims, damages, readOnly, onSaved }) {
  const { company } = useApp()
  const toast = useToast()
  const base = sims[0]
  const damageCost = damages.reduce((s, d) => s + Number(d.estimated_cost || 0), 0)
  const towDefault = Number(opp.auction_sources?.default_transport_cost || 0)

  const init = () => ({
    expected_sale_price: base?.expected_sale_price ?? opp.expected_value_repaired ?? '',
    conservative_sale_price: base?.conservative_sale_price ?? '',
    optimistic_sale_price: base?.optimistic_sale_price ?? '',
    planned_bid: base?.planned_bid ?? opp.current_bid ?? '',
    auction_fees_override: base?.auction_fees_override ?? '',
    transport_cost: base ? (Number(base.transport_cost) === towDefault ? '' : base.transport_cost) : '',
    documentation_cost: base?.documentation_cost ?? '',
    parts_cost: base?.parts_cost ?? '',
    labor_cost: base?.labor_cost ?? '',
    inspection_cost: base?.inspection_cost ?? '',
    other_costs: base?.other_costs ?? '',
    contingency_amount: base?.contingency_amount ?? '',
    selling_costs: base?.selling_costs ?? '',
    min_profit: base?.min_profit ?? company.default_min_profit,
    min_margin_pct: base?.min_margin_pct ?? company.default_min_margin_pct,
  })
  const [f, setF] = useState(init)
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [result, setResult] = useState(null)
  const [err, setErr] = useState(null)
  const [saving, setSaving] = useState(false)
  const timer = useRef()

  const args = useMemo(() => ({
    p_expected_sale_price: toNum(f.expected_sale_price),
    p_planned_bid: toNum(f.planned_bid) ?? 0,
    p_source_id: opp.source_id,
    p_auction_fees_override: toNum(f.auction_fees_override),
    p_transport_cost: toNum(f.transport_cost),
    p_documentation_cost: toNum(f.documentation_cost) ?? 0,
    p_parts_cost: toNum(f.parts_cost) ?? 0,
    p_labor_cost: toNum(f.labor_cost) ?? 0,
    p_inspection_cost: toNum(f.inspection_cost) ?? 0,
    p_other_costs: toNum(f.other_costs) ?? 0,
    p_contingency_amount: toNum(f.contingency_amount),
    p_contingency_pct: toNum(f.contingency_amount) === null ? Number(company.default_contingency_pct) : null,
    p_selling_costs: toNum(f.selling_costs) ?? 0,
    p_min_profit: toNum(f.min_profit),
    p_min_margin_pct: toNum(f.min_margin_pct),
    p_min_roi_pct: Number(company.default_min_roi_pct) > 0 ? Number(company.default_min_roi_pct) : null,
    p_conservative_sale_price: toNum(f.conservative_sale_price),
    p_optimistic_sale_price: toNum(f.optimistic_sale_price),
  }), [f, opp.source_id, company])

  useEffect(() => {
    clearTimeout(timer.current)
    if (!args.p_expected_sale_price) { setResult(null); return }
    timer.current = setTimeout(() => {
      rpc('simulate_purchase', args).then((r) => { setResult(r); setErr(null) }, setErr)
    }, 250)
    return () => clearTimeout(timer.current)
  }, [args])

  const save = async () => {
    setSaving(true)
    try {
      const row = {
        opportunity_id: opp.id, name: `Simulação ${new Date().toLocaleDateString('pt-BR')}`,
        expected_sale_price: args.p_expected_sale_price, conservative_sale_price: args.p_conservative_sale_price,
        optimistic_sale_price: args.p_optimistic_sale_price, planned_bid: args.p_planned_bid,
        auction_fees_override: args.p_auction_fees_override, transport_cost: args.p_transport_cost,
        documentation_cost: args.p_documentation_cost, parts_cost: args.p_parts_cost, labor_cost: args.p_labor_cost,
        inspection_cost: args.p_inspection_cost, other_costs: args.p_other_costs,
        contingency_amount: args.p_contingency_amount, contingency_pct: args.p_contingency_pct,
        selling_costs: args.p_selling_costs, min_profit: args.p_min_profit, min_margin_pct: args.p_min_margin_pct,
        min_roi_pct: args.p_min_roi_pct, is_baseline: false,
      }
      // a simulação mais recente vira a principal (orçamento usado na compra)
      await q(supabase.from('auction_simulations').update({ is_baseline: false }).eq('opportunity_id', opp.id).eq('is_baseline', true).eq('locked', false))
      await q(supabase.from('auction_simulations').insert({ ...row, is_baseline: true }))
      toast('Simulação salva como orçamento principal')
      onSaved()
    } catch (e) { toast(e.message, 'error') } finally { setSaving(false) }
  }

  const r = result
  const profitTone = r && Number(r.projected_profit) < 0 ? 'neg' : 'pos'
  const verdictText = r && {
    viable: `Pode dar o lance de ${money(args.p_planned_bid)}. O limite é ${money(r.max_bid)}.`,
    above_limit: `O lance planejado passa do limite. Não pague mais que ${money(r.max_bid)}.`,
    not_viable: 'Com esses custos e esse preço de venda, nenhum lance atinge sua meta.',
  }[r.decision]

  return (
    <div className="card stack">
      <div className="card-title" style={{ marginBottom: 0 }}>
        <h2>Simulador de compra</h2>
        {base?.locked && <Badge tone="success">Orçamento usado na compra</Badge>}
      </div>

      {r && (
        <div className={`verdict ${r.decision}`}>
          <div className="small muted">Lance máximo recomendado</div>
          <div className="big gold">{money(r.max_bid)}</div>
          <div className="small muted">
            taxas nesse lance {money(r.max_bid_fees)} · limitado por {label('binding_rule', r.max_bid_binding_rule)}
          </div>
          <div className="divider" />
          <div style={{ fontWeight: 700 }}>{label('decision', r.decision)}</div>
          <div className="small">{verdictText}</div>
        </div>
      )}
      <ErrorBox error={err} />

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
        <div className="form-grid">
          <Field label="Preço de venda esperado *"><MoneyInput value={f.expected_sale_price} onChange={set('expected_sale_price')} /></Field>
          <Field label="Seu lance planejado"><MoneyInput value={f.planned_bid} onChange={set('planned_bid')} /></Field>
        </div>

        <h3 className="gold">Custos previstos</h3>
        <div className="form-grid">
          <Field label="Taxas do leilão"><MoneyInput value={f.auction_fees_override} onChange={set('auction_fees_override')} placeholder={r ? `${r.auction_fees} (auto)` : 'automático'} /></Field>
          <Field label="Reboque / transporte"><MoneyInput value={f.transport_cost} onChange={set('transport_cost')} placeholder={`${towDefault} (padrão)`} /></Field>
          <Field label="Peças"><MoneyInput value={f.parts_cost} onChange={set('parts_cost')} /></Field>
          <Field label="Mão de obra"><MoneyInput value={f.labor_cost} onChange={set('labor_cost')} /></Field>
          <Field label="Documentação"><MoneyInput value={f.documentation_cost} onChange={set('documentation_cost')} /></Field>
          <Field label="Inspeção"><MoneyInput value={f.inspection_cost} onChange={set('inspection_cost')} /></Field>
          <Field label="Outros custos"><MoneyInput value={f.other_costs} onChange={set('other_costs')} /></Field>
          <Field label="Reserva de imprevistos"><MoneyInput value={f.contingency_amount} onChange={set('contingency_amount')} placeholder={`${Number(company.default_contingency_pct)}% auto`} /></Field>
          <Field label="Despesas de venda"><MoneyInput value={f.selling_costs} onChange={set('selling_costs')} /></Field>
        </div>
        {damageCost > 0 && toNum(f.parts_cost) === null && !readOnly && (
          <button type="button" className="btn-sm btn-ghost" onClick={() => set('parts_cost')(String(damageCost))}>
            Usar estimativa dos danos ({money(damageCost)}) como peças
          </button>
        )}

        <h3 className="gold">Metas e cenários</h3>
        <div className="form-grid">
          <Field label="Lucro mínimo"><MoneyInput value={f.min_profit} onChange={set('min_profit')} /></Field>
          <Field label="Margem mínima (%)"><input type="number" inputMode="decimal" value={f.min_margin_pct} onChange={(e) => set('min_margin_pct')(e.target.value)} /></Field>
          <Field label="Venda conservadora"><MoneyInput value={f.conservative_sale_price} onChange={set('conservative_sale_price')} /></Field>
          <Field label="Venda otimista"><MoneyInput value={f.optimistic_sale_price} onChange={set('optimistic_sale_price')} /></Field>
        </div>
      </fieldset>

      {r && (
        <>
          <div className="lines num">
            <div><span>Lance</span><span>{money(args.p_planned_bid)}</span></div>
            <div><span>Taxas do leilão</span><span>{money(r.auction_fees)}</span></div>
            <div><span>Reboque / transporte</span><span>{money(r.transport_cost)}</span></div>
            <div><span>Peças + mão de obra</span><span>{money(args.p_parts_cost + args.p_labor_cost)}</span></div>
            <div><span>Documentação, inspeção e outros</span><span>{money(args.p_documentation_cost + args.p_inspection_cost + args.p_other_costs)}</span></div>
            <div><span>Reserva de imprevistos</span><span>{money(r.contingency_total)}</span></div>
            <div className="total"><span>Investimento total</span><span>{money(r.total_investment)}</span></div>
          </div>
          <div className="grid grid-3">
            <div className="kpi"><div className="label">Lucro</div><div className={`value ${profitTone}`}>{money(r.projected_profit)}</div></div>
            <div className="kpi"><div className="label">Margem</div><div className="value">{pct(r.margin_pct)}</div></div>
            <div className="kpi"><div className="label">ROI</div><div className="value">{pct(r.roi_pct)}</div></div>
          </div>
          {(r.conservative_profit !== null || r.optimistic_profit !== null) && (
            <div className="lines num">
              <div><span className="muted">Cenário conservador ({money(args.p_conservative_sale_price)})</span><span className={Number(r.conservative_profit) < 0 ? 'neg' : ''}>{money(r.conservative_profit)}</span></div>
              <div><span className="muted">Cenário esperado ({money(args.p_expected_sale_price)})</span><span>{money(r.projected_profit)}</span></div>
              <div><span className="muted">Cenário otimista ({money(args.p_optimistic_sale_price)})</span><span>{money(r.optimistic_profit)}</span></div>
            </div>
          )}
          <div className="small muted">Preço mínimo para não ter prejuízo: <b>{money(r.break_even_sale_price)}</b></div>
          {!readOnly && <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Salvando…' : 'Salvar simulação'}</button>}
        </>
      )}
      {!r && !err && <div className="muted small">Informe o preço de venda esperado para calcular.</div>}
    </div>
  )
}

// -----------------------------------------------------------------------------
function InfoCard({ opp }) {
  const rows = [
    ['VIN', opp.vin || '—'], ['Milhas', opp.odometer ? `${Number(opp.odometer).toLocaleString('en-US')} ${opp.odometer_unit}` : '—'],
    ['Cor', opp.color || '—'], ['Funcionamento', label('run_condition', opp.run_condition)],
    ['Chaves', opp.has_keys === null ? '—' : opp.has_keys ? 'Sim' : 'Não'],
    ['Dano principal', opp.primary_damage || '—'], ['Dano secundário', opp.secondary_damage || '—'],
    ['Local', [opp.location_city, opp.location_state].filter(Boolean).join(', ') || '—'],
    ['Lance atual', money(opp.current_bid)], ['Revenda normal', money(opp.market_value_clean)],
    ['Valor após reparos', money(opp.expected_value_repaired)],
  ]
  return (
    <div className="card">
      <h2 style={{ marginBottom: 10 }}>Dados do veículo</h2>
      <div className="lines small">{rows.map(([k, v]) => <div key={k}><span className="muted">{k}</span><span style={{ textAlign: 'right' }}>{v}</span></div>)}</div>
      {opp.notes && <p className="small muted" style={{ marginBottom: 0 }}>{opp.notes}</p>}
    </div>
  )
}

function TitleCard({ opp, onChange, readOnly }) {
  const [run, busy] = useAction()
  const [notes, setNotes] = useState(opp.title_notes || '')
  const verify = async () => {
    await run(() => q(supabase.from('auction_opportunities').update({ title_verified: true, title_notes: notes || null }).eq('id', opp.id)), 'Título validado')
    onChange()
  }
  if (opp.title_verified) {
    return (
      <div className="alert-box success">
        ✓ Título <b>{label('title_status', opp.title_status)}</b>{opp.title_state && ` (${opp.title_state})`} validado em {date(opp.title_verified_at)}.
        {opp.title_notes && <div className="small" style={{ marginTop: 4 }}>{opp.title_notes}</div>}
      </div>
    )
  }
  return (
    <div className="card stack" style={{ borderLeft: '4px solid var(--warning)' }}>
      <h2>Título: {label('title_status', opp.title_status)}</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Antes de aprovar ou comprar, confirme se esse tipo de título permite registrar e revender o carro no seu estado.
        Salvage, rebuilt e outros títulos têm regras diferentes.
      </p>
      {!readOnly && <>
        <Field label="Observações da validação"><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: salvage NH, precisa de inspeção para rebuilt" /></Field>
        <button onClick={verify} disabled={busy || opp.title_status === 'unknown'}>
          {opp.title_status === 'unknown' ? 'Informe o tipo de título (Editar)' : 'Confirmar que o título foi validado'}
        </button>
      </>}
    </div>
  )
}

function Damages({ opp, damages, onChange, readOnly }) {
  const [adding, setAdding] = useState(false)
  const [run] = useAction()
  const total = damages.reduce((s, d) => s + Number(d.estimated_cost || 0), 0)
  const remove = async (d) => {
    await run(() => q(supabase.from('vehicle_damage_assessments').delete().eq('id', d.id)), 'Dano removido')
    onChange()
  }
  return (
    <div className="card pad-0">
      <div className="card-title" style={{ padding: '16px 16px 0' }}>
        <h2>Danos ({money(total)})</h2>
        {!readOnly && <button className="btn-sm" onClick={() => setAdding(true)}><Icon name="plus" /> Dano</button>}
      </div>
      {damages.length === 0 ? <Empty title="Nenhum dano registrado" /> : (
        <div className="list">
          {damages.map((d) => (
            <div key={d.id} className="list-item" style={{ cursor: 'default' }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div><b>{label('vehicle_area', d.area)}</b> · {label('item_condition', d.condition)}</div>
                {d.description && <div className="muted small">{d.description}</div>}
              </div>
              <div className="num">{money(d.estimated_cost)}</div>
              {!readOnly && <button className="btn-ghost btn-sm" onClick={() => remove(d)} aria-label="Remover"><Icon name="trash" /></button>}
            </div>
          ))}
        </div>
      )}
      {adding && <DamageModal opp={opp} onClose={() => setAdding(false)} onDone={() => { setAdding(false); onChange() }} />}
    </div>
  )
}

function DamageModal({ opp, onClose, onDone }) {
  const [f, setF] = useState({ area: 'front', condition: 'needs_replacement', severity: 'medium', description: '', estimated_cost: '' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    await run(() => q(supabase.from('vehicle_damage_assessments').insert({ ...f, opportunity_id: opp.id, estimated_cost: toNum(f.estimated_cost) ?? 0 })), 'Dano registrado')
    onDone()
  }
  return (
    <Modal title="Registrar dano" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Área"><Select value={f.area} onChange={set('area')} options={options('vehicle_area')} /></Field>
        <Field label="Condição"><Select value={f.condition} onChange={set('condition')} options={options('item_condition')} /></Field>
        <Field label="Gravidade"><Select value={f.severity} onChange={set('severity')} options={options('severity')} /></Field>
        <Field label="Custo estimado"><MoneyInput value={f.estimated_cost} onChange={set('estimated_cost')} /></Field>
        <Field label="Descrição / reparo necessário" full><textarea value={f.description} onChange={(e) => set('description')(e.target.value)} placeholder="Ex.: para-choque e farol esquerdo quebrados" /></Field>
      </div>
    </Modal>
  )
}

function Bids({ opp, bids, maxBid, onChange }) {
  const [amount, setAmount] = useState('')
  const [run, busy] = useAction()
  const add = async () => {
    if (!toNum(amount)) return
    await run(() => q(supabase.from('auction_bids').insert({ opportunity_id: opp.id, amount: toNum(amount) })), 'Lance registrado')
    setAmount(''); onChange()
  }
  const over = maxBid && toNum(amount) > Number(maxBid)
  return (
    <div className="card stack">
      <h2>Lances</h2>
      <div className="row">
        <div className="grow"><MoneyInput value={amount} onChange={setAmount} placeholder="Valor do lance" /></div>
        <button onClick={add} disabled={busy || !opp.title_verified} title={!opp.title_verified ? 'Valide o título antes de dar lance' : ''}>Registrar</button>
      </div>
      {over && <div className="alert-box warning">Esse lance passa do seu limite de {money(maxBid)}.</div>}
      {!opp.title_verified && <div className="small muted">Valide o título para registrar lances.</div>}
      {bids.length > 0 && (
        <div className="lines small num">
          {bids.map((b) => (
            <div key={b.id}><span className="muted">{date(b.placed_at)}</span><span className={b.exceeds_max_bid ? 'warn' : ''}>{money(b.amount)}{b.exceeds_max_bid && ' (acima do limite)'}</span></div>
          ))}
        </div>
      )}
    </div>
  )
}

function PurchaseModal({ opp, bids, onClose, onDone }) {
  const [f, setF] = useState({
    final_bid: bids[0]?.amount ?? opp.current_bid ?? '', buyer_fee: '', other_fees: '',
    purchase_date: today(), payment_method: '', payment_due_date: '', stock_number: '',
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [autoFee, setAutoFee] = useState(null)
  const [run, busy] = useAction()

  useEffect(() => {
    const bid = toNum(f.final_bid)
    if (!bid || !opp.source_id) { setAutoFee(null); return }
    rpc('calculate_auction_fees', { p_source_id: opp.source_id, p_bid: bid }).then(setAutoFee, () => setAutoFee(null))
  }, [f.final_bid, opp.source_id])

  const problems = [
    !opp.title_verified && 'Valide o título do veículo.',
    !opp.vin && 'Informe o VIN (botão Editar).',
  ].filter(Boolean)

  const confirm = async () => {
    const vid = await run(() => rpc('register_purchase', {
      p_opportunity_id: opp.id,
      p_final_bid: toNum(f.final_bid),
      p_buyer_fee: toNum(f.buyer_fee),
      p_other_fees: toNum(f.other_fees) ?? 0,
      p_purchase_date: f.purchase_date,
      p_payment_method: f.payment_method || null,
      p_payment_due_date: f.payment_due_date || null,
      p_stock_number: f.stock_number || null,
    }), 'Compra registrada! Veículo adicionado ao estoque.')
    onDone(vid)
  }

  const totalFees = toNum(f.buyer_fee) ?? autoFee
  return (
    <Modal title="Registrar compra" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={confirm} disabled={busy || problems.length > 0 || !toNum(f.final_bid)}>Confirmar compra</button></>}>
      <div className="stack">
        {problems.map((p) => <div key={p} className="alert-box warning">{p}</div>)}
        <div className="form-grid">
          <Field label="Lance vencedor *"><MoneyInput value={f.final_bid} onChange={set('final_bid')} /></Field>
          <Field label="Taxas do leilão (total cobrado)"><MoneyInput value={f.buyer_fee} onChange={set('buyer_fee')} placeholder={autoFee !== null ? `${autoFee} (tabela)` : ''} /></Field>
          <Field label="Outras taxas"><MoneyInput value={f.other_fees} onChange={set('other_fees')} /></Field>
          <Field label="Data da compra"><input type="date" value={f.purchase_date} onChange={(e) => set('purchase_date')(e.target.value)} /></Field>
          <Field label="Forma de pagamento"><Select value={f.payment_method} onChange={set('payment_method')} placeholder="—" options={options('payment_method')} /></Field>
          <Field label="Vencimento do pagamento"><input type="date" value={f.payment_due_date} onChange={(e) => set('payment_due_date')(e.target.value)} /></Field>
          <Field label="Número de estoque"><input value={f.stock_number} onChange={(e) => set('stock_number')(e.target.value)} placeholder="CK-0001" /></Field>
        </div>
        {toNum(f.final_bid) && (
          <div className="lines num">
            <div><span>Lance</span><span>{money(f.final_bid, true)}</span></div>
            <div><span>Taxas</span><span>{money((totalFees ?? 0) + (toNum(f.other_fees) ?? 0), true)}</span></div>
            <div className="total"><span>Total a pagar ao leilão</span><span>{money(toNum(f.final_bid) + (totalFees ?? 0) + (toNum(f.other_fees) ?? 0), true)}</span></div>
          </div>
        )}
        <p className="small muted" style={{ margin: 0 }}>
          A simulação principal vira o orçamento do carro e fica guardada para comparar previsto × real.
          O reboque, os documentos pendentes e a conta a pagar do leilão são criados automaticamente.
        </p>
      </div>
    </Modal>
  )
}

function DiscardModal({ opp, onClose, onDone }) {
  const [reason, setReason] = useState('')
  const [run, busy] = useAction()
  const save = async () => {
    await run(() => q(supabase.from('auction_opportunities').update({ status: 'discarded', discard_reason: reason }).eq('id', opp.id)), 'Carro descartado')
    onDone()
  }
  return (
    <Modal title="Descartar carro" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-danger" onClick={save} disabled={busy || !reason.trim()}>Descartar</button></>}>
      <Field label="Motivo"><textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: dano estrutural, margem baixa, título não permite revenda" /></Field>
    </Modal>
  )
}
