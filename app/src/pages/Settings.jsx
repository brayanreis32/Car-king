import { useState } from 'react'
import { money, q, supabase, toNum } from '../lib.js'
import { ErrorBox, Field, Icon, Modal, MoneyInput, Spinner, useAction, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'

export default function Settings() {
  const { company, can, reloadCompany, profile } = useApp()
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Configurações</h1><div className="muted small">{company.name} · {profile.roles?.name}</div></div></div>
      <Goals company={company} canEdit={can('settings', 'edit')} onSaved={reloadCompany} />
      <Sources canEdit={can('auction', 'edit')} />
    </div>
  )
}

function Goals({ company, canEdit, onSaved }) {
  const [f, setF] = useState({
    default_min_profit: company.default_min_profit, default_min_margin_pct: company.default_min_margin_pct,
    default_contingency_pct: company.default_contingency_pct, budget_alert_pct: company.budget_alert_pct,
    stale_vehicle_days: company.stale_vehicle_days, payable_alert_days: company.payable_alert_days,
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, toNum(v) ?? 0]))
    await run(() => q(supabase.from('companies').update(row).eq('id', company.id)), 'Metas atualizadas')
    onSaved()
  }
  const pctInput = (k) => <input type="number" inputMode="decimal" value={f[k]} onChange={(e) => set(k)(e.target.value)} disabled={!canEdit} />
  return (
    <div className="card stack">
      <h2>Metas e alertas</h2>
      <p className="small muted" style={{ margin: 0 }}>Usados no cálculo do lance máximo, nos preços recomendados e nos alertas.</p>
      <div className="form-grid">
        <Field label="Lucro mínimo por carro"><MoneyInput value={f.default_min_profit} onChange={set('default_min_profit')} disabled={!canEdit} /></Field>
        <Field label="Margem mínima (%)">{pctInput('default_min_margin_pct')}</Field>
        <Field label="Reserva de imprevistos (% de peças + mão de obra)">{pctInput('default_contingency_pct')}</Field>
        <Field label="Alerta de estouro do orçamento (%)">{pctInput('budget_alert_pct')}</Field>
        <Field label="Alerta de carro parado (dias)">{pctInput('stale_vehicle_days')}</Field>
        <Field label="Aviso de conta a vencer (dias antes)">{pctInput('payable_alert_days')}</Field>
      </div>
      {canEdit && <div><button className="btn-primary" onClick={save} disabled={busy}>Salvar metas</button></div>}
    </div>
  )
}

function Sources({ canEdit }) {
  const { data, error, loading, reload } = useLoad(() =>
    q(supabase.from('auction_sources').select('*, auction_fee_tiers(*)').order('name')))
  const [editing, setEditing] = useState(null)
  const [open, setOpen] = useState(null)
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  return (
    <div className="card pad-0">
      <div className="card-title" style={{ padding: '16px 16px 0' }}>
        <h2>Leilões</h2>
        {canEdit && <button className="btn-sm" onClick={() => setEditing({})}><Icon name="plus" /> Leilão</button>}
      </div>
      <div className="list">
        {data.map((s) => {
          const tiers = [...(s.auction_fee_tiers || [])].sort((a, b) => a.fee_type.localeCompare(b.fee_type) || a.min_amount - b.min_amount)
          return (
            <div key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="list-item" style={{ borderBottom: 0 }} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <div className="grow">
                  <b>{s.name}</b>
                  <div className="muted small">
                    Reboque {money(s.default_transport_cost)} · taxa fixa {money(s.flat_fees)} · incremento {money(s.bid_increment)} · {tiers.length} faixas de taxa
                  </div>
                </div>
                {canEdit && <button className="btn-sm" onClick={(e) => { e.stopPropagation(); setEditing(s) }}><Icon name="edit" /></button>}
              </div>
              {open === s.id && tiers.length > 0 && (
                <div className="table-wrap" style={{ padding: '0 16px 16px' }}>
                  <table className="small">
                    <thead><tr><th>Taxa</th><th className="num">Lance de</th><th className="num">até</th><th className="num">Valor</th></tr></thead>
                    <tbody>
                      {tiers.map((t) => (
                        <tr key={t.id}>
                          <td>{t.fee_type === 'buy_fee' ? 'Buy Fee' : t.fee_type === 'internet_fee' ? 'Internet' : t.fee_type}</td>
                          <td className="num">{money(t.min_amount)}</td>
                          <td className="num">{t.max_amount ? money(Number(t.max_amount) - 1) : 'acima'}</td>
                          <td className="num">{Number(t.percent_fee) > 0 ? `${Number(t.percent_fee)}%` : ''}{Number(t.percent_fee) > 0 && Number(t.fixed_fee) > 0 ? ' + ' : ''}{Number(t.fixed_fee) > 0 || Number(t.percent_fee) === 0 ? money(t.fixed_fee) : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })}
      </div>
      {editing && <SourceModal source={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload() }} />}
    </div>
  )
}

function SourceModal({ source, onClose, onDone }) {
  const [f, setF] = useState({
    name: source.name || '', website: source.website || '', default_transport_cost: source.default_transport_cost ?? '',
    flat_fees: source.flat_fees ?? '', flat_fees_description: source.flat_fees_description || '', bid_increment: source.bid_increment ?? 25,
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = {
      name: f.name, website: f.website || null, default_transport_cost: toNum(f.default_transport_cost) ?? 0,
      flat_fees: toNum(f.flat_fees) ?? 0, flat_fees_description: f.flat_fees_description || null, bid_increment: toNum(f.bid_increment) || 25,
    }
    await run(() => source.id ? q(supabase.from('auction_sources').update(row).eq('id', source.id)) : q(supabase.from('auction_sources').insert(row)), 'Leilão salvo')
    onDone()
  }
  return (
    <Modal title={source.id ? 'Editar leilão' : 'Novo leilão'} onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.name}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Nome *" span><input value={f.name} onChange={(e) => set('name')(e.target.value)} /></Field>
        <Field label="Reboque padrão por carro"><MoneyInput value={f.default_transport_cost} onChange={set('default_transport_cost')} /></Field>
        <Field label="Incremento de lance"><MoneyInput value={f.bid_increment} onChange={set('bid_increment')} /></Field>
        <Field label="Taxas fixas por carro"><MoneyInput value={f.flat_fees} onChange={set('flat_fees')} /></Field>
        <Field label="Quais taxas fixas"><input value={f.flat_fees_description} onChange={(e) => set('flat_fees_description')(e.target.value)} placeholder="Fuel Surcharge" /></Field>
        <Field label="Site" full><input value={f.website} onChange={(e) => set('website')(e.target.value)} /></Field>
      </div>
      <p className="small muted">A tabela de taxas por faixa de lance é cadastrada com a ajuda do Claude (mande o print da tabela do leilão).</p>
    </Modal>
  )
}
