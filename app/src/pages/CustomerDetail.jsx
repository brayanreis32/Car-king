import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { date, label, money, q, rpc, supabase, today, vehicleName, whatsappNumber } from '../lib.js'
import { Badge, Empty, ErrorBox, Icon, Kpi, Modal, Spinner, useAction, useLoad } from '../components/ui.jsx'
import { openAttachment, uploadAll } from '../components/attachments.jsx'
import { ReminderButton } from '../components/reminder.jsx'
import { useApp } from '../App.jsx'
import { CustomerModal, fmtPhone, receivableSummary, Status } from './Customers.jsx'

const FREQ = { weekly: 'semanais', biweekly: 'quinzenais', monthly: 'mensais' }

export default function CustomerDetail() {
  const { id } = useParams()
  const { can } = useApp()
  const [editing, setEditing] = useState(false)

  const { data, error, loading, reload } = useLoad(async () => {
    const [c, sales, recs, txs] = await Promise.all([
      q(supabase.from('customers').select('*').eq('id', id).single()),
      q(supabase.from('sales').select('*, vehicles(id, year, make, model, trim, vin, stock_number)').eq('customer_id', id).neq('status', 'cancelled').order('sale_date', { ascending: false })),
      q(supabase.from('accounts_receivable').select('*').eq('customer_id', id).neq('status', 'cancelled').order('due_date', { nullsFirst: false })),
      q(supabase.from('financial_transactions').select('id, transaction_date, amount, description, status, receivable_id, financial_accounts(name)').eq('customer_id', id).eq('direction', 'in').eq('status', 'confirmed').order('transaction_date', { ascending: false })),
    ])
    return { c, sales, recs, txs }
  }, [id])

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { c, sales, recs, txs } = data
  const fin = receivableSummary(recs)
  const seesFinance = can('finance', 'view')
  const fullAddress = [c.address, c.address2, [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ')
  const wa = whatsappNumber(c.phone)
  const licenseExpired = c.license_expires && c.license_expires < today()

  return (
    <div className="stack">
      <div>
        <Link to="/clientes" className="back"><Icon name="back" size={16} /> Clientes</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>{c.full_name}</h1>
            <div className="muted small">Cliente desde {date(c.created_at)}{sales.length ? ` · ${sales.length} carro(s) comprado(s)` : ''}</div>
          </div>
          <div className="row">
            {seesFinance && <Status fin={fin} hasCar={sales.length > 0} />}
            {can('customers', 'edit') && <button className="btn-sm" onClick={() => setEditing(true)}><Icon name="edit" /> Editar</button>}
            <DeleteCustomer customer={c} hasHistory={sales.length > 0 || recs.length > 0} />
          </div>
        </div>
      </div>

      {seesFinance && (recs.length > 0) && (
        <div className="grid grid-4">
          <Kpi label="Total das faturas" value={money(fin.total)} hint={`${recs.length} fatura(s)`} />
          <Kpi label="Já pagou" value={money(fin.received)} tone="pos" />
          <Kpi label="Falta pagar" value={money(fin.open)} tone={fin.open > 0 ? 'warn' : 'pos'} hint={fin.next ? `Próxima ${date(fin.next.due_date)} · ${money(fin.next.balance, true)}` : fin.open > 0 ? '' : 'quitado'} />
          <Kpi label="Em atraso" value={money(fin.late)} tone={fin.late > 0 ? 'neg' : 'pos'} hint={fin.lateCount ? `${fin.lateCount} fatura(s) vencida(s)` : 'nada vencido'} />
        </div>
      )}

      <div className="grid grid-2">
        <div className="card stack">
          <h2>Contato e endereço</h2>
          <div className="lines">
            <div><span className="muted">Telefone</span><span>{fmtPhone(c.phone) || '—'}</span></div>
            {c.phone_alt && <div><span className="muted">Outro telefone</span><span>{fmtPhone(c.phone_alt)}</span></div>}
            <div><span className="muted">E-mail</span><span style={{ wordBreak: 'break-all' }}>{c.email || '—'}</span></div>
            <div><span className="muted">Endereço</span><span style={{ textAlign: 'right' }}>{fullAddress || '—'}</span></div>
          </div>
          <div className="contact-actions">
            {c.phone && <a className="btn btn-sm" href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>Ligar</a>}
            {wa && <a className="btn btn-sm" href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer">WhatsApp</a>}
            {c.email && <a className="btn btn-sm" href={`mailto:${c.email}`}>E-mail</a>}
            {fullAddress && <a className="btn btn-sm" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullAddress)}`} target="_blank" rel="noreferrer">Ver no mapa</a>}
          </div>
        </div>

        <div className="card stack">
          <h2>Documento</h2>
          <div className="lines">
            <div><span className="muted">Driver license</span><span>{c.document_id || '—'}{c.license_state ? ` · ${c.license_state}` : ''}</span></div>
            <div><span className="muted">Validade</span><span>{c.license_expires ? <>{date(c.license_expires)} {licenseExpired && <Badge tone="error">vencida</Badge>}</> : '—'}</span></div>
            <div><span className="muted">Nascimento</span><span>{date(c.birth_date)}</span></div>
            {c.notes && <div><span className="muted">Obs.</span><span style={{ textAlign: 'right' }}>{c.notes}</span></div>}
          </div>
        </div>
      </div>

      <CustomerDocs customerId={c.id} />

      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}><h2>Carros comprados</h2></div>
        {sales.length === 0 ? <div style={{ padding: 16 }}><Empty title="Nenhuma compra ainda">A venda é registrada na aba “Vender” do veículo.</Empty></div> : (
          <div className="list">
            {sales.map((s) => {
              const parcelado = s.payment_method === 'installments'
              return (
                <Link key={s.id} to={`/veiculos/${s.vehicles?.id}?tab=sale`} className="list-item" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <b>{vehicleName(s.vehicles)}</b>
                    <div className="muted small">
                      {s.vehicles?.stock_number && `${s.vehicles.stock_number} · `}VIN {s.vehicles?.vin} · vendido em {date(s.sale_date)}
                    </div>
                    <div className="small">
                      {money(s.final_price)} · {parcelado
                        ? `entrada ${money(s.down_payment)} + ${s.installments} parcelas ${FREQ[s.installment_frequency] || ''} de ${money(s.installment_amount, true)}`
                        : label('payment_method', s.payment_method)}
                    </div>
                  </div>
                  <span className="muted" style={{ flexShrink: 0, display: "flex" }}><Icon name="chevron" size={18} /></span>
                </Link>
              )
            })}
          </div>
        )}
      </div>

      {seesFinance && recs.length > 0 && (
        <div className="card pad-0">
          <div className="card-title" style={{ padding: '16px 16px 0' }}>
            <h2>Faturas</h2>
            <Link to="/financeiro?tab=receive" className="btn btn-sm">Receber no Financeiro</Link>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Fatura</th><th>Vencimento</th><th className="num">Valor</th><th className="num">Pago</th><th className="num">Falta</th><th>Situação</th><th></th></tr></thead>
              <tbody>
                {recs.map((r) => {
                  const late = ['open', 'partial'].includes(r.status) && r.due_date && r.due_date < today()
                  const sale = sales.find((s) => s.id === r.sale_id)
                  return (
                    <tr key={r.id}>
                      <td>{r.description}{sale && <div className="muted small">{vehicleName(sale.vehicles)}</div>}</td>
                      <td>{date(r.due_date)}</td>
                      <td className="num">{money(r.amount, true)}</td>
                      <td className="num">{money(r.received_amount, true)}</td>
                      <td className="num">{Number(r.balance) > 0 ? money(r.balance, true) : '—'}</td>
                      <td><Badge tone={r.status === 'received' ? 'success' : late ? 'error' : r.status === 'partial' ? 'warning' : ''}>{r.status === 'received' ? 'Paga' : late ? 'Vencida' : r.status === 'partial' ? 'Parcial' : 'Em aberto'}</Badge></td>
                      <td>{(late || (r.due_date && r.due_date <= today())) && <ReminderButton receivable={r} customer={c.full_name} phone={c.phone} vehicle={sale ? vehicleName(sale.vehicles) : ''} />}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {seesFinance && txs.length > 0 && (
        <div className="card pad-0">
          <div className="card-title" style={{ padding: '16px 16px 0' }}><h2>Pagamentos recebidos</h2></div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Data</th><th>Descrição</th><th>Conta</th><th className="num">Valor</th></tr></thead>
              <tbody>
                {txs.map((t) => (
                  <tr key={t.id}>
                    <td>{date(t.transaction_date)}</td>
                    <td>{recs.find((r) => r.id === t.receivable_id)?.description || t.description}</td>
                    <td>{t.financial_accounts?.name || '—'}</td>
                    <td className="num pos"><b>{money(t.amount, true)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && <CustomerModal customer={c} onClose={() => setEditing(false)} onDone={() => { setEditing(false); reload() }} />}
    </div>
  )
}

// Fotos e PDFs dos documentos do cliente (driver license, comprovante de endereço, seguro...)
function CustomerDocs({ customerId }) {
  const { company, can } = useApp()
  const [run, busy] = useAction()
  const ref = useRef()
  const [urls, setUrls] = useState({})
  const { data, loading, reload } = useLoad(() =>
    q(supabase.from('attachments').select('*').eq('entity_type', 'customer').eq('entity_id', customerId).order('created_at')), [customerId])

  useEffect(() => {
    const imgs = (data || []).filter((a) => a.mime_type?.startsWith('image/') && a.mime_type !== 'image/heic')
    if (!imgs.length) return
    supabase.storage.from('documents').createSignedUrls(imgs.map((a) => a.path), 3600).then(({ data: signed }) => {
      if (signed) setUrls(Object.fromEntries(signed.filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl])))
    })
  }, [data])

  const upload = async (list) => {
    const files = Array.from(list || [])
    if (!files.length) return
    await run(() => uploadAll(files, { companyId: company.id, entityType: 'customer', entityId: customerId }), files.length > 1 ? 'Documentos anexados' : 'Documento anexado')
    ref.current.value = ''
    reload()
  }
  const remove = async (a, e) => {
    e.stopPropagation()
    if (!window.confirm(`Remover "${a.file_name}"?`)) return
    await run(async () => {
      await supabase.storage.from(a.bucket).remove([a.path])
      await q(supabase.from('attachments').delete().eq('id', a.id))
    }, 'Documento removido')
    reload()
  }

  return (
    <div className="card stack">
      <div className="row between">
        <div><h2>Fotos dos documentos</h2><div className="muted small">Driver license (frente e verso), comprovante de endereço, seguro, contrato assinado…</div></div>
        {can('customers', 'create') && (
          <label className="btn btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
            <Icon name="plus" /> {busy ? 'Enviando…' : 'Adicionar'}
            <input ref={ref} type="file" accept="application/pdf,image/*" multiple hidden disabled={busy} onChange={(e) => upload(e.target.files)} />
          </label>
        )}
      </div>
      {loading ? <div className="muted small">Carregando…</div> : !data.length ? (
        <div className="muted small">Nenhum documento anexado. Tire a foto pelo celular e clique em “Adicionar”.</div>
      ) : (
        <div className="doc-thumbs">
          {data.map((a) => (
            <button type="button" key={a.id} className="doc-thumb" onClick={() => openAttachment(a)} title={a.file_name}>
              {urls[a.path] ? <img src={urls[a.path]} alt={a.file_name || 'documento'} loading="lazy" /> : <span>{a.mime_type === 'application/pdf' ? 'PDF' : 'Arquivo'}</span>}
              <span className="doc-name">{a.file_name || 'documento'}</span>
              {can('customers', 'edit') && <span className="doc-del" role="button" aria-label="Remover" onClick={(e) => remove(a, e)}><Icon name="trash" size={14} /></span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function DeleteCustomer({ customer, hasHistory }) {
  const { can } = useApp()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [run, busy] = useAction()
  if (!can('customers', 'delete')) return null
  const go = async () => {
    const res = await run(() => rpc('delete_customer', { p_customer_id: customer.id }), 'Cliente excluído')
    const paths = (res?.files || []).map((f) => f.path)
    if (paths.length) await supabase.storage.from('documents').remove(paths).catch(() => null)
    nav('/clientes', { replace: true })
  }
  return (
    <>
      <button className="btn-sm btn-danger" onClick={() => setOpen(true)}><Icon name="trash" /> Excluir</button>
      {open && (
        <Modal title="Excluir cliente" onClose={() => setOpen(false)}
          footer={<><button onClick={() => setOpen(false)}>{hasHistory ? 'Fechar' : 'Cancelar'}</button>{!hasHistory && <button className="btn-danger" onClick={go} disabled={busy}>Excluir</button>}</>}>
          {hasHistory
            ? <div className="alert-box warning">{customer.full_name} tem carro comprado ou fatura registrada, por isso não pode ser excluído. Se foi um teste, exclua primeiro o veículo vendido a ele (botão Excluir no veículo) e depois volte aqui.</div>
            : <p style={{ margin: 0 }}><b>{customer.full_name}</b> e as fotos dos documentos dele serão apagados. Não tem como desfazer.</p>}
        </Modal>
      )}
    </>
  )
}
