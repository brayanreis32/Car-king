// Anexos opcionais (PDF ou foto) — notas fiscais, invoices e comprovantes.
// Arquivos ficam no bucket privado "documents" em {empresa}/{tipo}/{id}/arquivo
// e são registrados na tabela attachments (com o veículo, para a visão geral).
import { useRef, useState } from 'react'
import { date, q, supabase } from '../lib.js'
import { Icon, Modal, useAction, useLoad } from './ui.jsx'
import { useApp } from '../App.jsx'

const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic'
const MAX_MB = 25

export const ENTITY_LABEL = {
  part: 'Peça', repair_item: 'Mão de obra', labor_entry: 'Mão de obra', expense: 'Despesa',
  transport_order: 'Reboque', financial_transaction: 'Pagamento', vehicle_purchase: 'Compra',
  sale: 'Venda', document: 'Documento', vehicle: 'Veículo',
}

function checkFile(file) {
  const okType = file.type === 'application/pdf' || file.type.startsWith('image/')
  if (!okType) throw new Error(`"${file.name}": envie PDF ou foto (JPG, PNG, HEIC).`)
  if (file.size > MAX_MB * 1024 * 1024) throw new Error(`"${file.name}" passa de ${MAX_MB} MB.`)
}

export async function uploadAttachment(file, { companyId, entityType, entityId, vehicleId }) {
  checkFile(file)
  const safe = file.name.normalize('NFD').replace(/[^\w.-]+/g, '_')
  const path = `${companyId}/${entityType}/${entityId}/${Date.now()}-${safe}`
  const { error } = await supabase.storage.from('documents').upload(path, file, { contentType: file.type || undefined })
  if (error) throw new Error(`Falha ao enviar "${file.name}": ${error.message}`)
  await q(supabase.from('attachments').insert({
    entity_type: entityType, entity_id: entityId, vehicle_id: vehicleId || null,
    kind: file.type === 'application/pdf' ? 'invoice' : 'receipt',
    bucket: 'documents', path, file_name: file.name, mime_type: file.type || null, size_bytes: file.size,
  }))
}

export async function uploadAll(files, target) {
  for (const f of files) await uploadAttachment(f, target)
}

export async function openAttachment(a) {
  // abre a aba antes da espera, para o celular não bloquear o pop-up
  const w = window.open('', '_blank')
  const { data, error } = await supabase.storage.from(a.bucket).createSignedUrl(a.path, 600)
  if (error) { w?.close(); alert(error.message); return }
  if (w) w.location.href = data.signedUrl; else window.location.href = data.signedUrl
}

// Seleção de arquivos antes de salvar um registro novo
export function FilePick({ files, onChange, label = 'Anexar nota ou comprovante (opcional)' }) {
  const ref = useRef()
  const [err, setErr] = useState(null)
  const add = (list) => {
    try {
      const arr = Array.from(list || [])
      arr.forEach(checkFile)
      onChange([...files, ...arr]); setErr(null)
    } catch (e) { setErr(e.message) }
    ref.current.value = ''
  }
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <label className="btn btn-sm" style={{ cursor: 'pointer' }}>
          <Icon name="clip" /> {label}
          <input ref={ref} type="file" accept={ACCEPT} multiple hidden onChange={(e) => add(e.target.files)} />
        </label>
      </div>
      {files.map((f, i) => (
        <div key={i} className="row small" style={{ gap: 6 }}>
          <span className="grow" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</span>
          <button type="button" className="btn-ghost btn-sm" onClick={() => onChange(files.filter((_, j) => j !== i))} aria-label="Remover"><Icon name="close" /></button>
        </div>
      ))}
      {err && <div className="alert-box warning small">{err}</div>}
    </div>
  )
}

// Lista + envio de anexos de um registro já existente
export function Attachments({ entityType, entityId, vehicleId, title = 'Notas e comprovantes', onChange }) {
  const { company, can } = useApp()
  const { data, loading, reload } = useLoad(() =>
    q(supabase.from('attachments').select('*').eq('entity_type', entityType).eq('entity_id', entityId).order('created_at')), [entityType, entityId])
  const [run, busy] = useAction()
  const ref = useRef()
  const upload = async (list) => {
    const files = Array.from(list || [])
    if (!files.length) return
    await run(() => uploadAll(files, { companyId: company.id, entityType, entityId, vehicleId }), files.length > 1 ? 'Arquivos anexados' : 'Arquivo anexado')
    ref.current.value = ''
    reload(); onChange?.()
  }
  const remove = async (a) => {
    if (!window.confirm(`Remover o arquivo "${a.file_name}"?`)) return
    await run(async () => {
      await supabase.storage.from(a.bucket).remove([a.path])
      await q(supabase.from('attachments').delete().eq('id', a.id))
    }, 'Arquivo removido')
    reload(); onChange?.()
  }
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row between">
        <h3>{title}</h3>
        <label className="btn btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
          <Icon name="clip" /> {busy ? 'Enviando…' : 'Anexar'}
          <input ref={ref} type="file" accept={ACCEPT} multiple hidden disabled={busy} onChange={(e) => upload(e.target.files)} />
        </label>
      </div>
      {loading ? <div className="muted small">Carregando…</div> : data.length === 0
        ? <div className="muted small">Nenhum arquivo anexado. É opcional.</div>
        : data.map((a) => <AttachmentRow key={a.id} a={a} onRemove={can('vehicles', 'delete') ? () => remove(a) : null} />)}
    </div>
  )
}

export function AttachmentRow({ a, onRemove, showOrigin }) {
  return (
    <div className="row small" style={{ gap: 8, flexWrap: 'nowrap' }}>
      <span className="badge">{a.mime_type === 'application/pdf' ? 'PDF' : 'Foto'}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.file_name || 'arquivo'}</div>
        <div className="muted" style={{ fontSize: 12 }}>{showOrigin ? `${ENTITY_LABEL[a.entity_type] || a.entity_type} · ` : ''}{date(a.created_at)}</div>
      </div>
      <button type="button" className="btn-sm" onClick={() => openAttachment(a)}>Abrir</button>
      {onRemove && <button type="button" className="btn-ghost btn-sm" onClick={onRemove} aria-label="Remover"><Icon name="trash" /></button>}
    </div>
  )
}

// Botão com contador que abre os anexos de um registro
export function AttachmentsButton({ entityType, entityId, vehicleId, count = 0, title, onChange }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button" className="btn-sm" onClick={(e) => { e.stopPropagation(); setOpen(true) }} title="Notas e comprovantes">
        <Icon name="clip" />{count > 0 ? count : ''}
      </button>
      {open && (
        <Modal title={title || 'Notas e comprovantes'} onClose={() => setOpen(false)} footer={<button onClick={() => setOpen(false)}>Fechar</button>}>
          <Attachments entityType={entityType} entityId={entityId} vehicleId={vehicleId} title="Arquivos" onChange={onChange} />
        </Modal>
      )}
    </>
  )
}

// Contagem de anexos por registro de um veículo
export function useAttachmentCounts(vehicleId, entityType) {
  const res = useLoad(async () => {
    const rows = await q(supabase.from('attachments').select('entity_id').eq('vehicle_id', vehicleId).eq('entity_type', entityType))
    return rows.reduce((m, r) => ({ ...m, [r.entity_id]: (m[r.entity_id] || 0) + 1 }), {})
  }, [vehicleId, entityType])
  return [res.data || {}, res.reload]
}
