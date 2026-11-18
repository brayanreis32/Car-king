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
async function loadAssets(fetchBytes) {
  if (!assets) {
    const [logo, a800, a500, meta] = await Promise.all([fetchBytes(`${ASSETS}/logo.png`), fetchBytes(`${ASSETS}/font-800.png`),
      fetchBytes(`${ASSETS}/font-500.png`), fetchBytes(`${ASSETS}/font.json`)])
    const m = JSON.parse(new TextDecoder().decode(meta))
    assets = {
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

async function coverSlide(photo, A, v, phone) {
  const img = new Image(W, H).fill(color(0, 0, 0))
  img.composite(coverImg(photo, W, 900), 0, 150)
  fade(img, 150, 330, false); fade(img, 860, 1050, true)
  const logo = fitWidth(A.logo, 480); center(img, logo, 34)
  center(img, await text(A.f800, 30, 'JUST ARRIVED', color(...GOLD)), 1072)
  center(img, await text(A.f800, 84, carTitle(v), color(255, 255, 255), 980), 1112)
  const sub = [v.trim, fmtMiles(v)].filter(Boolean).join('  ·  ')
  if (sub) center(img, await text(A.f500, 36, sub, color(201, 201, 197), 980), 1210)
  rect(img, 0, H - 70, W, 70, color(...GOLD))
  center(img, await text(A.f800, 32, `CALL / WHATSAPP ${phone || ''}`.trim(), color(17, 17, 17)), H - 56)
  return img
}
async function photoSlide(photo, A, n, total) {
  const img = coverImg(photo, W, H)
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
  center(img, await text(A.f500, 36, 'Call or WhatsApp for price', color(201, 201, 197)), 865)
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
    `📲 Call or WhatsApp${phone ? ` ${phone}` : ''} for price and availability`,
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
