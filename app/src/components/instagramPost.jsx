// Post do Instagram para um carro à venda: monta o carrossel com as artes da
// Car King (sem preço), gera a legenda e publica (ou baixa para postar à mão).
import { useEffect, useState } from 'react'
import { callFunction, date, q, supabase } from '../lib.js'
import { Badge, Icon, Modal, Spinner, useToast } from './ui.jsx'
import { useApp } from '../App.jsx'
import { loadPhotos, signedUrls } from './photos.jsx'

const W = 1080, H = 1350
const GOLD = '#C9A13E'
const SITE = 'autosalescarking.com'
const TITLE = { clean: 'Clean title', rebuilt: 'Rebuilt title', salvage: 'Salvage title' }
const TRANS = { automatic: 'Automatic', manual: 'Manual', cvt: 'Automatic (CVT)', dual_clutch: 'Automatic' }

const fmtMiles = (v) => (v ? `${new Intl.NumberFormat('en-US').format(v)} miles` : '')
const carTitle = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')
const tag = (s) => `#${String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`

// ---------- Legenda (sem preço) ----------
const OPENERS = [
  (v) => `🚗 ${carTitle(v)}${v.trim ? ` ${v.trim}` : ''} just arrived!`,
  (v) => `👑 New in stock: ${carTitle(v)}${v.trim ? ` ${v.trim}` : ''}`,
  (v) => `🔥 Ready to go: ${carTitle(v)}${v.trim ? ` ${v.trim}` : ''}`,
  (v) => `✨ Fresh arrival at Car King: ${carTitle(v)}${v.trim ? ` ${v.trim}` : ''}`,
]
export function buildCaption(v, phone, variant = 0) {
  const facts = [fmtMiles(v.odometer), TITLE[v.title_status], TRANS[v.transmission], v.color].filter(Boolean)
  const lines = [
    OPENERS[variant % OPENERS.length](v),
    '',
    facts.length ? `✅ ${facts.join(' · ')}` : null,
    '✅ Inspected and reconditioned',
    '💰 In-house financing available: weekly, bi-weekly or monthly payments',
    '',
    `📲 Call or WhatsApp${phone ? ` ${phone}` : ''} for price and availability`,
    `🌐 ${SITE}`,
    '',
    '🇧🇷 Falamos Português · 🇪🇸 Hablamos Español',
    '',
    ['#carkingautosales', '#usedcars', '#usedcarsforsale', '#massachusetts', '#buyherepayhere', '#financingavailable',
      tag(v.make), tag(`${v.make}${v.model}`), tag(v.model), '#carrosusadoseua', '#brasileirosnoseua'].filter((t) => t.length > 1).join(' '),
  ]
  return lines.filter((l) => l !== null).join('\n')
}

// ---------- Artes ----------
const loadImg = (src) => new Promise((ok, fail) => {
  const im = new Image(); im.crossOrigin = 'anonymous'
  im.onload = () => ok(im); im.onerror = () => fail(new Error('Não consegui carregar uma foto.'))
  im.src = src
})
function cover(ctx, im, x, y, w, h) {
  const s = Math.max(w / im.width, h / im.height)
  const sw = w / s, sh = h / s
  ctx.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, y, w, h)
}
function canvas() { const c = document.createElement('canvas'); c.width = W; c.height = H; return c }
function fitText(ctx, text, max, size, weight = 800) {
  let s = size
  do { ctx.font = `${weight} ${s}px Inter, Arial, sans-serif`; s -= 2 } while (ctx.measureText(text).width > max && s > 28)
}
function logoAt(ctx, logo, x, y, w) { ctx.drawImage(logo, x, y, w, w * logo.height / logo.width) }

function coverSlide(photo, logo, v, phone) {
  const c = canvas(), ctx = c.getContext('2d')
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  cover(ctx, photo, 0, 150, W, 900)
  let g = ctx.createLinearGradient(0, 150, 0, 330); g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 150, W, 180)
  g = ctx.createLinearGradient(0, 860, 0, 1050); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,1)')
  ctx.fillStyle = g; ctx.fillRect(0, 860, W, 190)
  logoAt(ctx, logo, 300, 34, 480)
  ctx.fillStyle = GOLD; ctx.font = '700 30px Inter, Arial, sans-serif'; ctx.textAlign = 'center'
  ctx.fillText('JUST ARRIVED', W / 2, 1100)
  ctx.fillStyle = '#fff'; fitText(ctx, carTitle(v), 980, 84)
  ctx.fillText(carTitle(v), W / 2, 1185)
  ctx.fillStyle = '#C9C9C5'; ctx.font = '500 36px Inter, Arial, sans-serif'
  ctx.fillText([v.trim, fmtMiles(v.odometer)].filter(Boolean).join('  ·  '), W / 2, 1240)
  ctx.fillStyle = GOLD; ctx.fillRect(0, H - 70, W, 70)
  ctx.fillStyle = '#111'; ctx.font = '800 32px Inter, Arial, sans-serif'
  ctx.fillText(`CALL / WHATSAPP ${phone || ''}`.trim(), W / 2, H - 24)
  return c
}
function photoSlide(photo, logo, n, total) {
  const c = canvas(), ctx = c.getContext('2d')
  cover(ctx, photo, 0, 0, W, H)
  ctx.fillStyle = 'rgba(0,0,0,.72)'
  ctx.beginPath(); ctx.roundRect(W - 330, H - 120, 300, 90, 16); ctx.fill()
  logoAt(ctx, logo, W - 315, H - 112, 270)
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.beginPath(); ctx.roundRect(30, 30, 110, 54, 27); ctx.fill()
  ctx.fillStyle = '#fff'; ctx.font = '600 28px Inter, Arial, sans-serif'; ctx.textAlign = 'center'
  ctx.fillText(`${n}/${total}`, 85, 67)
  return c
}
function ctaSlide(logo, phone) {
  const c = canvas(), ctx = c.getContext('2d')
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  logoAt(ctx, logo, 140, 170, 800)
  ctx.textAlign = 'center'
  ctx.fillStyle = GOLD; ctx.font = '800 64px Inter, Arial, sans-serif'; ctx.fillText('IN-HOUSE FINANCING', W / 2, 620)
  ctx.fillStyle = '#fff'; ctx.font = '500 38px Inter, Arial, sans-serif'
  ctx.fillText('Weekly · Bi-weekly · Monthly payments', W / 2, 690)
  ctx.fillText('First-time buyers welcome', W / 2, 745)
  ctx.strokeStyle = '#333'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(240, 820); ctx.lineTo(840, 820); ctx.stroke()
  ctx.fillStyle = '#C9C9C5'; ctx.font = '500 36px Inter, Arial, sans-serif'; ctx.fillText('Call or WhatsApp for price', W / 2, 900)
  ctx.fillStyle = '#fff'; ctx.font = '800 72px Inter, Arial, sans-serif'; ctx.fillText(phone || '', W / 2, 990)
  ctx.fillStyle = GOLD; ctx.font = '600 38px Inter, Arial, sans-serif'; ctx.fillText(SITE, W / 2, 1060)
  ctx.fillStyle = '#9A9A96'; ctx.font = '500 32px Inter, Arial, sans-serif'
  ctx.fillText('Falamos Português · Hablamos Español', W / 2, 1200)
  return c
}

export async function buildSlides(photoUrls, v, phone) {
  await document.fonts?.load?.('800 40px Inter').catch?.(() => null)
  const logo = await loadImg('./logo-dark-lg.webp')
  const photos = await Promise.all(photoUrls.slice(0, 8).map(loadImg))
  const slides = [coverSlide(photos[0], logo, v, phone)]
  photos.slice(1).forEach((p, i) => slides.push(photoSlide(p, logo, i + 2, photos.length)))
  slides.push(ctaSlide(logo, phone))
  return slides
}
const toBlob = (c) => new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9))

// ---------- Tela ----------
export function InstagramPostModal({ vehicle, onClose }) {
  const { company } = useApp()
  const toast = useToast()
  const phone = company.phone || '(781) 731-2486'
  const [variant, setVariant] = useState(() => Math.floor(Math.random() * OPENERS.length))
  const [caption, setCaption] = useState(() => buildCaption(vehicle, phone, variant))
  const [slides, setSlides] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const rows = await loadPhotos(vehicle.id)
        if (!rows.length) throw new Error('Este carro ainda não tem fotos de venda. Adicione na aba Fotos.')
        const urls = await signedUrls(rows)
        const s = await buildSlides(rows.map((r) => urls[r.id]), vehicle, phone)
        if (alive) setSlides(s.map((c) => ({ c, url: c.toDataURL('image/jpeg', 0.85) })))
      } catch (e) { if (alive) setErr(e.message) }
    })()
    return () => { alive = false }
  }, [vehicle.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const name = [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join('-').replace(/\s+/g, '-')
  const download = async () => {
    for (let i = 0; i < slides.length; i++) {
      const a = document.createElement('a'); a.href = slides[i].url; a.download = `${name}-${i + 1}.jpg`
      document.body.appendChild(a); a.click(); a.remove()
      await new Promise((r) => setTimeout(r, 250))
    }
    try { await navigator.clipboard.writeText(caption) } catch { /* opcional */ }
    await q(supabase.from('instagram_posts').insert({ vehicle_id: vehicle.id, caption, status: 'downloaded' })).catch(() => null)
    toast('Artes baixadas e legenda copiada. É só postar pelo celular.')
  }
  const publish = async () => {
    setBusy(true)
    try {
      const stamp = Date.now()
      const paths = []
      for (let i = 0; i < slides.length; i++) {
        const path = `${company.id}/instagram/${vehicle.id}/${stamp}-${i + 1}.jpg`
        const { error } = await supabase.storage.from('vehicle-media').upload(path, await toBlob(slides[i].c), { contentType: 'image/jpeg' })
        if (error) throw new Error(error.message)
        paths.push(path)
      }
      const r = await callFunction('instagram-publish', { vehicle_id: vehicle.id, paths, caption })
      setDone(r.permalink || true)
      toast('Publicado no Instagram!')
    } catch (e) { toast(e.message, 'error') } finally { setBusy(false) }
  }
  const newCaption = () => { const n = variant + 1; setVariant(n); setCaption(buildCaption(vehicle, phone, n)) }

  return (
    <Modal title="Post do Instagram" onClose={onClose}
      footer={done ? <button className="btn-primary" onClick={onClose}>Fechar</button> : <>
        <button onClick={download} disabled={!slides || busy}>Baixar artes</button>
        <button className="btn-primary" onClick={publish} disabled={!slides || busy || !caption.trim()}>{busy ? 'Publicando…' : 'Publicar no Instagram'}</button>
      </>}>
      {done ? (
        <div className="alert-box success">Publicado no @carkingautosales! {typeof done === 'string' && <a href={done} target="_blank" rel="noreferrer">Ver o post</a>}</div>
      ) : (
        <div className="stack">
          {err ? <div className="alert-box error">{err}</div> : !slides ? <div className="row"><Spinner /> <span className="muted small">Montando as artes…</span></div> : (
            <div className="ig-preview">
              {slides.map((s, i) => <img key={i} src={s.url} alt={`Arte ${i + 1}`} />)}
            </div>
          )}
          <div className="row between">
            <b className="small">Legenda (sem preço: o cliente chama para saber)</b>
            <button type="button" className="btn-ghost btn-sm" onClick={newCaption}>Outra legenda</button>
          </div>
          <textarea rows={9} value={caption} onChange={(e) => setCaption(e.target.value)} />
          <p className="small muted" style={{ margin: 0 }}>
            “Publicar” posta direto no Instagram (precisa do Instagram conectado em Configurações).
            Sem conexão, use “Baixar artes”: as imagens são baixadas e a legenda fica copiada para colar no app.
          </p>
        </div>
      )}
    </Modal>
  )
}

// Quadro na aba Fotos do veículo
export function InstagramCard({ vehicle }) {
  const { can } = useApp()
  const [open, setOpen] = useState(false)
  const [posts, setPosts] = useState([])
  const reload = () => q(supabase.from('instagram_posts').select('*').eq('vehicle_id', vehicle.id).order('created_at', { ascending: false })).then(setPosts).catch(() => setPosts([]))
  useEffect(() => { reload() }, [vehicle.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!can('vehicles', 'edit')) return null
  const published = posts.find((p) => p.status === 'published')
  return (
    <div className="card row between">
      <div>
        <h2 style={{ margin: 0 }}>Instagram</h2>
        <div className="muted small">
          {published ? <>Postado em {date(published.created_at)}{published.permalink && <> · <a href={published.permalink} target="_blank" rel="noreferrer">ver post</a></>}</>
            : 'Carrossel com as artes da Car King e legenda pronta, sem o preço.'}
        </div>
      </div>
      <div className="row">
        {published ? <Badge tone="success">Postado</Badge> : null}
        <button className={published ? 'btn-sm' : 'btn-primary btn-sm'} onClick={() => setOpen(true)}><Icon name="plus" /> {published ? 'Postar de novo' : 'Criar post'}</button>
      </div>
      {open && <InstagramPostModal vehicle={vehicle} onClose={() => { setOpen(false); reload() }} />}
    </div>
  )
}


// ---------- Publicação 100% automática ----------
// Chamada quando o carro vira "Pronto para venda"/"Anunciado" ou quando ganha
// a primeira foto nesse status. Posta uma vez só por carro.
const AUTO_STATUS = ['ready_for_sale', 'listed']
let running = new Set()
export async function autoPublish(vehicle, company, toast) {
  if (!company?.ig_auto_post || !AUTO_STATUS.includes(vehicle.status) || running.has(vehicle.id)) return
  running.add(vehicle.id)
  try {
    const already = await q(supabase.from('instagram_posts').select('id').eq('vehicle_id', vehicle.id).eq('status', 'published').limit(1))
    if (already.length) return
    const rows = await loadPhotos(vehicle.id)
    if (!rows.length) { toast?.('Instagram: o post sai sozinho assim que você adicionar as fotos de venda.'); return }
    const phone = company.phone || '(781) 731-2486'
    const urls = await signedUrls(rows)
    const slides = await buildSlides(rows.map((r) => urls[r.id]), vehicle, phone)
    const caption = buildCaption(vehicle, phone, Math.floor(Math.random() * OPENERS.length))
    const stamp = Date.now(), paths = []
    for (let i = 0; i < slides.length; i++) {
      const path = `${company.id}/instagram/${vehicle.id}/${stamp}-${i + 1}.jpg`
      const { error } = await supabase.storage.from('vehicle-media').upload(path, await toBlob(slides[i]), { contentType: 'image/jpeg' })
      if (error) throw new Error(error.message)
      paths.push(path)
    }
    const r = await callFunction('instagram-publish', { vehicle_id: vehicle.id, paths, caption, auto: true })
    if (!r.skipped) toast?.('Postado no Instagram automaticamente!')
  } catch (e) {
    toast?.(`Instagram: ${e.message}`, 'error')
  } finally { running.delete(vehicle.id) }
}
