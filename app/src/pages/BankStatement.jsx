// Extrato bancário: importar CSV/OFX baixado do banco e conciliar com as contas do sistema
import { useMemo, useRef, useState } from 'react'
import { date, money, q, rpc, supabase, toNum, today, vehicleName } from '../lib.js'
import { Badge, Empty, Field, Icon, Modal, MoneyInput, Select, Spinner, Tabs, useAction, useLoad, useToast } from '../components/ui.jsx'
import { parseStatement, parseWithMapping } from '../bankStatement.js'
import { useApp } from '../App.jsx'

const MODULE_GROUPS = ['purchase', 'auction_fees', 'transport', 'parts', 'labor']

export default function BankStatement({ accounts, payables, receivables, onChange }) {
  const { can } = useApp()
  const toast = useToast()
  const bankAccounts = accounts.filter((a) => a.account_type !== 'cash')
  const [accountId, setAccountId] = useState(bankAccounts[0]?.account_id || accounts[0]?.account_id || '')
  const [view, setView] = useState('pending')
  const [creatingAccount, setCreatingAccount] = useState(accounts.length === 0)
  const [editingAccount, setEditingAccount] = useState(null)
  const [parsed, setParsed] = useState(null)
  const [mapping, setMapping] = useState(null)
  const [resolving, setResolving] = useState(null)
  const [run, busy] = useAction()
  const fileRef = useRef()

  const lines = useLoad(async () => {
    if (!accountId) return []
    if (view === 'pending') return q(supabase.from('bank_line_suggestions').select('*').eq('account_id', accountId).eq('status', 'pending').order('posted_date'))
    return q(supabase.from('bank_statement_lines').select('*').eq('account_id', accountId).eq('status', view).order('posted_date', { ascending: false }).limit(200))
  }, [accountId, view])
  const counts = useLoad(async () => {
    if (!accountId) return {}
    const rows = await q(supabase.from('bank_statement_lines').select('status').eq('account_id', accountId))
    return rows.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] || 0) + 1 }), {})
  }, [accountId, lines.data])

  const refresh = () => { lines.reload(); onChange() }
  const account = accounts.find((a) => a.account_id === accountId)

  const onFile = async (file) => {
    fileRef.current.value = ''
    if (!file) return
    const text = await file.text()
    const r = parseStatement(text, file.name)
    if (r.needsMapping) { setMapping({ ...r, text, fileName: file.name }); return }
    if (!r.rows.length) { toast('Não encontrei lançamentos neste arquivo. Baixe o extrato em CSV ou OFX.', 'error'); return }
    setParsed({ rows: r.rows, fileName: file.name, format: r.format })
  }

  const confirmAll = async () => {
    const withMatch = (lines.data || []).filter((l) => l.match_id)
    let ok = 0
    for (const l of withMatch) {
      try {
        await rpc(l.match_kind === 'payable' ? 'bank_match_payable' : 'bank_match_receivable',
          l.match_kind === 'payable' ? { p_line_id: l.line_id, p_payable_id: l.match_id } : { p_line_id: l.line_id, p_receivable_id: l.match_id })
        ok++
      } catch (e) { toast(`${l.description}: ${e.message}`, 'error') }
    }
    if (ok) toast(`${ok} lançamento(s) conciliado(s)`)
    refresh()
  }

  const ignore = async (l) => {
    await run(() => q(supabase.from('bank_statement_lines').update({ status: 'ignored' }).eq('id', l.line_id || l.id)), 'Lançamento ignorado')
    refresh()
  }
  const unignore = async (l) => {
    await run(() => q(supabase.from('bank_statement_lines').update({ status: 'pending' }).eq('id', l.id)), 'Voltou para pendentes')
    refresh()
  }

  const suggestions = (lines.data || []).filter((l) => l.match_id).length
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <div>
            <h2>Extrato bancário</h2>
            <div className="muted small">Baixe o extrato no site do banco (CSV ou OFX/QFX) e importe aqui. O sistema encontra as contas que batem.</div>
          </div>
          <div className="row">
            {can('finance', 'create') && <button onClick={() => setCreatingAccount(true)}><Icon name="plus" /> Conta bancária</button>}
            {accountId && can('finance', 'create') && (
              <label className="btn btn-primary" style={{ cursor: 'pointer' }}>
                Importar extrato
                <input ref={fileRef} type="file" accept=".csv,.ofx,.qfx,.qbo,.txt,text/csv" hidden onChange={(e) => onFile(e.target.files[0])} />
              </label>
            )}
          </div>
        </div>
        {accounts.length > 0 && (
          <div className="form-grid">
            <Field label="Conta">
              <Select value={accountId} onChange={setAccountId} options={accounts.map((a) => [a.account_id, a.name])} />
            </Field>
            <Field label="Saldo no sistema">
              <div className="row" style={{ flexWrap: 'nowrap', paddingTop: 2 }}>
                <span style={{ fontSize: 20, fontWeight: 600 }} className={`num ${Number(account?.balance) < 0 ? 'neg' : ''}`}>{money(account?.balance, true)}</span>
                {can('finance', 'edit') && account && <button className="btn-sm" onClick={() => setEditingAccount(account)}>Editar conta</button>}
              </div>
            </Field>
          </div>
        )}
      </div>

      {accountId && <>
        <Tabs active={view} onChange={setView} tabs={[
          ['pending', `Pendentes (${counts.data?.pending || 0})`], ['matched', `Conciliados (${counts.data?.matched || 0})`], ['ignored', `Ignorados (${counts.data?.ignored || 0})`],
        ]} />
        {view === 'pending' && suggestions > 0 && (
          <div className="alert-box success row between">
            <span>{suggestions} lançamento(s) batem com contas em aberto.</span>
            <button className="btn-sm btn-primary" onClick={confirmAll}>Confirmar todas as sugestões</button>
          </div>
        )}
        <div className="card pad-0">
          {lines.loading && !lines.data ? <Spinner /> : (lines.data || []).length === 0 ? (
            <Empty title={view === 'pending' ? 'Nenhum lançamento pendente' : 'Nada aqui'}>{view === 'pending' ? 'Importe o extrato do banco para conciliar.' : ''}</Empty>
          ) : (
            <div className="list">
              {lines.data.map((l) => (
                <div key={l.line_id || l.id} className="list-item" style={{ cursor: 'default', flexWrap: 'wrap' }}>
                  <div className="grow" style={{ minWidth: 200 }}>
                    <b>{l.description}</b>
                    <div className="muted small">{date(l.posted_date)}</div>
                    {view === 'pending' && l.match_id && (
                      <div className="small" style={{ marginTop: 4 }}>
                        <Badge tone="success">Bate com</Badge> {l.match_description}{l.match_due_date ? ` · vence ${date(l.match_due_date)}` : ''}
                      </div>
                    )}
                  </div>
                  <div className={`num ${Number(l.amount) < 0 ? 'neg' : 'pos'}`} style={{ fontWeight: 600, minWidth: 100, textAlign: 'right' }}>{money(l.amount, true)}</div>
                  {view === 'pending' && (
                    <div className="row" style={{ gap: 6 }}>
                      {l.match_id && (
                        <button className="btn-sm btn-primary" disabled={busy} onClick={async () => {
                          await run(() => rpc(l.match_kind === 'payable' ? 'bank_match_payable' : 'bank_match_receivable',
                            l.match_kind === 'payable' ? { p_line_id: l.line_id, p_payable_id: l.match_id } : { p_line_id: l.line_id, p_receivable_id: l.match_id }), 'Conciliado')
                          refresh()
                        }}>Confirmar</button>
                      )}
                      <button className="btn-sm" onClick={() => setResolving(l)}>{l.match_id ? 'Outra opção' : 'Resolver'}</button>
                      <button className="btn-sm btn-ghost" onClick={() => ignore(l)}>Ignorar</button>
                    </div>
                  )}
                  {view === 'ignored' && <button className="btn-sm" onClick={() => unignore(l)}>Voltar para pendentes</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </>}

      {creatingAccount && <AccountModal onClose={() => setCreatingAccount(false)} onDone={(id) => { setCreatingAccount(false); setAccountId(id); onChange() }} />}
      {editingAccount && <AccountModal account={editingAccount} onClose={() => setEditingAccount(null)} onDone={() => { setEditingAccount(null); onChange() }} />}
      {mapping && <MappingModal info={mapping} onClose={() => setMapping(null)} onDone={(rows) => { setMapping(null); setParsed({ rows, fileName: mapping.fileName, format: 'CSV' }) }} />}
      {parsed && <ImportPreview parsed={parsed} account={account} onClose={() => setParsed(null)} onDone={() => { setParsed(null); setView('pending'); refresh() }} />}
      {resolving && <ResolveModal line={resolving} payables={payables} receivables={receivables} onClose={() => setResolving(null)} onDone={() => { setResolving(null); refresh() }} />}
    </div>
  )
}

export function AccountModal({ account, onClose, onDone }) {
  const editing = Boolean(account)
  const full = useLoad(() => (editing ? q(supabase.from('financial_accounts').select('*').eq('id', account.account_id).single()) : Promise.resolve(null)), [account?.account_id])
  const [f, setF] = useState({ name: '', institution: '', last4: '', opening_balance: '', opening_date: today() })
  const [loaded, setLoaded] = useState(!editing)
  if (editing && !loaded && full.data) {
    setF({ name: full.data.name, institution: full.data.institution || '', last4: full.data.last4 || '', opening_balance: full.data.opening_balance, opening_date: full.data.opening_date })
    setLoaded(true)
  }
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    const row = { name: f.name, institution: f.institution || null, last4: f.last4 || null, opening_balance: toNum(f.opening_balance) ?? 0, opening_date: f.opening_date }
    const r = await run(() => editing
      ? q(supabase.from('financial_accounts').update(row).eq('id', account.account_id).select('id').single())
      : q(supabase.from('financial_accounts').insert({ ...row, account_type: 'bank' }).select('id').single()), editing ? 'Conta atualizada' : 'Conta cadastrada')
    onDone(r.id)
  }
  return (
    <Modal title={editing ? 'Editar conta' : 'Nova conta bancária'} onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.name || (f.last4 && !/^\d{4}$/.test(f.last4))}>Salvar</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Nome *"><input value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="Bank of America - Operating" /></Field>
          <Field label="Banco"><input value={f.institution} onChange={(e) => set('institution')(e.target.value)} /></Field>
          <Field label="Últimos 4 dígitos"><input inputMode="numeric" maxLength={4} value={f.last4} onChange={(e) => set('last4')(e.target.value.replace(/\D/g, ''))} /></Field>
          <Field label="Saldo inicial"><MoneyInput value={f.opening_balance} onChange={set('opening_balance')} /></Field>
          <Field label="Na data"><input type="date" value={f.opening_date} onChange={(e) => set('opening_date')(e.target.value)} /></Field>
        </div>
        <p className="small muted" style={{ margin: 0 }}>Use o saldo do banco no dia anterior ao primeiro extrato que você vai importar. Assim o saldo do sistema bate com o do banco.</p>
      </div>
    </Modal>
  )
}

function MappingModal({ info, onClose, onDone }) {
  const [m, setM] = useState({ date: '', desc: '', amount: '', debit: '', credit: '' })
  const set = (k) => (v) => setM((s) => ({ ...s, [k]: v }))
  const opts = info.headers.map((h, i) => [String(i), h])
  const result = useMemo(() => {
    if (m.date === '' || (m.amount === '' && m.debit === '' && m.credit === '')) return null
    const toI = (v) => (v === '' ? -1 : Number(v))
    return parseWithMapping(info.text, { date: toI(m.date), desc: toI(m.desc), amount: toI(m.amount), debit: toI(m.debit), credit: toI(m.credit) }).rows
  }, [m, info.text])
  return (
    <Modal title="Quais são as colunas do extrato?" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" disabled={!result?.length} onClick={() => onDone(result)}>Continuar ({result?.length || 0})</button></>}>
      <div className="stack">
        <p className="small muted" style={{ margin: 0 }}>Não reconheci o formato deste arquivo. Indique as colunas uma vez:</p>
        <div className="form-grid">
          <Field label="Data *"><Select value={m.date} onChange={set('date')} placeholder="—" options={opts} /></Field>
          <Field label="Descrição"><Select value={m.desc} onChange={set('desc')} placeholder="—" options={opts} /></Field>
          <Field label="Valor (+ entrada / − saída)"><Select value={m.amount} onChange={set('amount')} placeholder="—" options={opts} /></Field>
          <Field label="ou Débito (saídas)"><Select value={m.debit} onChange={set('debit')} placeholder="—" options={opts} /></Field>
          <Field label="e Crédito (entradas)"><Select value={m.credit} onChange={set('credit')} placeholder="—" options={opts} /></Field>
        </div>
        {result && result.slice(0, 3).map((r, i) => <div key={i} className="small row between"><span>{date(r.date)} · {r.description}</span><b className={r.amount < 0 ? 'neg' : 'pos'}>{money(r.amount, true)}</b></div>)}
      </div>
    </Modal>
  )
}

function ImportPreview({ parsed, account, onClose, onDone }) {
  const [run, busy] = useAction()
  const toast = useToast()
  const rows = parsed.rows
  const ins = rows.filter((r) => r.amount > 0).reduce((s, r) => s + r.amount, 0)
  const outs = rows.filter((r) => r.amount < 0).reduce((s, r) => s + r.amount, 0)
  const dates = rows.map((r) => r.date).sort()
  const save = async () => {
    const res = await run(() => q(supabase.from('bank_statement_lines').upsert(rows.map((r) => ({
      account_id: account.account_id, posted_date: r.date, amount: r.amount, description: r.description.slice(0, 300),
      reference: r.reference, import_file: parsed.fileName,
    })), { onConflict: 'account_id,reference', ignoreDuplicates: true }).select('id')))
    const added = res?.length ?? 0
    toast(added === rows.length ? `${added} lançamento(s) importado(s)` : `${added} novo(s) · ${rows.length - added} já tinham sido importados`)
    onDone()
  }
  return (
    <Modal title="Importar extrato" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Importando…' : `Importar ${rows.length} lançamento(s)`}</button></>}>
      <div className="stack">
        <div className="lines small num">
          <div><span>Arquivo</span><span>{parsed.fileName} ({parsed.format})</span></div>
          <div><span>Conta</span><span>{account?.name}</span></div>
          <div><span>Período</span><span>{date(dates[0])} a {date(dates[dates.length - 1])}</span></div>
          <div><span>Entradas</span><span className="pos">{money(ins, true)}</span></div>
          <div><span>Saídas</span><span className="neg">{money(outs, true)}</span></div>
        </div>
        <div className="small muted">Lançamentos que já foram importados antes são ignorados automaticamente.</div>
        <div className="stack" style={{ gap: 4, maxHeight: 220, overflowY: 'auto' }}>
          {rows.slice(0, 50).map((r, i) => (
            <div key={i} className="small row between" style={{ flexWrap: 'nowrap' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{date(r.date)} · {r.description}</span>
              <b className={r.amount < 0 ? 'neg' : 'pos'}>{money(r.amount, true)}</b>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

function ResolveModal({ line, payables, receivables, onClose, onDone }) {
  const out = Number(line.amount) < 0
  const value = Math.abs(Number(line.amount))
  const [mode, setMode] = useState(out ? 'expense' : 'income')
  const [target, setTarget] = useState('')
  const [f, setF] = useState({ category_id: '', description: line.description, vehicle_id: '' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const extra = useLoad(async () => {
    const [cats, vehicles] = await Promise.all([
      q(supabase.from('expense_categories').select('id, name, cost_group').eq('is_active', true).order('name')),
      q(supabase.from('vehicles').select('id, year, make, model, stock_number, status').neq('status', 'sold').order('created_at', { ascending: false })),
    ])
    return { cats: cats.filter((c) => !MODULE_GROUPS.includes(c.cost_group)), vehicles }
  })
  const candidates = (out ? payables : receivables).filter((r) => Number(r.balance) >= value - 0.001)
  const save = async () => {
    const lineId = line.line_id || line.id
    await run(async () => {
      if (mode === 'match') {
        await rpc(out ? 'bank_match_payable' : 'bank_match_receivable', out ? { p_line_id: lineId, p_payable_id: target } : { p_line_id: lineId, p_receivable_id: target })
      } else if (mode === 'expense') {
        await rpc('bank_create_expense', { p_line_id: lineId, p_category_id: f.category_id, p_description: f.description, p_vehicle_id: f.vehicle_id || null })
      } else {
        await rpc('bank_record_income', { p_line_id: lineId, p_description: f.description })
      }
    }, 'Lançamento conciliado')
    onDone()
  }
  const ok = mode === 'match' ? Boolean(target) : mode === 'expense' ? Boolean(f.category_id) : true
  return (
    <Modal title={`${out ? 'Saída' : 'Entrada'} de ${money(value, true)}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !ok}>Confirmar</button></>}>
      <div className="stack">
        <div className="muted small">{date(line.posted_date)} · {line.description}</div>
        <div className="row">
          <button className={`btn-sm ${mode === 'match' ? 'btn-primary' : ''}`} onClick={() => setMode('match')}>{out ? 'Pagar uma conta em aberto' : 'Receber uma conta em aberto'}</button>
          <button className={`btn-sm ${mode !== 'match' ? 'btn-primary' : ''}`} onClick={() => setMode(out ? 'expense' : 'income')}>{out ? 'Lançar como despesa' : 'Registrar entrada avulsa'}</button>
        </div>
        {mode === 'match' && (candidates.length === 0
          ? <div className="alert-box warning">Nenhuma conta em aberto com saldo de pelo menos {money(value, true)}.</div>
          : <Field label="Conta"><Select value={target} onChange={setTarget} placeholder="Escolha…" options={candidates.map((r) => [r.id, `${r.description} · saldo ${money(r.balance, true)}`])} /></Field>)}
        {mode === 'expense' && (
          <div className="form-grid">
            <Field label="Categoria *"><Select value={f.category_id} onChange={set('category_id')} placeholder="Escolha…" options={(extra.data?.cats || []).map((c) => [c.id, c.name])} /></Field>
            <Field label="Veículo (se for de um carro)"><Select value={f.vehicle_id} onChange={set('vehicle_id')} placeholder="Despesa geral da empresa" options={(extra.data?.vehicles || []).map((v) => [v.id, `${vehicleName(v)}${v.stock_number ? ` · ${v.stock_number}` : ''}`])} /></Field>
            <Field label="Descrição" full><input value={f.description} onChange={(e) => set('description')(e.target.value)} /></Field>
          </div>
        )}
        {mode === 'income' && <Field label="Descrição"><input value={f.description} onChange={(e) => set('description')(e.target.value)} placeholder="Ex.: aporte do sócio" /></Field>}
        {mode === 'expense' && <p className="small muted" style={{ margin: 0 }}>Peças, mão de obra e reboque devem ser lançados nas abas do veículo. Aqui é para taxas, combustível, aluguel, tarifas etc.</p>}
      </div>
    </Modal>
  )
}
