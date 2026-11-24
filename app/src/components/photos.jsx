// Fotos do veículo para venda: envio (com redução automática), capa, galeria,
// visualizador em tela cheia e compartilhamento (WhatsApp etc.).
// Arquivos no bucket privado "vehicle-media" em {empresa}/vehicle/{id}/photos/.
import { useEffect, useRef, useState } from 'react'
import { callFunction, q, supabase } from '../lib.js'
import { Empty, Icon, Spinner, useAction, useLoad, useToast } from './ui.jsx'
import { useApp } from '../App.jsx'

const BUCKET = 'vehicle-media'
// Tamanho padrão das fotos de venda: 1600×1200 (4:3), igual no site, no
// sistema e no Instagram.
const OUT_W = 1600, OUT_H = 1200

// Padroniza a foto em 1600×1200 (JPEG ~85%):
// * foto deitada perto de 4:3 → corta um pouco das bordas e preenche tudo;
// * foto em pé ou muito comprida → foto inteira no meio, com o fundo feito
//   da própria foto desfocada (sem faixa preta).
// Se o navegador não conseguir ler o formato (ex.: HEIC no Chrome), envia o original.
async function shrink(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const canvas = document.createElement('canvas'); canvas.width = OUT_W; canvas.height = OUT_H
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'
    const ratio = bmp.width / bmp.height
    const cover = Math.max(OUT_W / bmp.width, OUT_H / bmp.height)
    if (ratio >= 1.2 && ratio <= 1.45) {
      const w = bmp.width * cover, h = bmp.height * cover
      ctx.drawImage(bmp, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h)
    } else {
      // fundo: a própria foto ampliada e bem desfocada
      const cw = bmp.width * cover, ch = bmp.height * cover
      ctx.filter = 'blur(48px)'
      if (ctx.filter === 'blur(48px)') {
        ctx.drawImage(bmp, (OUT_W - cw) / 2 - 60, (OUT_H - ch) / 2 - 60, cw + 120, ch + 120)
      } else {
        // celular sem suporte a filtro: reduz e amplia em etapas (desfoque suave)
        let src = bmp, sw = bmp.width, sh = bmp.height, x = 0, y = 0
        const c0 = Math.max(16 / sw, 12 / sh)
        const t = document.createElement('canvas'); t.width = 16; t.height = 12
        t.getContext('2d').drawImage(src, (16 - sw * c0) / 2, (12 - sh * c0) / 2, sw * c0, sh * c0)
        src = t; sw = 16; sh = 12
        while (sw < OUT_W / 2) {
          const n = document.createElement('canvas'); n.width = sw * 2; n.height = sh * 2
          const nc = n.getContext('2d'); nc.imageSmoothingQuality = 'high'; nc.drawImage(src, 0, 0, n.width, n.height)
          src = n; sw = n.width; sh = n.height
        }
        ctx.filter = 'none'
        ctx.drawImage(src, x - 40, y - 30, OUT_W + 80, OUT_H + 60)
      }
      ctx.filter = 'none'
      ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(0, 0, OUT_W, OUT_H)
      const fit = Math.min(OUT_W / bmp.width, OUT_H / bmp.height)
      const w = bmp.width * fit, h = bmp.height * fit
      ctx.drawImage(bmp, (OUT_W - w) / 2, (OUT_H - h) / 2, w, h)
    }
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85))
    if (!blob) throw new Error('falha ao converter')
    return { blob, type: 'image/jpeg', ext: 'jpg' }
  } catch {
    const ext = (file.name.split('.').pop() || 'jpg').toLowerCase()
    return { blob: file, type: file.type || 'image/jpeg', ext }
  }
}

export async function signedUrls(rows, seconds = 3600) {
  if (!rows.length) return {}
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls(rows.map((r) => r.path), seconds)
  if (error) throw new Error(error.message)
  return Object.fromEntries(data.map((d, i) => [rows[i].id, d.signedUrl]))
}

export const loadPhotos = (vehicleId) =>
  q(supabase.from('attachments').select('*').eq('entity_type', 'vehicle').eq('entity_id', vehicleId).eq('kind', 'photo')
    .order('sort_order').order('created_at'))

export function VehiclePhotos({ vehicle, onUploaded }) {
  const { company, can } = useApp()
  const toast = useToast()
  const { data, loading, reload } = useLoad(async () => {
    const rows = await loadPhotos(vehicle.id)
    return { rows, urls: await signedUrls(rows) }
  }, [vehicle.id])
  const [progress, setProgress] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [run, busy] = useAction()
  const ref = useRef()
  const canEdit = can('vehicles', 'create')
  const canDelete = can('vehicles', 'delete')

  const upload = async (list) => {
    const files = Array.from(list || []).filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name))
    ref.current.value = ''
    if (!files.length) return
    let next = (data?.rows.reduce((m, r) => Math.max(m, r.sort_order), 0) || 0) + 1
    let ok = 0
    for (let i = 0; i < files.length; i++) {
      setProgress(`Enviando ${i + 1} de ${files.length}…`)
      try {
        const { blob, type, ext } = await shrink(files[i])
        const path = `${company.id}/vehicle/${vehicle.id}/photos/${Date.now()}-${i}.${ext}`
        const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: type })
        if (error) throw new Error(error.message)
        await q(supabase.from('attachments').insert({
          entity_type: 'vehicle', entity_id: vehicle.id, vehicle_id: vehicle.id, kind: 'photo',
          bucket: BUCKET, path, file_name: files[i].name, mime_type: type, size_bytes: blob.size, sort_order: next++,
        }))
        ok++
      } catch (e) {
        toast(`Não foi possível enviar ${files[i].name}: ${e.message}`, 'error')
      }
    }
    setProgress(null)
    if (ok) toast(ok === 1 ? '1 foto enviada' : `${ok} fotos enviadas`)
    reload()
    if (ok) onUploaded?.()
  }

  const makeCover = async (p) => {
    const min = data.rows.reduce((m, r) => Math.min(m, r.sort_order), 0)
    await run(() => q(supabase.from('attachments').update({ sort_order: min - 1 }).eq('id', p.id)), 'Foto de capa definida')
    reload()
  }
  const remove = async (p) => {
    if (!window.confirm('Apagar esta foto?')) return
    await run(async () => {
      await supabase.storage.from(BUCKET).remove([p.path])
      await q(supabase.from('attachments').delete().eq('id', p.id))
    }, 'Foto apagada')
    setViewer(null); reload()
  }

  const rows = data?.rows || []
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row between">
          <div>
            <h2>Fotos para venda</h2>
            <div className="muted small">{rows.length ? `${rows.length} foto(s). A primeira é a capa.` : 'Tire as fotos depois que o carro estiver pronto e limpo.'}</div>
          </div>
          <div className="row">
            {rows.length > 0 && <ShareAll rows={rows} urls={data.urls} vehicle={vehicle} />}
            {canEdit && (
              <label className="btn btn-primary" style={{ cursor: progress ? 'wait' : 'pointer' }}>
                <Icon name="plus" /> {progress || 'Adicionar fotos'}
                <input ref={ref} type="file" accept="image/*" multiple hidden disabled={Boolean(progress)} onChange={(e) => upload(e.target.files)} />
              </label>
            )}
          </div>
        </div>
      </div>

      {loading && !data ? <Spinner /> : rows.length === 0 ? (
        <div className="card"><Empty title="Nenhuma foto ainda">Pelo celular, o botão “Adicionar fotos” abre a câmera ou a galeria. Dá para escolher várias de uma vez.</Empty></div>
      ) : (
        <div className="photo-grid">
          {rows.map((p, i) => (
            <button key={p.id} type="button" className="photo-tile" onClick={() => setViewer(i)}>
              <img src={data.urls[p.id]} alt={`Foto ${i + 1}`} loading="lazy" />
              {i === 0 && <span className="photo-cover">Capa</span>}
            </button>
          ))}
        </div>
      )}

      {viewer !== null && rows[viewer] && (
        <Viewer rows={rows} urls={data.urls} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)}
          onCover={canEdit ? makeCover : null} onDelete={canDelete ? remove : null} busy={busy} vehicle={vehicle} />
      )}
    </div>
  )
}

async function toFiles(rows, urls, vehicle) {
  const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join('-').replace(/\s+/g, '-')
  return Promise.all(rows.map(async (p, i) => {
    const blob = await (await fetch(urls[p.id])).blob()
    const ext = blob.type === 'image/png' ? 'png' : 'jpg'
    return new File([blob], `${name}-${i + 1}.${ext}`, { type: blob.type || 'image/jpeg' })
  }))
}

async function shareOrDownload(rows, urls, vehicle, toast) {
  const files = await toFiles(rows, urls, vehicle)
  const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')
  if (navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files, title }) } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'error') }
    return
  }
  // computador: baixa os arquivos
  for (const f of files) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }
}

function ShareAll({ rows, urls, vehicle }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try { await shareOrDownload(rows, urls, vehicle, toast) } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  const mobileShare = typeof navigator !== 'undefined' && Boolean(navigator.canShare)
  return <button onClick={go} disabled={busy}>{busy ? 'Preparando…' : mobileShare ? 'Compartilhar todas' : 'Baixar todas'}</button>
}

function Viewer({ rows, urls, index, onIndex, onClose, onCover, onDelete, busy, vehicle }) {
  const toast = useToast()
  const touch = useRef(null)
  const go = (d) => onIndex((index + d + rows.length) % rows.length)
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowRight') go(1); if (e.key === 'ArrowLeft') go(-1) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const p = rows[index]
  return (
    <div className="viewer" onTouchStart={(e) => { touch.current = e.touches[0].clientX }}
      onTouchEnd={(e) => { const dx = e.changedTouches[0].clientX - (touch.current ?? 0); if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1) }}>
      <div className="viewer-top">
        <span>{index + 1} / {rows.length}</span>
        <div className="row" style={{ gap: 6 }}>
          <button className="btn-sm" onClick={() => shareOrDownload([p], urls, vehicle, toast)}>{navigator.canShare ? 'Compartilhar' : 'Baixar'}</button>
          {onCover && index !== 0 && <button className="btn-sm" onClick={() => onCover(p)} disabled={busy}>Usar como capa</button>}
          {onDelete && <button className="btn-sm btn-danger" onClick={() => onDelete(p)} disabled={busy}>Apagar</button>}
          <button className="btn-sm" onClick={onClose} aria-label="Fechar"><Icon name="close" /></button>
        </div>
      </div>
      <img src={urls[p.id]} alt={`Foto ${index + 1}`} />
      {rows.length > 1 && <>
        <button className="viewer-nav left" onClick={() => go(-1)} aria-label="Anterior"><Icon name="back" /></button>
        <button className="viewer-nav right" onClick={() => go(1)} aria-label="Próxima"><Icon name="back" /></button>
      </>}
    </div>
  )
}

// Capas para a lista de veículos: { vehicleId: signedUrl }
export async function loadCovers() {
  const rows = await q(supabase.from('attachments').select('id, entity_id, path, sort_order, created_at')
    .eq('entity_type', 'vehicle').eq('kind', 'photo').order('sort_order').order('created_at'))
  const first = {}
  for (const r of rows) if (!first[r.entity_id]) first[r.entity_id] = r
  const list = Object.values(first)
  const urls = await signedUrls(list)
  return Object.fromEntries(list.map((r) => [r.entity_id, urls[r.id]]))
}

// ---------------------------------------------------------------------------
// Fotos do leilão (baixadas do anúncio). Ficam separadas das fotos de venda:
// mostram o carro como foi comprado e não aparecem no site.
// ---------------------------------------------------------------------------
const pullKey = (id) => `carking:pull-photos:${id}`
export const requestPhotoPull = (id) => { try { sessionStorage.setItem(pullKey(id), '1') } catch { /* opcional */ } }

export function AuctionPhotos({ opportunityId, listingUrl, vehicle, title = 'Fotos do leilão', canPull = true }) {
  const { can } = useApp()
  const toast = useToast()
  const [viewer, setViewer] = useState(null)
  const [pulling, setPulling] = useState(false)
  const { data, loading, reload } = useLoad(async () => {
    const rows = await q(supabase.from('attachments').select('*').eq('entity_type', 'auction_opportunity')
      .eq('entity_id', opportunityId).eq('kind', 'photo').order('sort_order').order('created_at'))
    return { rows, urls: await signedUrls(rows) }
  }, [opportunityId])

  const pull = async () => {
    setPulling(true)
    try {
      const r = await callFunction('import-listing', { save_photos: opportunityId })
      if (r.error) throw new Error(r.error)
      if (r.already) toast('As fotos do leilão já estavam salvas.')
      else if (!r.found) toast('O anúncio não tem fotos para baixar.', 'error')
      else toast(`${r.saved} de ${r.found} foto(s) do leilão salvas`)
      reload()
    } catch (e) { toast(e.message, 'error') } finally { setPulling(false) }
  }

  // logo depois de importar pelo link, baixa automaticamente
  useEffect(() => {
    let flag = null
    try { flag = sessionStorage.getItem(pullKey(opportunityId)); sessionStorage.removeItem(pullKey(opportunityId)) } catch { /* opcional */ }
    if (flag && listingUrl) pull()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opportunityId])

  const rows = data?.rows || []
  if (!rows.length && !listingUrl && !pulling) return null
  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <h2>{title}</h2>
          <div className="muted small">{pulling ? 'Baixando as fotos do anúncio… pode levar alguns segundos.' : rows.length ? `${rows.length} foto(s) do anúncio. Não aparecem no site.` : 'Ainda não baixadas.'}</div>
        </div>
        {canPull && listingUrl && !rows.length && can('vehicles', 'create') && (
          <button className="btn-sm" onClick={pull} disabled={pulling}>{pulling ? 'Baixando…' : 'Puxar fotos do anúncio'}</button>
        )}
      </div>
      {loading && !data ? <Spinner /> : rows.length > 0 && (
        <div className="photo-grid">
          {rows.map((p, i) => (
            <button key={p.id} type="button" className="photo-tile" onClick={() => setViewer(i)}>
              <img src={data.urls[p.id]} alt={`Foto do leilão ${i + 1}`} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {viewer !== null && rows[viewer] && (
        <Viewer rows={rows} urls={data.urls} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} vehicle={vehicle} />
      )}
    </div>
  )
}
