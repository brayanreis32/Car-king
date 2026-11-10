import { useState } from 'react'
import { Link } from 'react-router-dom'
import { date, money, q, rpc, supabase, toNum, today } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Kpi, Modal, MoneyInput, Select, Spinner, Tabs, useAction, useLoad } from '../components/ui.jsx'

export default function Finance() {
  const [tab, setTab] = useState('pay')
  const { data, error, loading, reload } = useLoad(async () => {
    const [payables, receivables, accounts] = await Promise.all([
      q(supabase.from('accounts_payable').select('*, suppliers(name)').in('status', ['open', 'partial']).order('due_date', { nullsFirst: false })),
      q(supabase.from('accounts_receivable').select('*, customers(full_name)').in('status', ['open', 'partial']).order('due_date', { nullsFirst: false })),
      q(supabase.from('financial_account_balances').select('*').eq('is_active', true).order('name')),
    ])
    return { payables, receivables, accounts }
  })
  const [paying, setPaying] = useState(null)
  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { payables, receivables, accounts } = data
  const sum = (rows) => rows.reduce((s, r) => s + Number(r.balance), 0)
  const rows = tab === 'pay' ? payables : receivables

  return (
    <div className="stack">
      <div className="page-head"><div><h1>Financeiro</h1><div className="muted small">Contas a pagar e a receber</div></div></div>
      <div className="grid grid-3">
        <Kpi label="A pagar" value={money(sum(payables))} tone={sum(payables) > 0 ? 'warn' : ''} hint={`${payables.length} conta(s)`} />
        <Kpi label="A receber" value={money(sum(receivables))} hint={`${receivables.length} conta(s)`} />
        <Kpi label="Saldo nas contas" value={money(accounts.reduce((s, a) => s + Number(a.balance), 0))} hint={accounts.map((a) => `${a.name}: ${money(a.balance)}`).join(' · ') || 'nenhuma conta cadastrada'} />
      </div>
      <Tabs tabs={[['pay', `A pagar (${payables.length})`], ['receive', `A receber (${receivables.length})`]]} active={tab} onChange={setTab} />
      <div className="card pad-0">
        {rows.length === 0 ? <Empty title="Nada em aberto" /> : (
          <div className="list">
            {rows.map((r) => {
              const late = r.due_date && r.due_date < today()
              return (
                <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b>{r.description}</b>
                    <div className="muted small">
                      {(r.suppliers?.name || r.customers?.full_name) && `${r.suppliers?.name || r.customers?.full_name} · `}
                      vence {date(r.due_date)} {late && <Badge tone="error">vencida</Badge>}
                      {r.vehicle_id && <> · <Link to={`/veiculos/${r.vehicle_id}`}>ver carro</Link></>}
                    </div>
                  </div>
                  <div className="right num">
                    <b>{money(r.balance, true)}</b>
                    {Number(r.balance) !== Number(r.amount) && <div className="muted small">de {money(r.amount, true)}</div>}
                  </div>
                  <button className="btn-sm btn-primary" onClick={() => setPaying({ kind: tab, row: r })}>{tab === 'pay' ? 'Pagar' : 'Receber'}</button>
                </div>
              )
            })}
          </div>
        )}
      </div>
      {paying && <PayModal {...paying} accounts={accounts} onClose={() => setPaying(null)} onDone={() => { setPaying(null); reload() }} />}
    </div>
  )
}

function PayModal({ kind, row, accounts, onClose, onDone }) {
  const [f, setF] = useState({ account_id: accounts[0]?.account_id || '', new_account: accounts.length ? '' : 'Banco', amount: row.balance, date: today() })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const amount = toNum(f.amount)
  const save = async () => {
    await run(async () => {
      let accountId = f.account_id
      if (!accountId) {
        const a = await q(supabase.from('financial_accounts').insert({ name: f.new_account || 'Banco', account_type: 'bank' }).select('id').single())
        accountId = a.id
      }
      if (kind === 'pay') {
        await rpc('pay_payable', { p_payable_id: row.id, p_account_id: accountId, p_amount: amount, p_date: f.date })
      } else {
        await q(supabase.from('financial_transactions').insert({
          account_id: accountId, direction: 'in', amount, transaction_date: f.date, description: row.description,
          vehicle_id: row.vehicle_id, customer_id: row.customer_id, receivable_id: row.id,
        }))
      }
    }, kind === 'pay' ? 'Pagamento registrado' : 'Recebimento registrado')
    onDone()
  }
  return (
    <Modal title={kind === 'pay' ? 'Registrar pagamento' : 'Registrar recebimento'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !amount || amount > Number(row.balance)}>Confirmar {money(amount, true)}</button></>}>
      <div className="stack">
        <div className="muted">{row.description}</div>
        <div className="form-grid">
          <Field label="Valor"><MoneyInput value={f.amount} onChange={set('amount')} /></Field>
          <Field label="Data"><input type="date" value={f.date} onChange={(e) => set('date')(e.target.value)} /></Field>
          {accounts.length
            ? <Field label={kind === 'pay' ? 'Pago com a conta' : 'Recebido na conta'}><Select value={f.account_id} onChange={set('account_id')} options={accounts.map((a) => [a.account_id, a.name])} /></Field>
            : <Field label="Nome da conta (será criada)"><input value={f.new_account} onChange={(e) => set('new_account')(e.target.value)} placeholder="Ex.: Bank of America" /></Field>}
        </div>
        {amount > Number(row.balance) && <div className="alert-box warning">O valor passa do saldo em aberto ({money(row.balance, true)}).</div>}
      </div>
    </Modal>
  )
}
