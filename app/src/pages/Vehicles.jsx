import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { label, money, options, q, rpc, supabase, toNum, today, VEHICLE_STATUS_TONE, vehicleName } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Icon, Modal, MoneyInput, Select, Spinner, Tabs, useAction, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'
import { loadCovers } from '../components/photos.jsx'

const GROUPS = {
  prep: ['purchased', 'awaiting_pickup', 'in_transit', 'received', 'in_inspection', 'in_preparation', 'awaiting_parts', 'in_repair', 'in_detailing'],
  sale: ['ready_for_sale', 'listed', 'reserved'],
  sold: ['sold'],
}

export default function Vehicles() {
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [tab, setTab] = useState(['prep', 'sale', 'sold'].includes(params.get('tab')) ? params.get('tab') : 'prep')
  const [adding, setAdding] = useState(false)
  const { can } = useApp()
  const { data, error, loading } = useLoad(async () => {
    const [vehicles, profit] = await Promise.all([
      q(supabase.from('vehicles').select('id, stock_number, vin, year, make, model, trim, status, purchased_at').order('purchased_at', { ascending: false })),
      q(supabase.from('vehicle_profit_analysis').select('vehicle_id, actual_cost, projected_cost, projected_profit, real_profit, expected_sale_price, sale_price, days_since_purchase')),
    ])
    const byId = Object.fromEntries((profit || []).map((p) => [p.vehicle_id, p]))
    let covers = {}
    try { covers = await loadCovers() } catch { /* sem fotos não impede a lista */ }
    return vehicles.map((v) => ({ ...v, p: byId[v.id] || {}, cover: covers[v.id] }))
  })

  const rows = (data || []).filter((v) => GROUPS[tab].includes(v.status))
  const count = (g) => (data || []).filter((v) => GROUPS[g].includes(v.status)).length

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Veículos</h1><div className="muted small">Do arremate até a venda</div></div>
        {can('vehicles', 'create') && can('purchases', 'create') && (
          <button className="btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Adicionar veículo</button>
        )}
      </div>
      <Tabs tabs={[['prep', `Em preparação (${count('prep')})`], ['sale', `À venda (${count('sale')})`], ['sold', `Vendidos (${count('sold')})`]]} active={tab} onChange={setTab} />

      {loading ? <Spinner /> : error ? <ErrorBox error={error} /> : rows.length === 0 ? (
        <div className="card"><Empty title="Nenhum veículo aqui">Os carros entram aqui quando você registra o arremate no Auction Analyzer, ou pelo botão “Adicionar veículo” (para carros que você já comprou).</Empty></div>
      ) : (
        <div className="card pad-0">
          <div className="table-wrap hide-mobile">
            <table>
              <thead><tr>
                <th>Veículo</th><th>Estoque</th><th>Status</th><th className="num">Dias</th>
                <th className="num">Investido</th><th className="num">Custo projetado</th><th className="num">Venda</th><th className="num">Lucro</th>
              </tr></thead>
              <tbody>
                {rows.map((v) => {
                  const profit = v.status === 'sold' ? v.p.real_profit : v.p.projected_profit
                  return (
                    <tr key={v.id} className="clickable" onClick={() => nav(`/veiculos/${v.id}`)}>
                      <td><div className="row" style={{ flexWrap: 'nowrap', gap: 12 }}><Thumb src={v.cover} /><div><b>{vehicleName(v)}</b><div className="muted small">{v.vin}</div></div></div></td>
                      <td>{v.stock_number || '—'}</td>
                      <td><Badge tone={VEHICLE_STATUS_TONE[v.status]}>{label('vehicle_status', v.status)}</Badge></td>
                      <td className="num">{v.p.days_since_purchase ?? '—'}</td>
                      <td className="num">{money(v.p.actual_cost)}</td>
                      <td className="num">{money(v.p.projected_cost)}</td>
                      <td className="num">{money(v.status === 'sold' ? v.p.sale_price : v.p.expected_sale_price)}</td>
                      <td className={`num ${Number(profit) < 0 ? 'neg' : 'pos'}`}><b>{money(profit)}</b></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="list only-mobile">
            {rows.map((v) => {
              const profit = v.status === 'sold' ? v.p.real_profit : v.p.projected_profit
              return (
                <div key={v.id} className="list-item" onClick={() => nav(`/veiculos/${v.id}`)}>
                  <Thumb src={v.cover} big />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row between"><b>{vehicleName(v)}</b><Badge tone={VEHICLE_STATUS_TONE[v.status]}>{label('vehicle_status', v.status)}</Badge></div>
                    <div className="muted small">{v.stock_number ? `${v.stock_number} · ` : ''}{v.p.days_since_purchase ?? 0} dias</div>
                    <div className="row between small" style={{ marginTop: 6 }}>
                      <span>Investido <b>{money(v.p.actual_cost)}</b></span>
                      <span>Lucro <b className={Number(profit) < 0 ? 'neg' : 'pos'}>{money(profit)}</b></span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
      {adding && <AddVehicleModal onClose={() => setAdding(false)} onDone={(id) => nav(`/veiculos/${id}`)} />}
    </div>
  )
}

function Thumb({ src, big }) {
  return <div className={`thumb ${big ? 'big' : ''}`}>{src ? <img src={src} alt="" loading="lazy" /> : <Icon name="car" />}</div>
}

// Carro já comprado (fora do Auction Analyzer): registra veículo + compra + orçamento
function AddVehicleModal({ onClose, onDone }) {
  const [f, setF] = useState({
    vin: '', year: '', make: '', model: '', trim: '', odometer: '', color: '', title_status: 'clean', stock_number: '',
    source_id: '', purchase_date: today(), final_bid: '', auction_fees: '', expected_sale_price: '',
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const sources = useLoad(() => q(supabase.from('auction_sources').select('id, name, default_transport_cost').eq('is_active', true).order('name')))
  const [run, busy] = useAction()
  const src = (sources.data || []).find((s) => s.id === f.source_id)
  const ok = f.vin.length >= 11 && toNum(f.year) && f.make && f.model && toNum(f.final_bid)
  const save = async () => {
    const id = await run(() => rpc('register_direct_purchase', {
      p_vin: f.vin, p_make: f.make, p_model: f.model, p_year: toNum(f.year), p_title_status: f.title_status,
      p_final_bid: toNum(f.final_bid), p_auction_fees: toNum(f.auction_fees) ?? 0, p_purchase_date: f.purchase_date,
      p_source_id: f.source_id || null, p_expected_sale_price: toNum(f.expected_sale_price),
      p_trim: f.trim || null, p_odometer: toNum(f.odometer), p_color: f.color || null, p_stock_number: f.stock_number || null,
    }), 'Veículo adicionado')
    onDone(id)
  }
  return (
    <Modal title="Adicionar veículo já comprado" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !ok}>{busy ? 'Salvando…' : 'Adicionar'}</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Use para carros que você já comprou. Para carros que ainda vai comprar, use o Auction Analyzer.</p>
        <h3>Veículo</h3>
        <div className="form-grid">
          <Field label="VIN *" span><input value={f.vin} onChange={(e) => set('vin')(e.target.value.toUpperCase())} maxLength={17} style={{ fontFamily: 'monospace', letterSpacing: 1 }} /></Field>
          <Field label="Ano *"><input type="number" inputMode="numeric" value={f.year} onChange={(e) => set('year')(e.target.value)} /></Field>
          <Field label="Marca *"><input value={f.make} onChange={(e) => set('make')(e.target.value)} placeholder="Toyota" /></Field>
          <Field label="Modelo *"><input value={f.model} onChange={(e) => set('model')(e.target.value)} placeholder="Camry" /></Field>
          <Field label="Versão"><input value={f.trim} onChange={(e) => set('trim')(e.target.value)} /></Field>
          <Field label="Milhas"><input type="number" inputMode="numeric" value={f.odometer} onChange={(e) => set('odometer')(e.target.value)} /></Field>
          <Field label="Cor"><input value={f.color} onChange={(e) => set('color')(e.target.value)} /></Field>
          <Field label="Tipo de título"><Select value={f.title_status} onChange={set('title_status')} options={options('title_status').filter(([v]) => v !== 'unknown')} /></Field>
          <Field label="Número de estoque"><input value={f.stock_number} onChange={(e) => set('stock_number')(e.target.value)} placeholder="CK-0001" /></Field>
        </div>
        <h3>Compra</h3>
        <div className="form-grid">
          <Field label="Onde comprou"><Select value={f.source_id} onChange={set('source_id')} placeholder="Outro / compra direta" options={(sources.data || []).map((s) => [s.id, s.name])} /></Field>
          <Field label="Data da compra"><input type="date" value={f.purchase_date} onChange={(e) => set('purchase_date')(e.target.value)} /></Field>
          <Field label="Valor pago pelo carro *"><MoneyInput value={f.final_bid} onChange={set('final_bid')} /></Field>
          <Field label="Taxas do leilão pagas"><MoneyInput value={f.auction_fees} onChange={set('auction_fees')} /></Field>
          <Field label="Venda esperada"><MoneyInput value={f.expected_sale_price} onChange={set('expected_sale_price')} /></Field>
        </div>
        {src && Number(src.default_transport_cost) > 0 && (
          <div className="alert-box info">O reboque padrão de {money(src.default_transport_cost)} será criado como previsto. Confirme o valor pago na aba Reboque.</div>
        )}
        <p className="small muted" style={{ margin: 0 }}>Peças, mão de obra e outras despesas que você já teve podem ser lançadas depois, nas abas do veículo.</p>
      </div>
    </Modal>
  )
}
