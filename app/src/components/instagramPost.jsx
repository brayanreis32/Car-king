// Post do Instagram para um carro à venda: monta o carrossel com as artes da
// Car King (preço na primeira arte), gera a legenda e publica (ou baixa para postar à mão).
import { useEffect, useState } from 'react'
import { callFunction, date, q, supabase } from '../lib.js'
import { Badge, Icon, Modal, Spinner, useToast } from './ui.jsx'
import { useApp } from '../App.jsx'
import { loadPhotos, signedUrls } from './photos.jsx'
import ICONS from './igIcons.json'

const W = 1080, H = 1350
const GOLD = '#C9A13E'
const SITE = 'autosalescarking.com'
const TITLE = { clean: 'Clean title', rebuilt: 'Rebuilt title', salvage: 'Salvage title' }
const TRANS = { automatic: 'Automatic', manual: 'Manual', cvt: 'Automatic (CVT)', dual_clutch: 'Automatic' }

const fmtMiles = (v) => (v ? `${new Intl.NumberFormat('en-US').format(v)} miles` : '')
const carTitle = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')
const tag = (s) => `#${String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`

// ---------- Legenda (o preço vai na primeira arte) ----------
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
    `📲 Call or WhatsApp${phone ? ` ${phone}` : ''} for availability and test drive`,
    `🌐 ${SITE}`,
    '',
    '🇧🇷 Falamos Português · 🇪🇸 Hablamos Español',
    '',
    ['#carkingautosales', '#usedcars', '#usedcarsforsale', '#massachusetts', '#buyherepayhere', '#financingavailable',
      tag(v.make), tag(`${v.make}${v.model}`), tag(v.model), '#carrosusadoseua', '#brasileirosnoseua'].filter((t) => t.length > 1).join(' '),
  ]
  return lines.filter((l) => l !== null).join('\n')
}

// Preço do carro (anunciado ou venda esperada): só na primeira arte
export const carPrice = (v) => {
  const p = Number(v.listed_price ?? v.expected_sale_price ?? v.price)
  return p > 0 ? `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(p)}` : ''
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
// Foto inteira (sem cortar o carro) sobre a própria foto desfocada
function blurBg(ctx, im) {
  ctx.save()
  ctx.filter = 'blur(40px) brightness(0.62)'
  if (ctx.filter.includes('blur')) {
    cover(ctx, im, -60, -60, W + 120, H + 120)
  } else {
    const t = document.createElement('canvas'); t.width = 45; t.height = 56
    cover(t.getContext('2d'), im, 0, 0, 45, 56)
    ctx.filter = 'none'; ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(t, -40, -40, W + 80, H + 80)
    ctx.fillStyle = 'rgba(0,0,0,0.38)'; ctx.fillRect(0, 0, W, H)
  }
  ctx.restore()
}
function contain(ctx, im, cx, top, bottom, maxW, maxH) {
  const s = Math.min(maxW / im.width, maxH / im.height)
  const w = im.width * s, h = im.height * s
  const y = top === null ? bottom - h : top
  ctx.drawImage(im, cx - w / 2, y, w, h)
}
function canvas() { const c = document.createElement('canvas'); c.width = W; c.height = H; return c }
function fitText(ctx, text, max, size, weight = 800) {
  let s = size
  do { ctx.font = `${weight} ${s}px Inter, Arial, sans-serif`; s -= 2 } while (ctx.measureText(text).width > max && s > 28)
}
function logoAt(ctx, logo, x, y, w) { ctx.drawImage(logo, x, y, w, w * logo.height / logo.width) }

// ---- primeira arte: estilo anúncio de concessionária (igual à do post automático) ----
const noise = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x) }
// faixa dourada com bordas de pincel, desenhada a partir de (x, y)
function brush(ctx, x, y, w, h, seed) {
  ctx.fillStyle = GOLD
  for (let r = 0; r < h; r++) {
    const l = 6 + noise(r + seed) * 24 + (noise(r * 3 + seed) > 0.85 ? 14 : 0)
    const rr = w + 54 - noise(r * 7 + seed * 5) * 24 - (noise(r * 5 + seed) > 0.85 ? 16 : 0)
    ctx.fillRect(x + l, y + r - 0.5, rr - l, 2)
  }
}
const font = (size, weight = 800) => `${weight} ${size}px Inter, Arial, sans-serif`
function fitFont(ctx, text, max, size, weight = 800) {
  let s = size
  do { ctx.font = font(s, weight); s -= 2 } while (ctx.measureText(text).width > max && s > 24)
}
function outlined(ctx, text, x, y, fill, stroke) {
  ctx.lineJoin = 'round'; ctx.strokeStyle = '#000'; ctx.lineWidth = stroke * 2
  ctx.fillStyle = '#000'; ctx.fillText(text, x, y + stroke) // sombra
  ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y)
}
function shade(ctx, y0, y1, max, fromTop) {
  const g = ctx.createLinearGradient(0, y0, 0, y1)
  g.addColorStop(0, `rgba(0,0,0,${fromTop ? max : 0})`); g.addColorStop(1, `rgba(0,0,0,${fromTop ? 0 : max})`)
  ctx.fillStyle = g; ctx.fillRect(0, y0, W, y1 - y0)
}
const TRANS_SHORT = { automatic: 'AUTOMATIC', cvt: 'AUTOMATIC', dual_clutch: 'AUTOMATIC', manual: 'MANUAL' }
const TITLE_SHORT = { clean: 'CLEAN', rebuilt: 'REBUILT', salvage: 'SALVAGE' }
function coverFacts(v) {
  return [
    v.odometer ? { icon: 'miles', a: new Intl.NumberFormat('en-US').format(v.odometer), b: 'MILES' } : null,
    TITLE_SHORT[v.title_status] ? { icon: 'title', a: TITLE_SHORT[v.title_status], b: 'TITLE' } : null,
    TRANS_SHORT[v.transmission] ? { icon: 'trans', a: TRANS_SHORT[v.transmission], b: 'TRANSMISSION' } : null,
    { icon: 'money', a: 'IN-HOUSE', b: 'FINANCING' },
  ].filter(Boolean)
}

function coverSlide(photo, logo, v, phone) {
  const c = canvas(), ctx = c.getContext('2d')
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H)
  // carro inteiro: a foto entra completa e o resto é a própria foto desfocada
  blurBg(ctx, photo)
  const s0 = Math.min(W / photo.width, 880 / photo.height)
  contain(ctx, photo, W / 2, Math.max(250, 1150 - photo.height * s0 - 10), null, W, 880)
  shade(ctx, 0, 520, 0.5, true)
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'

  // logo numa aba preta no canto
  const lw = 290, lh = lw * logo.height / logo.width
  ctx.fillStyle = '#000'; ctx.fillRect(W - 330, 0, 330, lh + 36)
  ctx.fillStyle = GOLD; ctx.fillRect(W - 330, lh + 36, 330, 4)
  ctx.drawImage(logo, W - 310, 18, lw, lh)

  // bloco do título, inclinado
  ctx.save()
  ctx.translate(30, 150); ctx.rotate(-6 * Math.PI / 180)
  let y = 0
  if (v.year) {
    ctx.font = font(96); const tw = ctx.measureText(String(v.year)).width
    brush(ctx, 0, y, tw + 30, 92, 3)
    ctx.fillStyle = '#111'; ctx.fillText(String(v.year), 42, y + 80)
    y += 96
  }
  for (const line of [v.make, v.model].filter(Boolean)) {
    const t = String(line).toUpperCase()
    fitFont(ctx, t, 780, 132)
    outlined(ctx, t, 12, y + 112, '#fff', 7)
    y += 120
  }
  if (v.trim) {
    const t = String(v.trim).toUpperCase()
    fitFont(ctx, t, 780, 64)
    outlined(ctx, t, 14, y + 56, GOLD, 5)
  }
  ctx.restore()

  // preço
  const price = carPrice(v)
  if (price) {
    ctx.save()
    ctx.font = font(128); const tw = ctx.measureText(price).width
    const bw = tw + 40, bh = 118
    ctx.translate(W - bw - 80, 1150 - bh - 40); ctx.rotate(-5 * Math.PI / 180)
    brush(ctx, 0, 0, bw, bh, 9)
    ctx.fillStyle = '#111'; ctx.fillText(price, 50, bh - 18)
    ctx.restore()
  }

  // barra de informações
  const y0 = 1160, bh = 130
  ctx.fillStyle = 'rgba(0,0,0,0.88)'; ctx.fillRect(0, y0, W, bh)
  ctx.fillStyle = GOLD; ctx.fillRect(0, y0, W, 4)
  const facts = coverFacts(v), cw = Math.floor(W / facts.length)
  facts.forEach((f, i) => {
    const x0 = i * cw
    if (i) { ctx.fillStyle = GOLD; ctx.fillRect(x0, y0 + 30, 3, bh - 60) }
    fitFont(ctx, f.a, cw - 100, 30); const aw = ctx.measureText(f.a).width
    ctx.font = font(22, 500); const bw = ctx.measureText(f.b).width
    const tw = 54 + 12 + Math.max(aw, bw)
    const sx = x0 + Math.max(8, Math.round((cw - tw) / 2))
    // ícone (traço branco)
    ctx.save(); ctx.translate(sx, y0 + (bh - 54) / 2); ctx.scale(54 / 24, 54 / 24)
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.9; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.stroke(new Path2D(ICONS[f.icon])); ctx.restore()
    fitFont(ctx, f.a, cw - 100, 30); ctx.fillStyle = '#fff'; ctx.fillText(f.a, sx + 66, y0 + 56)
    ctx.font = font(22, 500); ctx.fillStyle = GOLD; ctx.fillText(f.b, sx + 66, y0 + 92)
  })
  ctx.fillStyle = GOLD; ctx.fillRect(0, H - 60, W, 60)
  ctx.fillStyle = '#111'; ctx.font = font(30); ctx.textAlign = 'center'
  ctx.fillText(`CALL / WHATSAPP ${phone || ''}`.trim(), W / 2, H - 19)
  ctx.textAlign = 'left'
  return c
}
function photoSlide(photo, logo, n, total) {
  const c = canvas(), ctx = c.getContext('2d')
  blurBg(ctx, photo); contain(ctx, photo, W / 2, (H - photo.height * Math.min(W / photo.width, H / photo.height)) / 2, null, W, H)
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
  ctx.fillStyle = '#C9C9C5'; ctx.font = '500 36px Inter, Arial, sans-serif'; ctx.fillText('Call or WhatsApp today', W / 2, 900)
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
            <b className="small">Legenda (o preço aparece na primeira arte)</b>
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
  const forSale = posts.filter((p) => p.kind !== 'sold')
  const published = forSale.find((p) => p.status === 'published')
  const publishing = !published && forSale.find((p) => p.status === 'publishing')
  const lastFail = !published && !publishing && forSale.find((p) => p.status === 'failed')
  return (
    <div className="card row between">
      <div>
        <h2 style={{ margin: 0 }}>Instagram</h2>
        <div className="muted small">
          {published ? <>Postado em {date(published.created_at)}{published.permalink && <> · <a href={published.permalink} target="_blank" rel="noreferrer">ver post</a></>}</>
            : publishing ? 'Publicando no Instagram agora…'
            : lastFail ? <span className="neg">Não foi possível postar: {lastFail.error}. O sistema tenta de novo em 1 hora.</span>
            : ['ready_for_sale', 'listed'].includes(vehicle.status) ? 'Vai para o Instagram sozinho em até 5 minutos (precisa ter fotos de venda).'
            : 'Quando o carro ficar “Pronto para venda” ou “Anunciado”, o post sai sozinho.'}
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
  if (company?.ig_auto_post === false || !AUTO_STATUS.includes(vehicle.status) || running.has(vehicle.id)) return
  running.add(vehicle.id)
  try {
    const already = await q(supabase.from('instagram_posts').select('id').eq('vehicle_id', vehicle.id).eq('kind', 'for_sale').eq('status', 'published').limit(1))
    if (already.length) { toast?.('Instagram: este carro já foi postado.'); return }
    const rows = await loadPhotos(vehicle.id)
    if (!rows.length) { toast?.('Instagram: o post sai sozinho assim que você adicionar as fotos de venda.'); return }
    toast?.('Instagram: montando o post e publicando…')
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
    const r = await callFunction('instagram-publish', { vehicle_id: vehicle.id, paths, caption, auto: true, kind: 'for_sale' })
    if (!r.skipped) toast?.('Postado no Instagram automaticamente!')
  } catch (e) {
    toast?.(`Instagram: ${e.message}`, 'error')
  } finally { running.delete(vehicle.id) }
}

// ---------- Post da entrega (carro vendido) ----------
const SOLD_OPENERS = [
  (n, car) => `🔑 SOLD! Congratulations${n ? `, ${n},` : ''} on your ${car}!`,
  (n, car) => `🎉 Another happy customer!${n ? ` Congrats ${n}` : ' Congrats'} on the ${car}!`,
  (n, car) => `👑 Keys delivered!${n ? ` Enjoy your new ${car}, ${n}!` : ` Enjoy your new ${car}!`}`,
]
export function buildSoldCaption(v, firstName, phone, variant = 0) {
  const car = carTitle(v)
  return [
    SOLD_OPENERS[variant % SOLD_OPENERS.length](firstName, car),
    '',
    'Thank you for choosing Car King Auto Sales. 🙏',
    '',
    '🚗 Your next car is waiting for you.',
    '💰 In-house financing available: weekly, bi-weekly or monthly payments',
    `📲 Call or WhatsApp${phone ? ` ${phone}` : ''}`,
    `🌐 ${SITE}`,
    '',
    '🇧🇷 Falamos Português · 🇪🇸 Hablamos Español',
    '',
    ['#carkingautosales', '#sold', '#happycustomer', '#newcar', '#usedcars', '#massachusetts', '#buyherepayhere', tag(v.make), tag(`${v.make}${v.model}`), '#carrosusadoseua'].join(' '),
  ].join('\n')
}

function soldSlide(photo, logo, v, firstName, phone) {
  const c = canvas(), ctx = c.getContext('2d')
  cover(ctx, photo, 0, 0, W, H)
  let g = ctx.createLinearGradient(0, 0, 0, 230); g.addColorStop(0, 'rgba(0,0,0,.75)'); g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 230)
  g = ctx.createLinearGradient(0, 860, 0, H); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(.55, 'rgba(0,0,0,.85)'); g.addColorStop(1, 'rgba(0,0,0,.95)')
  ctx.fillStyle = g; ctx.fillRect(0, 860, W, H - 860)
  ctx.globalCompositeOperation = 'lighten'  // fundo preto da logo some sobre a foto
  logoAt(ctx, logo, 330, 30, 420)
  ctx.globalCompositeOperation = 'source-over'
  ctx.textAlign = 'center'
  // selo SOLD
  ctx.fillStyle = GOLD; ctx.beginPath(); ctx.roundRect(W / 2 - 150, 1000, 300, 76, 38); ctx.fill()
  ctx.fillStyle = '#111'; ctx.font = '800 46px Inter, Arial, sans-serif'; ctx.fillText('SOLD ✓', W / 2, 1054)
  ctx.fillStyle = '#fff'; const line = firstName ? `Congratulations, ${firstName}!` : 'Another happy customer!'
  fitText(ctx, line, 980, 64); ctx.fillText(line, W / 2, 1160)
  ctx.fillStyle = '#D9D9D5'; ctx.font = '500 38px Inter, Arial, sans-serif'
  ctx.fillText(carTitle(v), W / 2, 1222)
  ctx.fillStyle = '#9A9A96'; ctx.font = '500 28px Inter, Arial, sans-serif'
  ctx.fillText(`${SITE}  ·  ${phone || ''}`, W / 2, 1300)
  return c
}

export async function buildSoldSlides(photoUrl, v, firstName, phone) {
  await document.fonts?.load?.('800 40px Inter').catch?.(() => null)
  const logo = await loadImg('./logo-dark-lg.webp')
  const photo = await loadImg(photoUrl)
  return [soldSlide(photo, logo, v, firstName, phone), ctaSlide(logo, phone)]
}

// Envia a foto da entrega, monta as artes e publica (uma vez por venda)
export async function publishSold({ vehicle, company, file, firstName, toast }) {
  const phone = company.phone || '(781) 731-2486'
  const url = URL.createObjectURL(file)
  try {
    const slides = await buildSoldSlides(url, vehicle, firstName, phone)
    const caption = buildSoldCaption(vehicle, firstName, phone, Math.floor(Math.random() * SOLD_OPENERS.length))
    const stamp = Date.now(), paths = []
    for (let i = 0; i < slides.length; i++) {
      const path = `${company.id}/instagram/${vehicle.id}/sold-${stamp}-${i + 1}.jpg`
      const { error } = await supabase.storage.from('vehicle-media').upload(path, await toBlob(slides[i]), { contentType: 'image/jpeg' })
      if (error) throw new Error(error.message)
      paths.push(path)
    }
    if (company.ig_auto_post === false) {
      await q(supabase.from('instagram_posts').insert({ vehicle_id: vehicle.id, kind: 'sold', caption, media_paths: paths, status: 'downloaded' }))
      toast?.('Arte da entrega pronta. Post automático está desligado em Configurações.')
      return { slides, caption, posted: false }
    }
    const r = await callFunction('instagram-publish', { vehicle_id: vehicle.id, paths, caption, auto: true, kind: 'sold' })
    if (r.skipped) toast?.('Esta entrega já foi postada no Instagram.')
    else toast?.('Foto da entrega postada no Instagram!')
    return { slides, caption, posted: !r.skipped, permalink: r.permalink }
  } finally { URL.revokeObjectURL(url) }
}

// Quadro na aba Vender (depois da venda)
export function DeliveryPost({ vehicle, customerName }) {
  const { company, can } = useApp()
  const toast = useToast()
  const [posts, setPosts] = useState(null)
  const [showName, setShowName] = useState(true)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null)
  const reload = () => q(supabase.from('instagram_posts').select('*').eq('vehicle_id', vehicle.id).eq('kind', 'sold').order('created_at', { ascending: false })).then(setPosts).catch(() => setPosts([]))
  useEffect(() => { reload() }, [vehicle.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!can('vehicles', 'edit') || posts === null) return null
  const done = posts.find((p) => p.status === 'published')
  const firstName = (customerName || '').trim().split(/\s+/)[0] || ''
  const onFile = async (e) => {
    const file = e.target.files?.[0]; e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      const r = await publishSold({ vehicle, company, file, firstName: showName ? firstName : '', toast })
      setPreview(r.slides[0].toDataURL('image/jpeg', 0.8))
      reload()
    } catch (err) { toast(`Instagram: ${err.message}`, 'error') } finally { setBusy(false) }
  }
  return (
    <div className="card stack">
      <div className="row between">
        <div>
          <h2 style={{ margin: 0 }}>Foto da entrega</h2>
          <div className="muted small">
            {done ? <>Postada no Instagram em {date(done.created_at)}{done.permalink && <> · <a href={done.permalink} target="_blank" rel="noreferrer">ver post</a></>}</>
              : 'Tire uma foto do cliente segurando a chave. O sistema monta a arte “SOLD” e posta sozinho no Instagram.'}
          </div>
        </div>
        {done ? <Badge tone="success">Postada</Badge> : (
          <label className="btn btn-primary btn-sm" style={{ cursor: busy ? 'wait' : 'pointer' }}>
            <Icon name="plus" /> {busy ? 'Postando…' : 'Foto da entrega'}
            <input type="file" accept="image/*" capture="environment" hidden disabled={busy} onChange={onFile} />
          </label>
        )}
      </div>
      {!done && firstName && (
        <label className="check small"><input type="checkbox" checked={showName} onChange={(e) => setShowName(e.target.checked)} /> Cliente autorizou aparecer o primeiro nome ({firstName}) no post</label>
      )}
      {preview && <img src={preview} alt="Arte da entrega" style={{ width: 220, borderRadius: 8, border: '1px solid var(--border)' }} />}
    </div>
  )
}
