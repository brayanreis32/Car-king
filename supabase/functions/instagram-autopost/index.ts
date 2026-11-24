// @ts-nocheck
// CARKING — Edge Function "instagram-autopost"
// Roda sozinha a cada 5 minutos (agendada no banco). Procura carros "Pronto
// para venda" ou "Anunciado" com fotos de venda que ainda não foram postados,
// monta o carrossel com as artes da Car King (sem preço), escreve a legenda e
// publica no Instagram da loja. Não depende de ninguém estar com o sistema aberto.
//
// Segura para ser chamada por qualquer um: só posta carros já liberados para
// venda, uma vez por carro, e não devolve dados.
// Ao publicar: deixe "Verify JWT with legacy secret" DESLIGADO.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'
import { Image } from 'npm:imagescript@1.3.0'

const ASSETS = 'https://autosalescarking.com/ig'
const SITE = 'autosalescarking.com'
const W = 1080, H = 1350
const GOLD = [201, 161, 62]
const MAX_PER_RUN = 3
const SETTLE_MIN = 3   // espera 3 min depois da última foto/mudança, para pegar todas as fotos
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } })
const color = (r, g, b, a = 255) => Image.rgbaToColor(r, g, b, a)

// ---------------------------------------------------------------- artes
// @render-start
let assets
const ICON_NAMES = ['miles', 'title', 'trans', 'money']
async function loadAssets(fetchBytes) {
  if (!assets) {
    const [logo, a800, a500, meta, ...ic] = await Promise.all([fetchBytes(`${ASSETS}/logo.png`), fetchBytes(`${ASSETS}/font-800.png`),
      fetchBytes(`${ASSETS}/font-500.png`), fetchBytes(`${ASSETS}/font.json`), ...ICON_NAMES.map((n) => fetchBytes(`${ASSETS}/icon-${n}.png`))])
    const m = JSON.parse(new TextDecoder().decode(meta))
    const icons = {}
    for (let i = 0; i < ICON_NAMES.length; i++) icons[ICON_NAMES[i]] = await Image.decode(ic[i])
    assets = {
      icons,
      logo: await Image.decode(logo),
      f800: { atlas: await Image.decode(a800), ...m['800'], size: m.size, cache: {} },
      f500: { atlas: await Image.decode(a500), ...m['500'], size: m.size, cache: {} },
    }
  }
  return assets
}
function coverImg(img, w, h) {
  const s = Math.max(w / img.width, h / img.height)
  const r = img.clone().resize(Math.ceil(img.width * s), Math.ceil(img.height * s))
  return r.crop(Math.floor((r.width - w) / 2), Math.floor((r.height - h) / 2), w, h)
}
// Redimensiona com interpolação bilinear (a biblioteca só tem "vizinho mais próximo")
function smoothResize(src, w, h) {
  const out = new Image(w, h), sb = src.bitmap, ob = out.bitmap, sw = src.width, sh = src.height
  const fx = sw / w, fy = sh / h
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5)), y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5)), x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0
      const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4, c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4, o = (y * w + x) * 4
      for (let k = 0; k < 4; k++) {
        ob[o + k] = (sb[a + k] * (1 - tx) + sb[b + k] * tx) * (1 - ty) + (sb[c + k] * (1 - tx) + sb[d + k] * tx) * ty
      }
    }
  }
  return out
}
// Reduz em etapas de no máximo 2x (fica nítido, sem serrilhado)
function shrinkTo(img, w, h) {
  let cur = img
  while (cur.width / 2 > w && cur.height / 2 > h) cur = smoothResize(cur, Math.ceil(cur.width / 2), Math.ceil(cur.height / 2))
  return smoothResize(cur, w, h)
}
// Fundo feito da própria foto, ampliada e bem desfocada (e um pouco escurecida)
function blurBg(img, w, h) {
  const s = Math.max(w / img.width, h / img.height)
  const cw = Math.round(w / s), ch = Math.round(h / s)
  const crop = img.clone().crop(Math.floor((img.width - cw) / 2), Math.floor((img.height - ch) / 2), cw, ch)
  let cur = shrinkTo(crop, Math.ceil(w / 32), Math.ceil(h / 32))
  while (cur.width * 2 < w) cur = smoothResize(cur, cur.width * 2, cur.height * 2)
  const bg = smoothResize(cur, w, h), bm = bg.bitmap
  for (let i = 0; i < bm.length; i += 4) { bm[i] *= 0.62; bm[i + 1] *= 0.62; bm[i + 2] *= 0.62 }
  return bg
}
// Foto inteira dentro da caixa (sem cortar nada do carro)
function containImg(img, w, h) {
  const s = Math.min(w / img.width, h / img.height)
  return shrinkTo(img, Math.round(img.width * s), Math.round(img.height * s))
}
function fitWidth(img, w) { return img.clone().resize(w, Image.RESIZE_AUTO) }
// faixa de transição para preto (de cima para baixo ou ao contrário)
function fade(img, y0, y1, toBottom) {
  const bm = img.bitmap, W_ = img.width
  for (let y = y0; y < y1; y++) {
    let t = (y - y0) / (y1 - y0); if (!toBottom) t = 1 - t
    for (let x = 0; x < W_; x++) { const i = (y * W_ + x) * 4; bm[i] *= 1 - t; bm[i + 1] *= 1 - t; bm[i + 2] *= 1 - t }
  }
}
function rect(img, x, y, w, h, c) { img.composite(new Image(w, h).fill(c), x, y) }
// Texto montado a partir das letras da fonte (imagem gerada com a fonte Inter)
function glyph(f, ch) {
  if (!(ch in f.cache)) {
    const g = f.glyphs[ch]
    f.cache[ch] = g && g[1] ? f.atlas.clone().crop(g[0], 0, g[1], f.h) : null
  }
  return f.cache[ch]
}
async function text(f, size, str, rgba, maxW) {
  const chars = [...String(str)].map((c) => (f.glyphs[c] ? c : '?'))
  const width = Math.max(1, Math.ceil(chars.reduce((w, c) => w + f.glyphs[c][2], 0)) + 4)
  const img = new Image(width, f.h)
  let x = 2
  for (const c of chars) {
    const g = f.glyphs[c], gi = glyph(f, c)
    if (gi) img.composite(gi, Math.round(x + g[3]), 0)
    x += g[2]
  }
  let scale = size / f.size
  if (maxW && width * scale > maxW) scale = Math.max(24 / f.size, maxW / width)
  const out = img.resize(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(f.h * scale)))
  // pinta com a cor pedida, mantendo a transparência das letras
  const [r, g, b] = Image.colorToRGBA(rgba), bm = out.bitmap
  for (let i = 0; i < bm.length; i += 4) { bm[i] = r; bm[i + 1] = g; bm[i + 2] = b }
  return out
}
function center(img, part, y) { img.composite(part, Math.round((img.width - part.width) / 2), y) }

const carTitle = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')
const fmtMiles = (v) => (v.odometer ? `${new Intl.NumberFormat('en-US').format(v.odometer)} miles` : '')

// ---- primeira arte: estilo anúncio de concessionária ----
// Faixa dourada com bordas de pincel (mesmo desenho no sistema e no servidor)
const noise = (n) => { const x = Math.sin(n * 12.9898) * 43758.5453; return x - Math.floor(x) }
function brush(w, h, rgba, seed = 1) {
  const img = new Image(w + 60, h)
  const [r, g, b] = Image.colorToRGBA(rgba), bm = img.bitmap, IW = img.width
  for (let y = 0; y < h; y++) {
    const l = Math.round(6 + noise(y + seed) * 24 + (noise(y * 3 + seed) > 0.85 ? 14 : 0))
    const rr = Math.round(w + 54 - noise(y * 7 + seed * 5) * 24 - (noise(y * 5 + seed) > 0.85 ? 16 : 0))
    for (let x = Math.max(0, l); x < Math.min(IW, rr); x++) { const i = (y * IW + x) * 4; bm[i] = r; bm[i + 1] = g; bm[i + 2] = b; bm[i + 3] = 255 }
  }
  return img
}
// Texto com contorno preto grosso
async function outlined(f, size, str, rgba, maxW, stroke) {
  const t = await text(f, size, str, rgba, maxW)
  const k = await text(f, size, str, color(0, 0, 0), maxW)
  const out = new Image(t.width + stroke * 2, t.height + stroke * 2)
  for (let a = 0; a < 16; a++) {
    const ang = (a / 16) * Math.PI * 2
    out.composite(k, Math.round(stroke + Math.cos(ang) * stroke), Math.round(stroke + Math.sin(ang) * stroke))
  }
  out.composite(k, stroke, stroke * 2) // sombra
  out.composite(t, stroke, stroke)
  return out
}
// Escurece uma faixa (alpha 0..1), para o texto aparecer em qualquer foto
function shade(img, y0, y1, max, fromTop) {
  const bm = img.bitmap, IW = img.width
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    let t = (y - y0) / (y1 - y0); t = fromTop ? 1 - t : t
    const k = 1 - max * t
    for (let x = 0; x < IW; x++) { const i = (y * IW + x) * 4; bm[i] *= k; bm[i + 1] *= k; bm[i + 2] *= k }
  }
}
// Gira a imagem (graus, sentido anti-horário) sem cortar as bordas
function rotateImg(src, deg) {
  const a = (deg * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a)
  const w = src.width, h = src.height
  const W2 = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin)), H2 = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos))
  const out = new Image(W2, H2), sb = src.bitmap, ob = out.bitmap
  const cx = w / 2, cy = h / 2, ox = W2 / 2, oy = H2 / 2
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const dx = x - ox, dy = y - oy
      const sx = dx * cos - dy * sin + cx, sy = dx * sin + dy * cos + cy
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue
      const fx = sx - x0, fy = sy - y0, o = (y * W2 + x) * 4
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4
      const w00 = (1 - fx) * (1 - fy) * sb[i00 + 3], w10 = fx * (1 - fy) * sb[i10 + 3], w01 = (1 - fx) * fy * sb[i01 + 3], w11 = fx * fy * sb[i11 + 3]
      const al = w00 + w10 + w01 + w11
      if (al <= 0) continue
      for (let c = 0; c < 3; c++) ob[o + c] = (sb[i00 + c] * w00 + sb[i10 + c] * w10 + sb[i01 + c] * w01 + sb[i11 + c] * w11) / al
      ob[o + 3] = al
    }
  }
  return out
}
const money = (p) => `$${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(p)}`
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
async function coverSlide(photo, A, v, phone) {
  // carro inteiro: a foto entra completa e o resto é a própria foto desfocada
  const img = blurBg(photo, W, H)
  const ph = containImg(photo, W, 880)
  img.composite(ph, Math.round((W - ph.width) / 2), Math.max(250, 1150 - ph.height - 10))
  shade(img, 0, 520, 0.5, true)
  // logo no canto, numa aba preta
  const lg = fitWidth(A.logo, 290)
  rect(img, W - 330, 0, 330, lg.height + 36, color(0, 0, 0))
  rect(img, W - 330, lg.height + 36, 330, 4, color(...GOLD))
  img.composite(lg, W - 310, 18)

  // bloco do título, inclinado
  const block = new Image(900, 720)
  let y = 0
  if (v.year) {
    const t = await text(A.f800, 96, String(v.year), color(17, 17, 17))
    const br = brush(t.width + 30, Math.round(t.height * 0.8), color(...GOLD), 3)
    block.composite(br, 0, 6)
    block.composite(t, 42, Math.round(6 + (br.height - t.height) / 2))
    y = br.height + 4
  }
  for (const line of [v.make, v.model].filter(Boolean)) {
    const t = await outlined(A.f800, 132, String(line).toUpperCase(), color(255, 255, 255), 780, 7)
    block.composite(t, 6, y - 18)
    y += Math.round(t.height * 0.74)
  }
  if (v.trim) {
    const t = await outlined(A.f800, 64, String(v.trim).toUpperCase(), color(...GOLD), 780, 5)
    block.composite(t, 10, y - 6)
  }
  img.composite(rotateImg(block, 6), -20, 40)

  // preço
  const p = Number(v.price)
  if (p > 0) {
    const t = await text(A.f800, 128, money(p), color(17, 17, 17))
    const br = brush(t.width + 40, Math.round(t.height * 0.78), color(...GOLD), 9)
    const pb = new Image(br.width, br.height)
    pb.composite(br, 0, 0)
    pb.composite(t, 50, Math.round((br.height - t.height) / 2) + 2)
    const r = rotateImg(pb, 5)
    img.composite(r, W - r.width - 10, 1150 - r.height - 6)
  }

  // barra de informações
  const y0 = 1160, bh = 130
  rect(img, 0, y0, W, bh, color(0, 0, 0, 225))
  rect(img, 0, y0, W, 4, color(...GOLD))
  const facts = coverFacts(v), cw = Math.floor(W / facts.length)
  for (let i = 0; i < facts.length; i++) {
    const f = facts[i], x0 = i * cw
    if (i) rect(img, x0, y0 + 30, 3, bh - 60, color(...GOLD))
    const ic = A.icons[f.icon].clone().resize(54, 54)
    const a = await text(A.f800, 30, f.a, color(255, 255, 255), cw - 100)
    const b = await text(A.f500, 22, f.b, color(...GOLD), cw - 100)
    const tw = 54 + 12 + Math.max(a.width, b.width)
    const sx = x0 + Math.max(8, Math.round((cw - tw) / 2))
    img.composite(ic, sx, y0 + Math.round((bh - 54) / 2))
    img.composite(a, sx + 66, y0 + 24)
    img.composite(b, sx + 66, y0 + 66)
  }
  rect(img, 0, H - 60, W, 60, color(...GOLD))
  center(img, await text(A.f800, 30, `CALL / WHATSAPP ${phone || ''}`.trim(), color(17, 17, 17)), H - 50)
  return img
}
async function photoSlide(photo, A, n, total) {
  const img = blurBg(photo, W, H)
  const ph = containImg(photo, W, H)
  img.composite(ph, Math.round((W - ph.width) / 2), Math.round((H - ph.height) / 2))
  rect(img, W - 330, H - 120, 300, 90, color(0, 0, 0, 190))
  img.composite(fitWidth(A.logo, 270), W - 315, H - 112)
  rect(img, 30, 30, 110, 54, color(0, 0, 0, 160))
  const t = await text(A.f500, 28, `${n}/${total}`, color(255, 255, 255))
  img.composite(t, 85 - Math.round(t.width / 2), 42)
  return img
}
async function ctaSlide(A, phone) {
  const img = new Image(W, H).fill(color(0, 0, 0))
  center(img, fitWidth(A.logo, 800), 170)
  center(img, await text(A.f800, 64, 'IN-HOUSE FINANCING', color(...GOLD)), 560)
  center(img, await text(A.f500, 38, 'Weekly · Bi-weekly · Monthly payments', color(255, 255, 255)), 650)
  center(img, await text(A.f500, 38, 'First-time buyers welcome', color(255, 255, 255)), 705)
  rect(img, 240, 820, 600, 2, color(51, 51, 51))
  center(img, await text(A.f500, 36, 'Call or WhatsApp today', color(201, 201, 197)), 865)
  center(img, await text(A.f800, 72, phone || '', color(255, 255, 255)), 930)
  center(img, await text(A.f500, 38, SITE, color(...GOLD)), 1030)
  center(img, await text(A.f500, 32, 'Falamos Português · Hablamos Español', color(154, 154, 150)), 1170)
  return img
}
export async function buildSlides(photos, v, phone, fetchBytes) {
  const A = await loadAssets(fetchBytes)
  const imgs = await Promise.all(photos.slice(0, 8).map((b) => Image.decode(b)))
  const out = [await coverSlide(imgs[0], A, v, phone)]
  for (let i = 1; i < imgs.length; i++) out.push(await photoSlide(imgs[i], A, i + 1, imgs.length))
  out.push(await ctaSlide(A, phone))
  return Promise.all(out.map((im) => im.encodeJPEG(88)))
}

// ---------------------------------------------------------------- legenda (sem preço)
const TITLE = { clean: 'Clean title', rebuilt: 'Rebuilt title', salvage: 'Salvage title' }
const TRANS = { automatic: 'Automatic', manual: 'Manual', cvt: 'Automatic (CVT)', dual_clutch: 'Automatic' }
const OPENERS = ['🚗 {car} just arrived!', '👑 New in stock: {car}', '🔥 Ready to go: {car}', '✨ Fresh arrival at Car King: {car}']
const tag = (s) => `#${String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`
export function buildCaption(v, phone) {
  const car = [carTitle(v), v.trim].filter(Boolean).join(' ')
  const facts = [fmtMiles(v), TITLE[v.title_status], TRANS[v.transmission], v.color].filter(Boolean)
  return [
    OPENERS[Math.floor(Math.random() * OPENERS.length)].replace('{car}', car), '',
    facts.length ? `✅ ${facts.join(' · ')}` : null,
    '✅ Inspected and reconditioned',
    '💰 In-house financing available: weekly, bi-weekly or monthly payments', '',
    `📲 Call or WhatsApp${phone ? ` ${phone}` : ''} for availability and test drive`,
    `🌐 ${SITE}`, '',
    '🇧🇷 Falamos Português · 🇪🇸 Hablamos Español', '',
    ['#carkingautosales', '#usedcars', '#usedcarsforsale', '#massachusetts', '#buyherepayhere', '#financingavailable',
      tag(v.make), tag(`${v.make}${v.model}`), tag(v.model), '#carrosusadoseua', '#brasileirosnoseua'].join(' '),
  ].filter((l) => l !== null).join('\n')
}
// @render-end

// ---------------------------------------------------------------- Instagram
async function getJ(u, init) { const j = await (await fetch(u, init)).json(); if (j.error) throw new Error(j.error.error_user_msg || j.error.message || 'Erro do Instagram'); return j }
async function igAccount(token, savedId) {
  const t = encodeURIComponent(token)
  if (/^IG/.test(token)) {
    const base = 'https://graph.instagram.com/v23.0'
    const me = await getJ(`${base}/me?fields=user_id,username&access_token=${t}`)
    return { base, id: me.user_id || me.id }
  }
  const base = 'https://graph.facebook.com/v23.0'
  let id = savedId
  if (!id) {
    try { id = ((await getJ(`${base}/me/accounts?fields=instagram_business_account&access_token=${t}`)).data || []).find((p) => p.instagram_business_account)?.instagram_business_account?.id } catch { /* opcional */ }
  }
  if (!id) throw new Error('Informe o ID da conta do Instagram em Configurações.')
  return { base, id }
}
const post = (base, path, params) => getJ(`${base}/${path}`, { method: 'POST', body: new URLSearchParams(params) })
async function waitReady(base, id, at) {
  for (let i = 0; i < 15; i++) {
    const s = await getJ(`${base}/${id}?fields=status_code&access_token=${encodeURIComponent(at)}`)
    if (!s.status_code || s.status_code === 'FINISHED') return
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('O Instagram não conseguiu processar uma das imagens.')
    await new Promise((r) => setTimeout(r, 2000))
  }
}
async function publish(acct, at, urls, caption) {
  let creation
  if (urls.length === 1) {
    creation = (await post(acct.base, `${acct.id}/media`, { image_url: urls[0], caption, access_token: at })).id
  } else {
    const kids = []
    for (const u of urls) kids.push((await post(acct.base, `${acct.id}/media`, { image_url: u, is_carousel_item: 'true', access_token: at })).id)
    for (const k of kids) await waitReady(acct.base, k, at)
    creation = (await post(acct.base, `${acct.id}/media`, { media_type: 'CAROUSEL', children: kids.join(','), caption, access_token: at })).id
  }
  await waitReady(acct.base, creation, at)
  const pub = await post(acct.base, `${acct.id}/media_publish`, { creation_id: creation, access_token: at })
  let permalink = null
  try { permalink = (await getJ(`${acct.base}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(at)}`)).permalink } catch { /* opcional */ }
  return { id: pub.id, permalink }
}

// ---------------------------------------------------------------- rotina
Deno.serve(async () => {
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
  const fetchBytes = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer())
  const results = []
  try {
    const { data: cands, error } = await db.rpc('instagram_autopost_candidates', { p_settle_minutes: SETTLE_MIN, p_limit: MAX_PER_RUN })
    if (error) throw new Error(error.message)
    for (const c of cands || []) {
      // reserva o carro (evita postar duas vezes se duas rotinas rodarem juntas)
      const { data: lock, error: lockErr } = await db.from('instagram_posts').insert({ company_id: c.company_id, vehicle_id: c.vehicle_id, kind: 'for_sale', status: 'publishing' }).select('id').single()
      if (lockErr) { results.push({ vehicle: c.vehicle_id, skipped: 'locked' }); continue }
      try {
        const v = c.vehicle, phone = c.phone || '(781) 731-2486'
        const photos = []
        for (const p of c.photo_paths.slice(0, 8)) {
          const { data } = await db.storage.from('vehicle-media').download(p)
          if (data) photos.push(new Uint8Array(await data.arrayBuffer()))
        }
        if (!photos.length) throw new Error('sem fotos')
        const jpgs = await buildSlides(photos, v, phone, fetchBytes)
        const stamp = Date.now(), paths = []
        for (let i = 0; i < jpgs.length; i++) {
          const path = `${c.company_id}/instagram/${c.vehicle_id}/auto-${stamp}-${i + 1}.jpg`
          const { error: upErr } = await db.storage.from('vehicle-media').upload(path, jpgs[i], { contentType: 'image/jpeg' })
          if (upErr) throw new Error(upErr.message)
          paths.push(path)
        }
        const { data: signed } = await db.storage.from('vehicle-media').createSignedUrls(paths, 3600)
        const caption = buildCaption(v, phone)
        const acct = await igAccount(c.access_token, c.ig_user_id)
        const r = await publish(acct, c.access_token, signed.map((s) => s.signedUrl), caption)
        await db.from('instagram_posts').update({ status: 'published', caption, media_paths: paths, ig_media_id: r.id, permalink: r.permalink, error: null }).eq('id', lock.id)
        results.push({ vehicle: c.vehicle_id, ok: true })
      } catch (e) {
        await db.from('instagram_posts').update({ status: 'failed', error: String(e.message || e).slice(0, 300) }).eq('id', lock.id)
        results.push({ vehicle: c.vehicle_id, error: String(e.message || e) })
      }
    }
    return json({ ok: true, posted: results.filter((r) => r.ok).length, results: results.map((r) => ({ ok: !!r.ok, error: r.error || r.skipped || null })) })
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 200)
  }
})
