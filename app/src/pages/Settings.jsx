import { useState } from 'react'
import { Link } from 'react-router-dom'
import { DEFAULT_REMINDER, date, money, q, reminderMessage, rpc, supabase, toNum } from '../lib.js'
import { ErrorBox, Field, Icon, Modal, MoneyInput, Spinner, useAction, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'

export default function Settings() {
  const { company, can, reloadCompany, profile } = useApp()
  return (
    <div className="stack">
      <div className="page-head"><div><h1>Configurações</h1><div className="muted small">{company.name} · {profile.roles?.name}</div></div></div>
      {can('employees', 'view') && (
        <Link to="/funcionarios" className="card row between" style={{ textDecoration: 'none' }}>
          <div><h2>Funcionários e logins</h2><div className="muted small">Criar acessos para administrador e vendedores</div></div>
          <span className="btn btn-sm">Abrir</span>
        </Link>
      )}
      <CompanyContract company={company} canEdit={can('settings', 'edit')} onSaved={reloadCompany} />
      <Goals company={company} canEdit={can('settings', 'edit')} onSaved={reloadCompany} />
      <ReminderTemplate company={company} canEdit={can('settings', 'edit')} onSaved={reloadCompany} />
      {can('settings', 'edit') && <InstagramFeed />}
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

function ReminderTemplate({ company, canEdit, onSaved }) {
  const [text, setText] = useState(company.reminder_template || DEFAULT_REMINDER)
  const [run, busy] = useAction()
  const preview = reminderMessage(text, {
    customer: 'John Smith', vehicle: '2021 Toyota Camry', company: company.name,
    receivable: { description: 'Parcela 3/12', installment_number: 3, balance: 888.49, due_date: '2026-12-10' },
  })
  const save = async () => {
    await run(() => q(supabase.from('companies').update({ reminder_template: text }).eq('id', company.id)), 'Mensagem salva')
    onSaved()
  }
  return (
    <div className="card stack">
      <h2>Mensagem de cobrança (WhatsApp)</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Usada no botão “WhatsApp” das parcelas em aberto. Variáveis: {'{cliente} {carro} {parcela} {valor} {vencimento} {dias_atraso} {empresa}'}
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={!canEdit} rows={4} />
      <div className="alert-box info small"><b>Prévia:</b> {preview}</div>
      {canEdit && (
        <div className="row">
          <button className="btn-primary" onClick={save} disabled={busy}>Salvar mensagem</button>
          <button className="btn-ghost btn-sm" onClick={() => setText(DEFAULT_REMINDER)}>Restaurar padrão (inglês)</button>
        </div>
      )}
    </div>
  )
}

// Dados da empresa que aparecem no contrato de venda + multa por atraso
function CompanyContract({ company, canEdit, onSaved }) {
  const keys = ['legal_name', 'dealer_license', 'finance_license', 'phone', 'email', 'address', 'city', 'state', 'zip', 'late_fee_pct', 'late_fee_grace_days', 'contract_terms']
  const [f, setF] = useState(() => Object.fromEntries(keys.map((k) => [k, company[k] ?? ''])))
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = Object.fromEntries(keys.map((k) => [k, typeof f[k] === 'string' ? (f[k].trim() || null) : f[k]]))
    row.late_fee_pct = toNum(f.late_fee_pct) ?? 5
    row.late_fee_grace_days = toNum(f.late_fee_grace_days) ?? 15
    if (row.state) row.state = row.state.toUpperCase()
    await run(() => q(supabase.from('companies').update(row).eq('id', company.id)), 'Dados do contrato salvos')
    onSaved()
  }
  const inp = (k, props = {}) => <input value={f[k]} onChange={set(k)} disabled={!canEdit} {...props} />
  return (
    <div className="card stack">
      <h2>Dados da empresa para contratos</h2>
      <p className="small muted" style={{ margin: 0 }}>Aparecem no cabeçalho do contrato de venda (à vista e parcelada).</p>
      <div className="form-grid">
        <Field label="Razão social (nome legal)" span>{inp('legal_name', { placeholder: company.name })}</Field>
        <Field label="Licença de dealer (Class 2) nº">{inp('dealer_license')}</Field>
        <Field label="Licença de financiamento (Division of Banks) nº">{inp('finance_license', { placeholder: 'para venda parcelada própria' })}</Field>
        <Field label="Telefone">{inp('phone', { type: 'tel' })}</Field>
        <Field label="E-mail">{inp('email', { type: 'email' })}</Field>
        <Field label="Endereço" span>{inp('address')}</Field>
        <Field label="Cidade">{inp('city')}</Field>
        <Field label="Estado">{inp('state', { maxLength: 2, placeholder: 'MA' })}</Field>
        <Field label="ZIP">{inp('zip', { inputMode: 'numeric' })}</Field>
      </div>
      <h3 style={{ margin: '6px 0 0' }}>Venda parcelada: multa por atraso</h3>
      <div className="form-grid">
        <Field label="Multa (% da parcela em atraso)">{inp('late_fee_pct', { type: 'number', inputMode: 'decimal', step: '0.5' })}</Field>
        <Field label="Cobrar depois de quantos dias de atraso">{inp('late_fee_grace_days', { type: 'number', inputMode: 'numeric' })}</Field>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Em Massachusetts a multa só pode ser cobrada depois de 15 dias de atraso e até 5% da parcela (G.L. c. 255B §11).</p>
      <Field label="Cláusulas extras do contrato (opcional, em inglês)">
        <textarea rows={3} value={f.contract_terms} onChange={set('contract_terms')} disabled={!canEdit} placeholder="Ex.: Vehicle sold with 30-day / 1,000-mile limited powertrain warranty." />
      </Field>
      {canEdit && <div><button className="btn-primary" onClick={save} disabled={busy}>Salvar dados do contrato</button></div>}
    </div>
  )
}

// Instagram no site: o administrador cola a chave de acesso gerada no Meta for Developers
function InstagramFeed() {
  const { data, loading, reload } = useLoad(() => rpc('instagram_status'))
  const [token, setToken] = useState('')
  const [run, busy] = useAction()
  const refresh = async () => {
    const { data: r, error } = await supabase.functions.invoke('instagram-feed', { body: { refresh: true } })
    if (error) throw new Error('O serviço "instagram-feed" ainda não foi instalado no Supabase.')
    return r
  }
  const connect = async () => {
    await run(async () => {
      await rpc('set_instagram_token', { p_token: token.trim() })
      const r = await refresh()
      if (!r?.username) throw new Error('A chave foi salva, mas o Instagram não aceitou. Confira se copiou a chave inteira e se a conta é profissional.')
    }, 'Instagram conectado')
    setToken(''); reload()
  }
  const disconnect = async () => {
    if (!window.confirm('Desconectar o Instagram? Os posts somem do site.')) return
    await run(() => rpc('set_instagram_token', { p_token: null }), 'Instagram desconectado')
    reload()
  }
  const s = data || {}
  return (
    <div className="card stack">
      <h2>Instagram no site</h2>
      <p className="small muted" style={{ margin: 0 }}>
        Os últimos posts do Instagram da loja (fotos e vídeos de clientes recebendo os carros) aparecem sozinhos na página inicial do site.
        O site atualiza no máximo uma vez por hora.
      </p>
      {loading ? <Spinner /> : s.connected ? (
        <>
          <div className="alert-box success small">
            Conectado{s.username ? <> como <b>@{s.username}</b></> : ''} · {s.posts || 0} post(s) no site{s.cached_at ? ` · atualizado em ${date(s.cached_at)}` : ''}
            {s.last_error && <div style={{ marginTop: 4 }}>Último erro do Instagram: {s.last_error}</div>}
          </div>
          <div className="row">
            <button onClick={() => run(refresh, 'Posts atualizados').then(reload).catch(() => {})} disabled={busy}>Atualizar agora</button>
            <button className="btn-ghost btn-sm" onClick={disconnect} disabled={busy}>Desconectar</button>
          </div>
        </>
      ) : (
        <>
          <ol className="small" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.6 }}>
            <li>A conta do Instagram precisa ser <b>profissional</b> (Empresa ou Criador de conteúdo).</li>
            <li>Em <b>developers.facebook.com</b>, crie um app, adicione o produto <b>Instagram</b> e abra <b>“API setup with Instagram login”</b>.</li>
            <li>Em <b>“Generate access tokens”</b>, adicione a conta @carkingautosales e clique em <b>Generate token</b>.</li>
            <li>Copie a chave e cole aqui embaixo. Ela fica guardada em segurança e se renova sozinha.</li>
          </ol>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Cole a chave de acesso (access token)" autoComplete="off" />
            <button className="btn-primary" onClick={connect} disabled={busy || token.trim().length < 40}>{busy ? 'Conectando…' : 'Conectar'}</button>
          </div>
        </>
      )}
    </div>
  )
}
