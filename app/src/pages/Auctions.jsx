import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { date, label, money, options, OPP_STATUS_TONE, q, supabase, toNum, vehicleName } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Icon, Modal, MoneyInput, Select, Spinner, Tabs, useAction, useLoad } from '../components/ui.jsx'

const DECISION_TONE = { viable: 'success', above_limit: 'warning', not_viable: 'error' }
const OPEN = ['analyzing', 'awaiting_inspection', 'awaiting_quote', 'approved', 'bid_placed']

export default function Auctions() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState('open')
  const creating = params.get('novo') === '1'
  const { data, error, loading, reload } = useLoad(() =>
    q(supabase.from('auction_opportunity_overview').select('*').order('auction_date', { ascending: true, nullsFirst: false })),
  )

  const rows = (data || []).filter((o) =>
    filter === 'open' ? OPEN.includes(o.status) : filter === 'won' ? o.status === 'won' : !OPEN.includes(o.status) && o.status !== 'won')

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Auction Analyzer</h1>
          <div className="muted small">Analise o carro antes de dar o lance</div>
        </div>
        <button className="btn-primary" onClick={() => setParams({ novo: '1' })}><Icon name="plus" /> Novo carro</button>
      </div>

      <Tabs tabs={[['open', 'Em análise'], ['won', 'Arrematados'], ['closed', 'Descartados / perdidos']]} active={filter} onChange={setFilter} />

      {loading ? <Spinner /> : error ? <ErrorBox error={error} /> : rows.length === 0 ? (
        <div className="card"><Empty title="Nenhum carro aqui">Cadastre um carro que você encontrou no leilão para ver se vale a pena.</Empty></div>
      ) : (
        <div className="card pad-0">
          <div className="table-wrap hide-mobile">
            <table>
              <thead><tr>
                <th>Veículo</th><th>Leilão / lote</th><th>Data</th><th>Título</th><th>Status</th>
                <th className="num">Lance atual</th><th className="num">Lance máximo</th><th className="num">Lucro proj.</th><th>Decisão</th>
              </tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.opportunity_id} className="clickable" onClick={() => nav(`/leiloes/${o.opportunity_id}`)}>
                    <td><b>{vehicleName(o)}</b><div className="muted small">{o.vin || 'sem VIN'}</div></td>
                    <td>{o.source_name || o.auction_name || '—'}<div className="muted small">{o.lot_number ? `Lote ${o.lot_number}` : ''}</div></td>
                    <td>{date(o.auction_date)}</td>
                    <td>{label('title_status', o.title_status)}{o.title_verified && <span className="pos"> ✓</span>}</td>
                    <td><Badge tone={OPP_STATUS_TONE[o.status]}>{label('opportunity_status', o.status)}</Badge></td>
                    <td className="num">{money(o.current_bid)}</td>
                    <td className="num gold"><b>{money(o.max_bid)}</b></td>
                    <td className={`num ${Number(o.projected_profit) < 0 ? 'neg' : ''}`}>{money(o.projected_profit)}</td>
                    <td>{o.decision ? <Badge tone={DECISION_TONE[o.decision]}>{label('decision', o.decision)}</Badge> : <span className="muted small">sem simulação</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="list only-mobile">
            {rows.map((o) => (
              <div key={o.opportunity_id} className="list-item" onClick={() => nav(`/leiloes/${o.opportunity_id}`)}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row between"><b>{vehicleName(o)}</b><Badge tone={OPP_STATUS_TONE[o.status]}>{label('opportunity_status', o.status)}</Badge></div>
                  <div className="muted small">{o.source_name || o.auction_name || '—'} {o.lot_number ? `· Lote ${o.lot_number}` : ''} · {date(o.auction_date)}</div>
                  <div className="row between small" style={{ marginTop: 6 }}>
                    <span>Lance máx. <b className="gold">{money(o.max_bid)}</b></span>
                    {o.decision ? <Badge tone={DECISION_TONE[o.decision]}>{label('decision', o.decision)}</Badge> : <span className="muted">sem simulação</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {creating && (
        <OpportunityForm
          onClose={() => setParams({})}
          onSaved={(id) => { reload(); nav(`/leiloes/${id}`) }}
        />
      )}
    </div>
  )
}

const EMPTY = {
  source_id: '', auction_name: '', lot_number: '', vin: '', year: '', make: '', model: '', trim: '', odometer: '',
  color: '', fuel_type: '', transmission: '', location_city: '', location_state: '', auction_date: '',
  title_status: 'unknown', title_state: '', primary_damage: '', secondary_damage: '', run_condition: 'unknown', has_keys: '',
  listing_url: '', current_bid: '', buy_now_price: '', market_value_clean: '', expected_value_repaired: '', notes: '',
}

export function OpportunityForm({ initial, onClose, onSaved }) {
  const [f, setF] = useState(() => (initial ? { ...EMPTY, ...Object.fromEntries(Object.entries(initial).map(([k, v]) => [k, v ?? ''])), auction_date: initial.auction_date?.slice(0, 10) || '', has_keys: initial.has_keys === null ? '' : String(initial.has_keys) } : EMPTY))
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const ev = (k) => (e) => set(k)(e.target.value)
  const [run, busy] = useAction()
  const sources = useLoad(() => q(supabase.from('auction_sources').select('id, name').eq('is_active', true).order('name')))

  const save = async (e) => {
    e.preventDefault()
    const row = {
      source_id: f.source_id || null, auction_name: f.auction_name || null, lot_number: f.lot_number || null,
      vin: f.vin || null, year: toNum(f.year), make: f.make, model: f.model, trim: f.trim || null,
      odometer: toNum(f.odometer), color: f.color || null, fuel_type: f.fuel_type || null, transmission: f.transmission || null,
      location_city: f.location_city || null, location_state: f.location_state || null,
      auction_date: f.auction_date ? `${f.auction_date}T12:00:00` : null,
      title_status: f.title_status, title_state: f.title_state || null,
      primary_damage: f.primary_damage || null, secondary_damage: f.secondary_damage || null,
      run_condition: f.run_condition, has_keys: f.has_keys === '' ? null : f.has_keys === 'true',
      listing_url: f.listing_url || null, current_bid: toNum(f.current_bid), buy_now_price: toNum(f.buy_now_price),
      market_value_clean: toNum(f.market_value_clean), expected_value_repaired: toNum(f.expected_value_repaired), notes: f.notes || null,
    }
    const saved = await run(() => initial
      ? q(supabase.from('auction_opportunities').update(row).eq('id', initial.id).select('id').single())
      : q(supabase.from('auction_opportunities').insert(row).select('id').single()), 'Carro salvo')
    onSaved(saved.id)
  }

  return (
    <Modal title={initial ? 'Editar carro do leilão' : 'Novo carro do leilão'} onClose={onClose}
      footer={<><button type="button" onClick={onClose}>Cancelar</button><button className="btn-primary" form="opp-form" disabled={busy}>{busy ? 'Salvando…' : 'Salvar'}</button></>}>
      <form id="opp-form" className="stack" onSubmit={save}>
        <h3 className="gold">Leilão</h3>
        <div className="form-grid">
          <Field label="Leilão / plataforma">
            <Select value={f.source_id} onChange={set('source_id')} placeholder="Selecione" options={(sources.data || []).map((s) => [s.id, s.name])} />
          </Field>
          <Field label="Número do lote"><input value={f.lot_number} onChange={ev('lot_number')} /></Field>
          <Field label="Data do leilão"><input type="date" value={f.auction_date} onChange={ev('auction_date')} /></Field>
          <Field label="Lance atual"><MoneyInput value={f.current_bid} onChange={set('current_bid')} /></Field>
          <Field label="Link do anúncio" span><input type="url" value={f.listing_url} onChange={ev('listing_url')} placeholder="https://" /></Field>
          <Field label="Cidade"><input value={f.location_city} onChange={ev('location_city')} /></Field>
          <Field label="Estado"><input value={f.location_state} onChange={ev('location_state')} maxLength={2} placeholder="NH" /></Field>
        </div>

        <h3 className="gold">Veículo</h3>
        <div className="form-grid">
          <Field label="Ano *"><input required type="number" inputMode="numeric" min="1950" max="2100" value={f.year} onChange={ev('year')} /></Field>
          <Field label="Marca *"><input required value={f.make} onChange={ev('make')} placeholder="Toyota" /></Field>
          <Field label="Modelo *"><input required value={f.model} onChange={ev('model')} placeholder="Camry" /></Field>
          <Field label="Versão"><input value={f.trim} onChange={ev('trim')} placeholder="SE" /></Field>
          <Field label="VIN" span><input value={f.vin} onChange={(e) => set('vin')(e.target.value.toUpperCase())} maxLength={17} style={{ fontFamily: 'monospace', letterSpacing: 1 }} /></Field>
          <Field label="Milhas"><input type="number" inputMode="numeric" value={f.odometer} onChange={ev('odometer')} /></Field>
          <Field label="Cor"><input value={f.color} onChange={ev('color')} /></Field>
          <Field label="Combustível"><Select value={f.fuel_type} onChange={set('fuel_type')} placeholder="—" options={options('fuel_type')} /></Field>
          <Field label="Câmbio"><Select value={f.transmission} onChange={set('transmission')} placeholder="—" options={options('transmission')} /></Field>
        </div>

        <h3 className="gold">Condição e título</h3>
        <div className="form-grid">
          <Field label="Tipo de título"><Select value={f.title_status} onChange={set('title_status')} options={options('title_status')} /></Field>
          <Field label="Estado do título"><input value={f.title_state} onChange={ev('title_state')} maxLength={2} /></Field>
          <Field label="Dano principal"><input value={f.primary_damage} onChange={ev('primary_damage')} placeholder="Front end" /></Field>
          <Field label="Dano secundário"><input value={f.secondary_damage} onChange={ev('secondary_damage')} /></Field>
          <Field label="Funcionamento"><Select value={f.run_condition} onChange={set('run_condition')} options={options('run_condition')} /></Field>
          <Field label="Chaves"><Select value={f.has_keys} onChange={set('has_keys')} placeholder="Não informado" options={[['true', 'Sim'], ['false', 'Não']]} /></Field>
        </div>

        <h3 className="gold">Valores de mercado</h3>
        <div className="form-grid">
          <Field label="Revenda em condições normais"><MoneyInput value={f.market_value_clean} onChange={set('market_value_clean')} /></Field>
          <Field label="Valor esperado após reparos"><MoneyInput value={f.expected_value_repaired} onChange={set('expected_value_repaired')} /></Field>
          <Field label="Buy now (se houver)"><MoneyInput value={f.buy_now_price} onChange={set('buy_now_price')} /></Field>
          <Field label="Observações" full><textarea value={f.notes} onChange={ev('notes')} /></Field>
        </div>
      </form>
    </Modal>
  )
}
