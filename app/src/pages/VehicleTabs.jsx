import { useState } from 'react'
import { Link } from 'react-router-dom'
import { date, label, money, options, PART_STATUS_TONE, q, rpc, supabase, toNum, today, vehicleName } from '../lib.js'
import { Badge, Empty, ErrorBox, Field, Icon, Kpi, Modal, MoneyInput, Select, Spinner, useAction, useLoad } from '../components/ui.jsx'
import { useApp } from '../App.jsx'
import { ReminderButton } from '../components/reminder.jsx'
import { Attachments, AttachmentRow, AttachmentsButton, FilePick, uploadAll, useAttachmentCounts } from '../components/attachments.jsx'

// Fornecedores com opção de cadastrar na hora
function SupplierSelect({ value, onChange, type = 'other' }) {
  const list = useLoad(() => q(supabase.from('suppliers').select('id, name').eq('is_active', true).order('name')))
  const pick = async (val) => {
    if (val !== '__new') { onChange(val); return }
    const name = window.prompt('Nome do fornecedor / oficina / reboque:')
    if (!name?.trim()) return
    try {
      const s = await q(supabase.from('suppliers').insert({ name: name.trim(), supplier_type: type }).select('id').single())
      list.reload(); onChange(s.id)
    } catch (e) { alert(e.message) }
  }
  return (
    <Select value={value} onChange={pick} placeholder="—"
      options={[...(list.data || []).map((s) => [s.id, s.name]), ['__new', '+ Cadastrar novo']]} />
  )
}

// =============================================================================
// Reboque / transporte
// =============================================================================
const TRANSPORT_STATUS = ['quoted', 'booked', 'picked_up', 'in_transit', 'delivered', 'cancelled']

export function Transport({ vehicle, onChange }) {
  const { data, error, loading, reload } = useLoad(() => q(supabase.from('transport_orders').select('*, suppliers(name)').eq('vehicle_id', vehicle.id).order('created_at')), [vehicle.id])
  const [editing, setEditing] = useState(null)
  const sold = vehicle.status === 'sold'
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  return (
    <div className="stack">
      {data.length === 0 && <div className="card"><Empty title="Nenhum reboque registrado" /></div>}
      {data.map((t) => (
        <div key={t.id} className="card">
          <div className="row between">
            <div>
              <b>{t.suppliers?.name || t.carrier_name || 'Reboque'}</b> <Badge tone={t.status === 'delivered' ? 'success' : t.status === 'cancelled' ? '' : 'info'}>{label('transport_status', t.status)}</Badge>
              <div className="muted small">{t.pickup_address || 'origem não informada'} → {t.destination_address || 'empresa'}</div>
            </div>
            {!sold && <button className="btn-sm" onClick={() => setEditing(t)}><Icon name="edit" /> Atualizar</button>}
          </div>
          <div className="lines num small" style={{ marginTop: 10 }}>
            <div><span>Previsto</span><span>{money(t.estimated_cost)}</span></div>
            <div><span>Pago</span><b className={t.actual_cost === null ? 'muted' : Number(t.actual_cost) > Number(t.estimated_cost) ? 'neg' : 'pos'}>{t.actual_cost === null ? 'ainda não informado' : money(t.actual_cost)}</b></div>
            <div><span>Coleta / entrega</span><span>{date(t.pickup_date)} → {date(t.delivered_at || t.expected_delivery_date)}</span></div>
          </div>
        </div>
      ))}
      {!sold && <button onClick={() => setEditing({})}><Icon name="plus" /> Adicionar reboque/transporte</button>}
      {editing && <TransportModal vehicle={vehicle} t={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); reload(); onChange() }} />}
    </div>
  )
}

function TransportModal({ vehicle, t, onClose, onDone }) {
  const [f, setF] = useState({
    supplier_id: t.supplier_id || '', carrier_name: t.carrier_name || '', contact_phone: t.contact_phone || '',
    pickup_address: t.pickup_address || '', destination_address: t.destination_address || '',
    pickup_date: t.pickup_date || '', expected_delivery_date: t.expected_delivery_date || '',
    estimated_cost: t.estimated_cost ?? '', actual_cost: t.actual_cost ?? '', status: t.status || 'booked', notes: t.notes || '',
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const { company } = useApp()
  const [files, setFiles] = useState([])
  const markDelivered = () => setF((s) => ({ ...s, status: 'delivered', actual_cost: s.actual_cost === '' ? s.estimated_cost : s.actual_cost }))
  const save = async () => {
    const row = {
      vehicle_id: vehicle.id, supplier_id: f.supplier_id || null, carrier_name: f.carrier_name || null, contact_phone: f.contact_phone || null,
      pickup_address: f.pickup_address || null, destination_address: f.destination_address || null,
      pickup_date: f.pickup_date || null, expected_delivery_date: f.expected_delivery_date || null,
      estimated_cost: toNum(f.estimated_cost) ?? 0, actual_cost: toNum(f.actual_cost), status: f.status, notes: f.notes || null,
    }
    await run(async () => {
      const saved = t.id
        ? await q(supabase.from('transport_orders').update(row).eq('id', t.id).select('id').single())
        : await q(supabase.from('transport_orders').insert(row).select('id').single())
      await uploadAll(files, { companyId: company.id, entityType: 'transport_order', entityId: saved.id, vehicleId: vehicle.id })
    }, 'Reboque salvo')
    onDone()
  }
  return (
    <Modal title="Reboque / transporte" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="stack">
        {f.status !== 'delivered' && <button className="btn-sm" onClick={markDelivered}>Carro chegou: marcar como entregue</button>}
        <div className="form-grid">
          <Field label="Empresa de reboque"><SupplierSelect value={f.supplier_id} onChange={set('supplier_id')} type="transport" /></Field>
          <Field label="Status"><Select value={f.status} onChange={set('status')} options={TRANSPORT_STATUS.map((s) => [s, label('transport_status', s)])} /></Field>
          <Field label="Valor previsto"><MoneyInput value={f.estimated_cost} onChange={set('estimated_cost')} /></Field>
          <Field label="Valor pago"><MoneyInput value={f.actual_cost} onChange={set('actual_cost')} placeholder="quando pagar" /></Field>
          <Field label="Retirada em" span><input value={f.pickup_address} onChange={(e) => set('pickup_address')(e.target.value)} /></Field>
          <Field label="Destino" span><input value={f.destination_address} onChange={(e) => set('destination_address')(e.target.value)} /></Field>
          <Field label="Data da coleta"><input type="date" value={f.pickup_date} onChange={(e) => set('pickup_date')(e.target.value)} /></Field>
          <Field label="Previsão de entrega"><input type="date" value={f.expected_delivery_date} onChange={(e) => set('expected_delivery_date')(e.target.value)} /></Field>
          <Field label="Telefone"><input type="tel" value={f.contact_phone} onChange={(e) => set('contact_phone')(e.target.value)} /></Field>
        </div>
        {t.id
          ? <Attachments entityType="transport_order" entityId={t.id} vehicleId={vehicle.id} title="Recibo do reboque (opcional)" />
          : <FilePick files={files} onChange={setFiles} label="Anexar recibo (opcional)" />}
        <p className="small muted" style={{ margin: 0 }}>O valor pago entra no custo do carro e em contas a pagar. Entregue = carro muda para “Recebido”.</p>
      </div>
    </Modal>
  )
}

// =============================================================================
// Peças (Parts List)
// =============================================================================
const PART_FLOW = { identified: 'to_buy', awaiting_quote: 'to_buy', to_buy: 'purchased', purchased: 'received', awaiting_delivery: 'received', received: 'installed' }

export function Parts({ vehicle, onChange }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [parts, summary] = await Promise.all([
      q(supabase.from('parts').select('*, suppliers(name)').eq('vehicle_id', vehicle.id).order('created_at')),
      q(supabase.from('vehicle_parts_summary').select('*').eq('vehicle_id', vehicle.id).maybeSingle()),
    ])
    return { parts, summary }
  }, [vehicle.id])
  const [editing, setEditing] = useState(null)
  const [run] = useAction()
  const [counts, reloadCounts] = useAttachmentCounts(vehicle.id, 'part')
  const sold = vehicle.status === 'sold'
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { parts, summary } = data

  const advance = async (p) => {
    const next = PART_FLOW[p.status]
    if (next === 'purchased' && p.actual_unit_price === null) { setEditing({ ...p, status: 'purchased' }); return }
    await run(() => q(supabase.from('parts').update({ status: next }).eq('id', p.id)), `${p.name}: ${label('part_status', next)}`)
    reload(); onChange()
  }

  return (
    <div className="stack">
      <div className="grid grid-4">
        <Kpi label="Peças" value={summary?.items ?? 0} hint={`${summary?.pending_items ?? 0} pendentes`} />
        <Kpi label="A comprar" value={summary?.to_buy_items ?? 0} tone={summary?.late_items ? 'warn' : ''} hint={summary?.late_items ? `${summary.late_items} atrasada(s)` : undefined} />
        <Kpi label="Total estimado" value={money(summary?.estimated_total)} />
        <Kpi label="Total gasto" value={money(summary?.actual_total)} />
      </div>
      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>Parts List</h2>
          {!sold && <button className="btn-sm btn-primary" onClick={() => setEditing({})}><Icon name="plus" /> Peça</button>}
        </div>
        {parts.length === 0 ? <Empty title="Nenhuma peça cadastrada" /> : (
          <div className="list">
            {parts.map((p) => (
              <div key={p.id} className="list-item" onClick={() => !sold && setEditing(p)}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div><b>{p.name}</b>{p.quantity > 1 && ` (${p.quantity})`} <span className="muted small">· {label('part_condition', p.part_condition)}</span></div>
                  <div className="muted small">
                    {[p.suppliers?.name, p.part_number && `PN ${p.part_number}`, p.oem_number && `OEM ${p.oem_number}`, p.expected_delivery_date && p.status === 'awaiting_delivery' && `entrega ${date(p.expected_delivery_date)}`].filter(Boolean).join(' · ') || label('part_category', p.category)}
                  </div>
                </div>
                <div className="right">
                  <Badge tone={PART_STATUS_TONE[p.status]}>{label('part_status', p.status)}</Badge>
                  <div className="num small" style={{ marginTop: 4 }}>
                    {p.actual_total !== null ? <b>{money(p.actual_total)}</b> : <span className="muted">est. {money(p.estimated_total)}</span>}
                  </div>
                </div>
                <AttachmentsButton entityType="part" entityId={p.id} vehicleId={vehicle.id} count={counts[p.id]} title={`Nota da peça: ${p.name}`} onChange={reloadCounts} />
                {!sold && PART_FLOW[p.status] && (
                  <button className="btn-sm" onClick={(e) => { e.stopPropagation(); advance(p) }} title={`Marcar como ${label('part_status', PART_FLOW[p.status])}`}>
                    → {label('part_status', PART_FLOW[p.status])}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
      {editing && <PartModal vehicle={vehicle} part={editing} onClose={() => { setEditing(null); reloadCounts() }} onDone={() => { setEditing(null); reload(); reloadCounts(); onChange() }} />}
    </div>
  )
}

function PartModal({ vehicle, part, onClose, onDone }) {
  const [f, setF] = useState({
    name: part.name || '', category: part.category || 'body', part_condition: part.part_condition || 'new', quantity: part.quantity ?? 1,
    oem_number: part.oem_number || '', part_number: part.part_number || '', supplier_id: part.supplier_id || '', product_url: part.product_url || '',
    estimated_unit_price: part.estimated_unit_price ?? '', actual_unit_price: part.actual_unit_price ?? '', status: part.status || 'to_buy',
    expected_delivery_date: part.expected_delivery_date || '', refund_amount: part.refund_amount ?? '', notes: part.notes || '',
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const { company } = useApp()
  const [files, setFiles] = useState([])
  const needsPrice = !['identified', 'awaiting_quote', 'to_buy'].includes(f.status)
  const save = async () => {
    const row = {
      vehicle_id: vehicle.id, name: f.name, category: f.category, part_condition: f.part_condition, quantity: toNum(f.quantity) || 1,
      oem_number: f.oem_number || null, part_number: f.part_number || null, supplier_id: f.supplier_id || null, product_url: f.product_url || null,
      estimated_unit_price: toNum(f.estimated_unit_price) ?? 0, actual_unit_price: toNum(f.actual_unit_price), status: f.status,
      expected_delivery_date: f.expected_delivery_date || null, refund_amount: toNum(f.refund_amount) ?? 0, notes: f.notes || null,
    }
    await run(async () => {
      const saved = part.id
        ? await q(supabase.from('parts').update(row).eq('id', part.id).select('id').single())
        : await q(supabase.from('parts').insert(row).select('id').single())
      await uploadAll(files, { companyId: company.id, entityType: 'part', entityId: saved.id, vehicleId: vehicle.id })
    }, 'Peça salva')
    onDone()
  }
  return (
    <Modal title={part.id ? 'Editar peça' : 'Nova peça'} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.name || (needsPrice && f.actual_unit_price === '')}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Nome da peça *" span><input value={f.name} onChange={(e) => set('name')(e.target.value)} placeholder="Front bumper" /></Field>
        <Field label="Status"><Select value={f.status} onChange={set('status')} options={options('part_status')} /></Field>
        <Field label="Quantidade"><input type="number" inputMode="numeric" min="1" value={f.quantity} onChange={(e) => set('quantity')(e.target.value)} /></Field>
        <Field label="Preço estimado (un.)"><MoneyInput value={f.estimated_unit_price} onChange={set('estimated_unit_price')} /></Field>
        <Field label={needsPrice ? 'Preço pago (un.) *' : 'Preço pago (un.)'}><MoneyInput value={f.actual_unit_price} onChange={set('actual_unit_price')} /></Field>
        <Field label="Categoria"><Select value={f.category} onChange={set('category')} options={options('part_category')} /></Field>
        <Field label="Tipo"><Select value={f.part_condition} onChange={set('part_condition')} options={options('part_condition')} /></Field>
        <Field label="Fornecedor"><SupplierSelect value={f.supplier_id} onChange={set('supplier_id')} type="parts" /></Field>
        <Field label="Previsão de entrega"><input type="date" value={f.expected_delivery_date} onChange={(e) => set('expected_delivery_date')(e.target.value)} /></Field>
        <Field label="Part number"><input value={f.part_number} onChange={(e) => set('part_number')(e.target.value)} /></Field>
        <Field label="Código OEM"><input value={f.oem_number} onChange={(e) => set('oem_number')(e.target.value)} /></Field>
        <Field label="Link do produto" span><input type="url" value={f.product_url} onChange={(e) => set('product_url')(e.target.value)} /></Field>
        {f.status === 'returned' && <Field label="Valor reembolsado"><MoneyInput value={f.refund_amount} onChange={set('refund_amount')} /></Field>}
        <Field label="Observações" full><input value={f.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
      </div>
      {needsPrice && f.actual_unit_price === '' && <div className="alert-box warning" style={{ marginTop: 12 }}>Informe o preço pago para marcar como {label('part_status', f.status)}.</div>}
      <div className="divider" />
      {part.id
        ? <Attachments entityType="part" entityId={part.id} vehicleId={vehicle.id} title="Nota fiscal / invoice (opcional)" />
        : <FilePick files={files} onChange={setFiles} label="Anexar nota fiscal (opcional)" />}
    </Modal>
  )
}

// =============================================================================
// Mão de obra (Labor & Repairs)
// =============================================================================
export function Labor({ vehicle, onChange }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [items, entries, orders] = await Promise.all([
      q(supabase.from('repair_items_overview').select('*').eq('vehicle_id', vehicle.id)),
      q(supabase.from('labor_entries').select('*, suppliers(name)').eq('vehicle_id', vehicle.id).eq('status', 'confirmed').order('work_date')),
      q(supabase.from('repair_orders').select('id, title, supplier_id, mechanic_name, status, suppliers(name)').eq('vehicle_id', vehicle.id)),
    ])
    return { items, entries, orders }
  }, [vehicle.id])
  const [adding, setAdding] = useState(false)
  const [paying, setPaying] = useState(null)
  const [run] = useAction()
  const sold = vehicle.status === 'sold'
  const [counts, reloadCounts] = useAttachmentCounts(vehicle.id, 'repair_item')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { items, entries, orders } = data
  const orderName = (id) => { const o = orders.find((x) => x.id === id); return o?.suppliers?.name || o?.mechanic_name || o?.title }
  const est = items.filter((i) => i.status !== 'cancelled').reduce((s, i) => s + Number(i.estimated_cost), 0)
  const real = entries.reduce((s, e) => s + Number(e.amount), 0)

  const complete = async (i) => {
    await run(() => q(supabase.from('repair_items').update({ status: 'completed' }).eq('id', i.repair_item_id)), 'Serviço concluído')
    reload(); onChange()
  }

  return (
    <div className="stack">
      <div className="grid grid-3">
        <Kpi label="Serviços" value={items.length} hint={`${items.filter((i) => i.status === 'completed').length} concluídos`} />
        <Kpi label="Mão de obra prevista" value={money(est)} />
        <Kpi label="Mão de obra paga" value={money(real)} tone={real > est && est > 0 ? 'neg' : ''} />
      </div>
      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>Serviços</h2>
          {!sold && <button className="btn-sm btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Serviço</button>}
        </div>
        {items.length === 0 ? <Empty title="Nenhum serviço cadastrado">Ex.: troca de para-choque, pintura, alinhamento.</Empty> : (
          <div className="list">
            {items.map((i) => (
              <div key={i.repair_item_id} className="list-item" style={{ cursor: 'default' }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div><b>{i.service}</b> <Badge tone={i.status === 'completed' ? 'success' : i.status === 'cancelled' ? '' : 'warning'}>{label('repair_status', i.status)}</Badge></div>
                  <div className="muted small">{[orderName(i.repair_order_id), i.area && label('vehicle_area', i.area)].filter(Boolean).join(' · ')}</div>
                </div>
                <div className="right num small">
                  <div>prev. {money(i.estimated_cost)}</div>
                  <div className={Number(i.actual_cost) > Number(i.estimated_cost) ? 'neg' : 'pos'}><b>pago {money(i.actual_cost)}</b></div>
                </div>
                <AttachmentsButton entityType="repair_item" entityId={i.repair_item_id} vehicleId={vehicle.id} count={counts[i.repair_item_id]} title={`Invoices: ${i.service}`} onChange={reloadCounts} />
                {!sold && <div className="row" style={{ gap: 6 }}>
                  <button className="btn-sm" onClick={() => setPaying(i)}>$ Lançar</button>
                  {i.status !== 'completed' && i.status !== 'cancelled' && <button className="btn-sm" onClick={() => complete(i)}>Concluir</button>}
                </div>}
              </div>
            ))}
          </div>
        )}
      </div>
      {adding && <ServiceModal vehicle={vehicle} orders={orders} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); onChange() }} />}
      {paying && <LaborEntryModal vehicle={vehicle} item={paying} orders={orders} onClose={() => setPaying(null)} onDone={() => { setPaying(null); reload(); reloadCounts(); onChange() }} />}
    </div>
  )
}

function ServiceModal({ vehicle, orders, onClose, onDone }) {
  const [f, setF] = useState({ service: '', area: '', supplier_id: '', mechanic_name: '', estimated_cost: '', status: 'approved' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    await run(async () => {
      // agrupa os serviços por oficina/mecânico numa ordem de reparo aberta
      let order = orders.find((o) => !['completed', 'cancelled'].includes(o.status) &&
        (f.supplier_id ? o.supplier_id === f.supplier_id : !o.supplier_id && (o.mechanic_name || '') === f.mechanic_name))
      if (!order) {
        order = await q(supabase.from('repair_orders').insert({
          vehicle_id: vehicle.id, title: f.supplier_id ? 'Serviços da oficina' : (f.mechanic_name ? `Serviços — ${f.mechanic_name}` : 'Serviços'),
          supplier_id: f.supplier_id || null, mechanic_name: f.mechanic_name || null, status: 'in_progress',
        }).select('id').single())
      }
      await q(supabase.from('repair_items').insert({
        repair_order_id: order.id, vehicle_id: vehicle.id, service: f.service, area: f.area || null,
        estimated_cost: toNum(f.estimated_cost) ?? 0, status: f.status,
      }))
    }, 'Serviço cadastrado')
    onDone()
  }
  return (
    <Modal title="Novo serviço" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.service}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Serviço *" span><input value={f.service} onChange={(e) => set('service')(e.target.value)} placeholder="Troca de para-choque" /></Field>
        <Field label="Valor previsto (mão de obra)"><MoneyInput value={f.estimated_cost} onChange={set('estimated_cost')} /></Field>
        <Field label="Área"><Select value={f.area} onChange={set('area')} placeholder="—" options={options('vehicle_area')} /></Field>
        <Field label="Oficina (fornecedor)"><SupplierSelect value={f.supplier_id} onChange={set('supplier_id')} type="body_shop" /></Field>
        <Field label="ou mecânico (nome)"><input value={f.mechanic_name} onChange={(e) => set('mechanic_name')(e.target.value)} disabled={Boolean(f.supplier_id)} /></Field>
        <Field label="Status"><Select value={f.status} onChange={set('status')} options={options('repair_status')} /></Field>
      </div>
    </Modal>
  )
}

function LaborEntryModal({ vehicle, item, orders, onClose, onDone }) {
  const order = orders.find((o) => o.id === item.repair_order_id)
  const [mode, setMode] = useState('flat')
  const [f, setF] = useState({ flat_amount: '', hours: '', hourly_rate: '', work_date: today(), supplier_id: order?.supplier_id || '', invoice_number: '' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const total = mode === 'flat' ? toNum(f.flat_amount) : (toNum(f.hours) ?? 0) * (toNum(f.hourly_rate) ?? 0)
  const { company } = useApp()
  const [files, setFiles] = useState([])
  const save = async () => {
    await run(async () => { await q(supabase.from('labor_entries').insert({
      vehicle_id: vehicle.id, repair_item_id: item.repair_item_id, description: item.service, work_date: f.work_date,
      supplier_id: f.supplier_id || null, worker_name: order?.mechanic_name || null, invoice_number: f.invoice_number || null,
      flat_amount: mode === 'flat' ? toNum(f.flat_amount) : null,
      hours: mode === 'hours' ? toNum(f.hours) : null, hourly_rate: mode === 'hours' ? toNum(f.hourly_rate) : null,
    }))
      await uploadAll(files, { companyId: company.id, entityType: 'repair_item', entityId: item.repair_item_id, vehicleId: vehicle.id })
    }, 'Mão de obra lançada')
    onDone()
  }
  return (
    <Modal title={`Lançar mão de obra — ${item.service}`} onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !total}>Lançar {money(total)}</button></>}>
      <div className="stack">
        <div className="row">
          <button className={`btn-sm ${mode === 'flat' ? 'btn-primary' : ''}`} onClick={() => setMode('flat')}>Valor fechado</button>
          <button className={`btn-sm ${mode === 'hours' ? 'btn-primary' : ''}`} onClick={() => setMode('hours')}>Horas × valor/hora</button>
        </div>
        <div className="form-grid">
          {mode === 'flat'
            ? <Field label="Valor"><MoneyInput value={f.flat_amount} onChange={set('flat_amount')} /></Field>
            : <>
              <Field label="Horas"><input type="number" inputMode="decimal" value={f.hours} onChange={(e) => set('hours')(e.target.value)} /></Field>
              <Field label="Valor/hora"><MoneyInput value={f.hourly_rate} onChange={set('hourly_rate')} /></Field>
            </>}
          <Field label="Data"><input type="date" value={f.work_date} onChange={(e) => set('work_date')(e.target.value)} /></Field>
          <Field label="Pago a (oficina)"><SupplierSelect value={f.supplier_id} onChange={set('supplier_id')} type="body_shop" /></Field>
          <Field label="Nº invoice"><input value={f.invoice_number} onChange={(e) => set('invoice_number')(e.target.value)} /></Field>
        </div>
        <FilePick files={files} onChange={setFiles} label="Anexar invoice da oficina (opcional)" />
        <p className="small muted" style={{ margin: 0 }}>Com oficina informada, o valor também entra em contas a pagar.</p>
      </div>
    </Modal>
  )
}

// =============================================================================
// Despesas avulsas (documentação, inspeção, estadia, limpeza, anúncios, venda...)
// =============================================================================
const MODULE_GROUPS = ['purchase', 'auction_fees', 'transport', 'parts', 'labor']

export function Expenses({ vehicle, onChange }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [expenses, categories] = await Promise.all([
      q(supabase.from('expenses').select('*, expense_categories(name, cost_group), suppliers(name)').eq('vehicle_id', vehicle.id).order('expense_date')),
      q(supabase.from('expense_categories').select('id, name, cost_group').eq('is_active', true).order('name')),
    ])
    return { expenses, categories: categories.filter((c) => !MODULE_GROUPS.includes(c.cost_group)) }
  }, [vehicle.id])
  const [adding, setAdding] = useState(false)
  const [run] = useAction()
  const [counts, reloadCounts] = useAttachmentCounts(vehicle.id, 'expense')
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const active = data.expenses.filter((e) => e.status !== 'cancelled')
  const total = active.reduce((s, e) => s + Number(e.amount), 0)

  const cancel = async (e) => {
    if (!window.confirm(`Cancelar a despesa "${e.description}"?`)) return
    await run(() => q(supabase.from('expenses').update({ status: 'cancelled' }).eq('id', e.id)), 'Despesa cancelada')
    reload(); onChange()
  }

  return (
    <div className="stack">
      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>Outras despesas ({money(total)})</h2>
          <button className="btn-sm btn-primary" onClick={() => setAdding(true)}><Icon name="plus" /> Despesa</button>
        </div>
        {data.expenses.length === 0 ? <Empty title="Nenhuma despesa">Documentação, inspeção, estadia, limpeza, fotos, comissão de venda…</Empty> : (
          <div className="list">
            {data.expenses.map((e) => (
              <div key={e.id} className="list-item" style={{ cursor: 'default', opacity: e.status === 'cancelled' ? 0.5 : 1 }}>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div><b>{e.description}</b>{e.status === 'cancelled' && <Badge>cancelada</Badge>}</div>
                  <div className="muted small">{e.expense_categories?.name} · {date(e.expense_date)}{e.suppliers?.name && ` · ${e.suppliers.name}`}</div>
                </div>
                <div className="num">{money(e.amount)}</div>
                <AttachmentsButton entityType="expense" entityId={e.id} vehicleId={vehicle.id} count={counts[e.id]} title={`Comprovante: ${e.description}`} onChange={reloadCounts} />
                {e.status !== 'cancelled' && <button className="btn-ghost btn-sm" onClick={() => cancel(e)} aria-label="Cancelar"><Icon name="trash" /></button>}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Reboque, peças e mão de obra ficam nas próprias abas para não contar o custo duas vezes.</p>
      {adding && <ExpenseModal vehicle={vehicle} categories={data.categories} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); reloadCounts(); onChange() }} />}
    </div>
  )
}

function ExpenseModal({ vehicle, categories, onClose, onDone }) {
  const sold = vehicle.status === 'sold'
  const cats = sold ? categories.filter((c) => c.cost_group === 'selling') : categories
  const [f, setF] = useState({ category_id: cats[0]?.id || '', description: '', amount: '', expense_date: today(), supplier_id: '' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const { company } = useApp()
  const [files, setFiles] = useState([])
  const save = async () => {
    await run(async () => {
      const saved = await q(supabase.from('expenses').insert({
        vehicle_id: vehicle.id, category_id: f.category_id, description: f.description || cats.find((c) => c.id === f.category_id)?.name,
        amount: toNum(f.amount), expense_date: f.expense_date, supplier_id: f.supplier_id || null,
      }).select('id').single())
      await uploadAll(files, { companyId: company.id, entityType: 'expense', entityId: saved.id, vehicleId: vehicle.id })
    }, 'Despesa lançada')
    onDone()
  }
  return (
    <Modal title="Nova despesa" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !toNum(f.amount) || !f.category_id}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Categoria"><Select value={f.category_id} onChange={set('category_id')} options={cats.map((c) => [c.id, c.name])} /></Field>
        <Field label="Valor *"><MoneyInput value={f.amount} onChange={set('amount')} /></Field>
        <Field label="Descrição" span><input value={f.description} onChange={(e) => set('description')(e.target.value)} placeholder="Ex.: taxa de título NH" /></Field>
        <Field label="Data"><input type="date" value={f.expense_date} onChange={(e) => set('expense_date')(e.target.value)} /></Field>
        <Field label="Fornecedor"><SupplierSelect value={f.supplier_id} onChange={set('supplier_id')} /></Field>
      </div>
      <div className="divider" />
      <FilePick files={files} onChange={setFiles} label="Anexar comprovante (opcional)" />
      {sold && <p className="small muted">Carro vendido: só despesas de venda (comissão, transferência…) podem ser lançadas.</p>}
    </Modal>
  )
}

// =============================================================================
// Documentos
// =============================================================================
export function Documents({ vehicle }) {
  const { company } = useApp()
  const { data, error, loading, reload } = useLoad(() => q(supabase.from('documents').select('*').eq('vehicle_id', vehicle.id).order('created_at')), [vehicle.id])
  const files = useLoad(() => q(supabase.from('attachments').select('*').eq('vehicle_id', vehicle.id).neq('entity_type', 'document').neq('kind', 'photo').order('created_at', { ascending: false })), [vehicle.id])
  const [run] = useAction()
  const [adding, setAdding] = useState(false)
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />

  const setStatus = async (d, status) => {
    await run(() => q(supabase.from('documents').update({ status }).eq('id', d.id)), 'Documento atualizado'); reload()
  }
  const upload = async (d, file) => {
    if (!file) return
    const path = `${company.id}/document/${d.id}/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`
    await run(async () => {
      const { error: e } = await supabase.storage.from('documents').upload(path, file)
      if (e) throw e
      await q(supabase.from('documents').update({ storage_bucket: 'documents', storage_path: path, status: d.status === 'pending' ? 'received' : d.status }).eq('id', d.id))
    }, 'Arquivo enviado')
    reload()
  }
  const open = async (d) => {
    const w = window.open('', '_blank')
    const { data: s, error: e } = await supabase.storage.from(d.storage_bucket).createSignedUrl(d.storage_path, 600)
    if (e) { w?.close(); alert(e.message) } else if (w) w.location.href = s.signedUrl; else window.location.href = s.signedUrl
  }

  return (
    <div className="stack">
    <div className="card pad-0">
      <div className="card-title" style={{ padding: '16px 16px 0' }}>
        <h2>Documentos</h2>
        <button className="btn-sm" onClick={() => setAdding(true)}><Icon name="plus" /> Documento</button>
      </div>
      {data.length === 0 ? <Empty title="Nenhum documento" /> : (
        <div className="list">
          {data.map((d) => (
            <div key={d.id} className="list-item" style={{ cursor: 'default', flexWrap: 'wrap' }}>
              <div className="grow" style={{ minWidth: 160 }}>
                <b>{label('document_type', d.doc_type)}</b>
                <div className="muted small">{d.title !== label('document_type', d.doc_type) && d.title}{d.due_date && ` · prazo ${date(d.due_date)}`}</div>
              </div>
              <Select value={d.status} onChange={(s) => setStatus(d, s)} options={options('document_status')} style={{ width: 'auto' }} />
              {d.storage_path
                ? <button className="btn-sm" onClick={() => open(d)}>Ver arquivo</button>
                : <label className="btn btn-sm" style={{ cursor: 'pointer' }}>Enviar arquivo<input type="file" accept="application/pdf,image/*" hidden onChange={(e) => upload(d, e.target.files[0])} /></label>}
            </div>
          ))}
        </div>
      )}
      {adding && <DocumentModal vehicle={vehicle} onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload() }} />}
    </div>
    <div className="card stack" style={{ gap: 10 }}>
      <div><h2>Notas e comprovantes</h2><div className="muted small">Todos os arquivos anexados neste carro: peças, mão de obra, despesas, reboque e pagamentos.</div></div>
      {files.loading ? <div className="muted small">Carregando…</div>
        : (files.data || []).length === 0 ? <div className="muted small">Nenhum arquivo anexado ainda.</div>
          : files.data.map((a) => <AttachmentRow key={a.id} a={a} showOrigin />)}
    </div>
    </div>
  )
}

function DocumentModal({ vehicle, onClose, onDone }) {
  const [f, setF] = useState({ doc_type: 'other', title: '', reference_number: '', due_date: '' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    await run(() => q(supabase.from('documents').insert({ vehicle_id: vehicle.id, doc_type: f.doc_type, title: f.title || label('document_type', f.doc_type), reference_number: f.reference_number || null, due_date: f.due_date || null })), 'Documento adicionado')
    onDone()
  }
  return (
    <Modal title="Novo documento" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Tipo"><Select value={f.doc_type} onChange={set('doc_type')} options={options('document_type')} /></Field>
        <Field label="Descrição"><input value={f.title} onChange={(e) => set('title')(e.target.value)} /></Field>
        <Field label="Número de referência"><input value={f.reference_number} onChange={(e) => set('reference_number')(e.target.value)} /></Field>
        <Field label="Prazo"><input type="date" value={f.due_date} onChange={(e) => set('due_date')(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

// =============================================================================
// Venda e propostas
// =============================================================================
export function Sale({ vehicle, pa, onChange }) {
  const { data, error, loading, reload } = useLoad(async () => {
    const [sale, offers, accounts, customers] = await Promise.all([
      q(supabase.from('sales').select('*, customers(full_name, phone)').eq('vehicle_id', vehicle.id).neq('status', 'cancelled').maybeSingle()),
      q(supabase.from('vehicle_offers_analysis').select('*').eq('vehicle_id', vehicle.id).order('offered_at', { ascending: false })),
      q(supabase.from('financial_accounts').select('id, name').eq('is_active', true).order('name')),
      q(supabase.from('customers').select('id, full_name, phone').order('full_name')),
    ])
    let schedule = []
    if (sale) schedule = await q(supabase.from('accounts_receivable').select('*').eq('sale_id', sale.id).neq('status', 'cancelled').order('installment_number', { nullsFirst: true }).order('due_date'))
    return { sale, offers, accounts, customers, schedule }
  }, [vehicle.id])
  const [selling, setSelling] = useState(false)
  const [offering, setOffering] = useState(false)
  if (loading) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { sale, offers, schedule } = data

  if (sale) {
    const remaining = schedule.reduce((t, r) => t + Number(r.balance), 0)
    const received = schedule.reduce((t, r) => t + Number(r.received_amount), 0)
    const parcelado = sale.installments > 1
    const overdue = schedule.filter((r) => r.status !== 'received' && r.due_date < today()).length
    const FREQ = { monthly: 'mensais', biweekly: 'quinzenais', weekly: 'semanais' }
    return (
      <div className="stack">
        <div className="grid grid-3">
          <Kpi label="Vendido por" value={money(sale.final_price)} hint={date(sale.sale_date)} highlight />
          <Kpi label="Lucro real" value={money(pa?.real_profit)} tone={Number(pa?.real_profit) < 0 ? 'neg' : 'pos'} hint={`Margem ${pa?.real_margin_pct ?? '—'}%`} />
          <Kpi to="/financeiro?tab=receive" label="Falta receber" value={money(remaining)} tone={remaining > 0 ? (overdue ? 'neg' : 'warn') : 'pos'}
            hint={overdue ? `${overdue} parcela(s) vencida(s)` : `Recebido ${money(received)}`} />
        </div>
        <div className="card">
          <div className="lines">
            <div><span className="muted">Cliente</span><span>{sale.customers?.full_name} {sale.customers?.phone && `· ${sale.customers.phone}`}</span></div>
            <div><span className="muted">Pagamento</span><span>{parcelado
              ? `Entrada ${money(sale.down_payment)} + ${sale.installments} parcelas ${FREQ[sale.installment_frequency]} de ${money(sale.installment_amount, true)}${Number(sale.interest_rate_apr) > 0 ? ` (juros ${Number(sale.interest_rate_apr)}% a.a.)` : ' (sem juros)'}`
              : `${label('payment_method', sale.payment_method)} · recebido na hora ${money(sale.down_payment)}`}</span></div>
            {parcelado && Number(sale.total_with_interest) !== Number(sale.final_price) && <div><span className="muted">Total a receber com juros</span><span>{money(sale.total_with_interest, true)}</span></div>}
            {sale.notes && <div><span className="muted">Obs.</span><span>{sale.notes}</span></div>}
          </div>
        </div>
        {schedule.length > 0 && (
          <div className="card pad-0">
            <div className="card-title" style={{ padding: '16px 16px 0' }}>
              <h2>{parcelado ? 'Parcelas' : 'Recebimento'}</h2>
              <Link to="/financeiro?tab=receive" className="btn btn-sm">Receber no Financeiro</Link>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Parcela</th><th>Vencimento</th><th className="num">Valor</th><th className="num">Recebido</th><th>Situação</th><th></th></tr></thead>
                <tbody>
                  {schedule.map((r) => {
                    const late = r.status !== 'received' && r.due_date < today()
                    return (
                      <tr key={r.id}>
                        <td>{r.installment_number === 0 ? 'Entrada' : r.installment_number ? `${r.installment_number}/${sale.installments}` : 'Única'}</td>
                        <td>{date(r.due_date)}</td>
                        <td className="num">{money(r.amount, true)}</td>
                        <td className="num">{money(r.received_amount, true)}</td>
                        <td><Badge tone={r.status === 'received' ? 'success' : late ? 'error' : r.status === 'partial' ? 'warning' : ''}>{r.status === 'received' ? 'Paga' : late ? 'Vencida' : r.status === 'partial' ? 'Parcial' : 'Em aberto'}</Badge></td>
                        <td>{(late || r.due_date <= today()) && <ReminderButton receivable={r} customer={sale.customers?.full_name} phone={sale.customers?.phone} vehicle={vehicleName(vehicle)} />}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Vender este carro</h2>
        {pa && <div className="lines num small">
          <div><span>Preço mínimo sem prejuízo</span><b>{money(pa.break_even_price)}</b></div>
          <div><span>Mínimo para suas metas</span><b>{money(pa.min_target_price)}</b></div>
          <div><span>Preço recomendado</span><b className="gold">{money(pa.recommended_price)}</b></div>
        </div>}
        <button className="btn-primary" onClick={() => setSelling(true)}>Registrar venda</button>
      </div>

      <div className="card pad-0">
        <div className="card-title" style={{ padding: '16px 16px 0' }}>
          <h2>Propostas</h2>
          <button className="btn-sm" onClick={() => setOffering(true)}><Icon name="plus" /> Proposta</button>
        </div>
        {offers.length === 0 ? <Empty title="Nenhuma proposta" /> : (
          <div className="list">
            {offers.map((o) => (
              <div key={o.offer_id} className="list-item" style={{ cursor: 'default' }}>
                <div className="grow">
                  <b>{o.contact_name || data.customers.find((c) => c.id === o.customer_id)?.full_name || 'Interessado'}</b>
                  <div className="muted small">{date(o.offered_at)}{o.channel && ` · ${o.channel}`}</div>
                </div>
                <div className="right num">
                  <div><b>{money(o.offer_amount)}</b></div>
                  {o.offer_amount && <div className="small">
                    {o.meets_targets ? <span className="pos">✓ atinge a meta</span> : o.covers_costs ? <span className="warn">lucro {money(o.profit_if_accepted)} (abaixo da meta)</span> : <span className="neg">prejuízo {money(o.profit_if_accepted)}</span>}
                  </div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {selling && <SaleModal vehicle={vehicle} pa={pa} accounts={data.accounts} customers={data.customers} onClose={() => setSelling(false)} onDone={() => { setSelling(false); reload(); onChange() }} />}
      {offering && <OfferModal vehicle={vehicle} onClose={() => setOffering(false)} onDone={() => { setOffering(false); reload() }} />}
    </div>
  )
}

async function ensureCustomer(f) {
  if (f.customer_id) return f.customer_id
  const c = await q(supabase.from('customers').insert({ full_name: f.new_name, phone: f.new_phone || null, email: f.new_email || null }).select('id').single())
  return c.id
}

function SaleModal({ vehicle, pa, accounts, customers, onClose, onDone }) {
  const [f, setF] = useState({
    customer_id: '', new_name: '', new_phone: '', new_email: '', final_price: vehicle.listed_price ?? pa?.expected_sale_price ?? '',
    sale_date: today(), payment_method: 'cash', down_payment: '', account_id: accounts[0]?.id || '', new_account: accounts.length ? '' : 'Caixa', notes: '',
    mode: 'cash', installments: '12', frequency: 'monthly', first_due_date: '', apr: '',
  })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const price = toNum(f.final_price)
  const profit = pa && price ? price - Number(pa.projected_cost) - Number(pa.projected_selling) : null
  const parcelado = f.mode === 'installments'
  const n = Math.max(0, Math.floor(toNum(f.installments) || 0))
  const down = toNum(f.down_payment) ?? 0
  const financed = price ? price - down : 0
  const perYear = f.frequency === 'weekly' ? 52 : f.frequency === 'biweekly' ? 26 : 12
  const rate = (toNum(f.apr) || 0) / 100 / perYear
  const pmt = n >= 2 && financed > 0 ? Math.round((rate ? financed * rate / (1 - (1 + rate) ** -n) : financed / n) * 100) / 100 : null
  const planOk = !parcelado || (pmt && n >= 2 && n <= 120 && down < price)
  const save = async () => {
    await run(async () => {
      const customerId = await ensureCustomer(f)
      let accountId = f.account_id
      if (toNum(f.down_payment) && !accountId) {
        const a = await q(supabase.from('financial_accounts').insert({ name: f.new_account || 'Caixa', account_type: 'cash' }).select('id').single())
        accountId = a.id
      }
      await rpc('register_sale', {
        p_vehicle_id: vehicle.id, p_customer_id: customerId, p_final_price: price, p_sale_date: f.sale_date,
        p_payment_method: f.payment_method, p_down_payment: down,
        p_down_payment_account_id: down ? accountId : null, p_notes: f.notes || null,
        p_installments: parcelado ? n : 1, p_installment_frequency: f.frequency,
        p_first_due_date: parcelado && f.first_due_date ? f.first_due_date : null, p_interest_rate_apr: parcelado ? (toNum(f.apr) || 0) : 0,
      })
    }, 'Venda registrada')
    onDone()
  }
  return (
    <Modal title="Registrar venda" onClose={onClose}
      footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !price || (!f.customer_id && !f.new_name) || !planOk}>Confirmar venda</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Cliente" span>
            <Select value={f.customer_id} onChange={set('customer_id')} placeholder="+ Novo cliente" options={customers.map((c) => [c.id, `${c.full_name}${c.phone ? ` · ${c.phone}` : ''}`])} />
          </Field>
          {!f.customer_id && <>
            <Field label="Nome do cliente *"><input value={f.new_name} onChange={(e) => set('new_name')(e.target.value)} /></Field>
            <Field label="Telefone"><input type="tel" value={f.new_phone} onChange={(e) => set('new_phone')(e.target.value)} /></Field>
          </>}
          <Field label="Valor final *"><MoneyInput value={f.final_price} onChange={set('final_price')} /></Field>
          <Field label="Data"><input type="date" value={f.sale_date} onChange={(e) => set('sale_date')(e.target.value)} /></Field>
          <Field label="Tipo de venda" span>
            <div className="row">
              <button type="button" className={`btn-sm ${!parcelado ? 'btn-primary' : ''}`} onClick={() => set('mode')('cash')}>À vista</button>
              <button type="button" className={`btn-sm ${parcelado ? 'btn-primary' : ''}`} onClick={() => set('mode')('installments')}>Parcelado</button>
            </div>
          </Field>
          <Field label={parcelado ? 'Pagamento da entrada' : 'Forma de pagamento'}><Select value={f.payment_method} onChange={set('payment_method')} options={options('payment_method').filter(([v]) => v !== 'installments')} /></Field>
          <Field label={parcelado ? 'Entrada' : 'Valor recebido agora'}><MoneyInput value={f.down_payment} onChange={set('down_payment')} placeholder={parcelado ? '0 se não tiver entrada' : '0 se receber depois'} /></Field>
          {parcelado && <>
            <Field label="Número de parcelas"><input type="number" inputMode="numeric" min="2" max="120" value={f.installments} onChange={(e) => set('installments')(e.target.value)} /></Field>
            <Field label="Frequência"><Select value={f.frequency} onChange={set('frequency')} options={[['monthly', 'Mensal'], ['biweekly', 'Quinzenal'], ['weekly', 'Semanal']]} /></Field>
            <Field label="1ª parcela vence em"><input type="date" value={f.first_due_date} onChange={(e) => set('first_due_date')(e.target.value)} placeholder="automático" /></Field>
            <Field label="Juros ao ano (%)"><input type="number" inputMode="decimal" min="0" step="0.1" value={f.apr} onChange={(e) => set('apr')(e.target.value)} placeholder="0 = sem juros" /></Field>
          </>}
          {toNum(f.down_payment) > 0 && (accounts.length
            ? <Field label="Recebido na conta"><Select value={f.account_id} onChange={set('account_id')} options={accounts.map((a) => [a.id, a.name])} /></Field>
            : <Field label="Nome da conta (será criada)"><input value={f.new_account} onChange={(e) => set('new_account')(e.target.value)} /></Field>)}
          <Field label="Observações" full><input value={f.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
        </div>
        {parcelado && (pmt ? (
          <div className="alert-box info">
            <b>{n} parcelas {f.frequency === 'weekly' ? 'semanais' : f.frequency === 'biweekly' ? 'quinzenais' : 'mensais'} de {money(pmt, true)}</b>
            <div className="small" style={{ marginTop: 4 }}>
              Valor financiado {money(financed, true)}{rate ? ` · total com juros ${money(pmt * n + down, true)} (juros ${money(pmt * n - financed, true)})` : ' · sem juros'}
              {!f.first_due_date && ` · 1ª parcela ${f.frequency === 'monthly' ? '1 mês' : f.frequency === 'biweekly' ? '15 dias' : '1 semana'} após a venda`}
            </div>
          </div>
        ) : <div className="alert-box warning">Informe valor, entrada menor que o valor e de 2 a 120 parcelas.</div>)}
        {profit !== null && (
          <div className={`alert-box ${profit < 0 ? 'error' : price >= Number(pa.min_target_price) ? 'success' : 'warning'}`}>
            Lucro estimado com essa venda: <b>{money(profit)}</b> ({((profit / price) * 100).toFixed(1)}% de margem)
          </div>
        )}
      </div>
    </Modal>
  )
}

function OfferModal({ vehicle, onClose, onDone }) {
  const [f, setF] = useState({ contact_name: '', contact_phone: '', channel: 'Facebook Marketplace', offer_amount: '', notes: '' })
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v }))
  const [run, busy] = useAction()
  const save = async () => {
    await run(() => q(supabase.from('vehicle_offers').insert({ vehicle_id: vehicle.id, contact_name: f.contact_name, contact_phone: f.contact_phone || null, channel: f.channel || null, offer_amount: toNum(f.offer_amount), notes: f.notes || null })), 'Proposta registrada')
    onDone()
  }
  return (
    <Modal title="Nova proposta" onClose={onClose} footer={<><button onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save} disabled={busy || !f.contact_name}>Salvar</button></>}>
      <div className="form-grid">
        <Field label="Nome *"><input value={f.contact_name} onChange={(e) => set('contact_name')(e.target.value)} /></Field>
        <Field label="Telefone"><input type="tel" value={f.contact_phone} onChange={(e) => set('contact_phone')(e.target.value)} /></Field>
        <Field label="Valor oferecido"><MoneyInput value={f.offer_amount} onChange={set('offer_amount')} placeholder="vazio = só interessado" /></Field>
        <Field label="Canal"><input value={f.channel} onChange={(e) => set('channel')(e.target.value)} /></Field>
        <Field label="Observações" full><input value={f.notes} onChange={(e) => set('notes')(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}
