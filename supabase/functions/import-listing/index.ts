// @ts-nocheck — parser em JavaScript puro; tipos não verificados neste arquivo
// CARKING — Edge Function "import-listing"
// Lê o anúncio de um carro no site do leilão e devolve os campos já mapeados para
// o cadastro do Auction Analyzer. Também decodifica VIN pela base oficial NHTSA.
//
// POST { url }  -> importa do anúncio (Capital Auto Auction; outros sites: VIN + título)
// POST { vin }  -> decodifica o VIN (ano, marca, modelo, versão, combustível, câmbio)
// Só funciona para usuários logados no Car King.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// ============================================================================
// PARSER (JavaScript puro — testado também fora do Supabase)
// ============================================================================
// @parser-start
const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#039;': "'", '&#39;': "'", '&nbsp;': ' ', '&rsquo;': '’', '&lsquo;': '‘' }
function decode(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (e) => ENTITIES[e] ?? e)
}
function textLines(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, '')
  return decode(body.replace(/<[^>]+>/g, '\n')).split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean)
}
function titleCase(s) {
  if (!s) return s
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Bmw|Gmc|Ram|Suv|Awd|Fwd|Rwd|4wd|Amg|Gt|Gts|Ss|Rs|Se|Le|Xle|Lx|Ex|Exl|Ex-L|Sl|Sv|Sr|Sr5|Trd|Lt|Ls|Ltz|Xl|Xlt|Gl|Gls|Glx|Hd)\b/g, (m) => m.toUpperCase())
}
function parseDateUS(s) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s || '')
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null
}
const FUEL = { gas: 'gasoline', gasoline: 'gasoline', diesel: 'diesel', hybrid: 'hybrid', electric: 'electric', flex: 'flex', 'flexible fuel': 'flex', 'plug-in hybrid': 'plug_in_hybrid' }
function mapFuel(s) { if (!s) return null; const k = s.toLowerCase(); return FUEL[k] || (k.includes('hybrid') ? 'hybrid' : k.includes('elect') ? 'electric' : k.includes('flex') ? 'flex' : k.includes('diesel') ? 'diesel' : k.includes('gas') ? 'gasoline' : 'other') }
function mapTrans(s) { if (!s) return null; const k = s.toLowerCase(); return k.includes('cvt') ? 'cvt' : k.includes('auto') ? 'automatic' : k.includes('manual') ? 'manual' : k.includes('dual') ? 'dual_clutch' : 'other' }

// Área do relatório de condição -> área do sistema
function mapArea(label) {
  const k = label.toLowerCase()
  if (/bumper|front|hood|headl|grill|radiator/.test(k) && !/rear/.test(k)) return 'front'
  if (/rear|trunk|tail/.test(k)) return 'rear'
  if (/windshield|glass|window/.test(k)) return 'glass'
  if (/engine|check engine|motor|oil|coolant/.test(k)) return 'engine'
  if (/trans/.test(k)) return 'transmission'
  if (/brake|abs/.test(k)) return 'brakes'
  if (/susp|steer|align/.test(k)) return 'suspension'
  if (/batt|electr|lights|sensor|tpms/.test(k)) return 'electrical'
  if (/interior|seat|dash|mold|headliner/.test(k)) return 'interior'
  if (/tire/.test(k)) return 'tires'
  if (/wheel|rim/.test(k)) return 'wheels'
  if (/airbag|srs/.test(k)) return 'airbags'
  if (/roof/.test(k)) return 'roof'
  if (/frame|struct|unibody/.test(k)) return 'structure'
  if (/left|driver|\bl\b/.test(k) && /door|fender|quarter|side/.test(k)) return 'left_side'
  if (/right|passenger|\bp\b/.test(k) && /door|fender|quarter|side/.test(k)) return 'right_side'
  return 'other'
}

// Lê pares "Rótulo:" / "valor" a partir de um índice até um marcador de fim
function pairs(lines, from, stopRe) {
  const out = []
  for (let i = from; i < lines.length; i++) {
    const l = lines[i]
    if (stopRe.test(l)) break
    if (/:$/.test(l) && i + 1 < lines.length && !/:$/.test(lines[i + 1])) {
      out.push([l.slice(0, -1).trim(), lines[i + 1]]); i++
    }
  }
  return out
}

// Extrai um objeto JSON que começa logo após o marcador, contando chaves (respeita strings)
function extractJson(html, marker) {
  const i = html.indexOf(marker)
  if (i < 0) return null
  const start = i + marker.length
  if (html[start] !== '{') return null
  let depth = 0, inStr = false, esc = false
  for (let k = start; k < html.length; k++) {
    const c = html[k]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return html.slice(start, k + 1) }
  }
  return null
}

function parseCapital(html, url) {
  const lines = textLines(html)
  const at = (label) => { const i = lines.indexOf(label); return i >= 0 ? lines[i + 1] : null }
  const vi = lines.findIndex((l) => l === 'Vehicle Information:')
  const info = Object.fromEntries(pairs(lines, vi + 1, /^Condition Report:$|^Further Information$/).map(([k, v]) => [k.toLowerCase(), v]))
  const odoIdx = lines.findIndex((l) => l === 'Odo:')
  const odoNote = odoIdx >= 0 ? lines[odoIdx + 2] : null // ACTUAL / TMU / EXEMPT
  const ci = lines.findIndex((l) => l === 'Condition Report:')
  const condition = ci >= 0 ? pairs(lines, ci + 1, /^Further Information$|^Vehicle Options:$|^Quick Links$/) : []
  const fi = lines.findIndex((l) => l === 'Further Information')
  const fiEnd = lines.findIndex((l, i) => i > fi && /^Vehicle Options:$|^Quick Links$/.test(l))
  const further = fi >= 0 ? lines.slice(fi + 1, fiEnd > 0 ? fiEnd : fi + 12).join(' ').replace(/\s+,/g, ',') : ''
  const carfax = (/CARFAX NOTES:\s*(.*?)(?:TITLE ANNOUNCEMENTS:|BUYER AGREES|$)/.exec(further) || [])[1]?.trim() || null
  const titleAnn = (/TITLE ANNOUNCEMENTS:\s*(.*?)(?:BUYER AGREES|$)/.exec(further) || [])[1]?.trim() || null

  // dados embutidos (lance atual, buy now, sem título...)
  // a página tem mais de um bloco ":vehicle" (galeria, lances...): junta todos
  let embedded = {}
  for (let pos = html.indexOf(":vehicle='"); pos >= 0; pos = html.indexOf(":vehicle='", pos + 10)) {
    const raw = extractJson(html.slice(pos), ":vehicle='")
    if (!raw) continue
    try { Object.assign(embedded, JSON.parse(raw)) } catch { try { Object.assign(embedded, JSON.parse(decode(raw))) } catch { /* ignora */ } }
  }
  const sale = embedded.sale || {}

  // fotos
  let images = []
  const ld = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/i.exec(html)
  if (ld) { try { const j = JSON.parse(ld[1]); images = Array.isArray(j.image) ? j.image : j.image ? [j.image] : [] } catch { /* ignora */ } }

  const location = at('Location')
  const [city, state] = (location || '').split(',').map((s) => s.trim())
  const event = at('Event')
  const runNo = info['run#'] || (lines.find((l) => /^Run# ?\d+/.test(l)) || '').replace(/\D+/g, '') || null
  const status = (info['status'] || '').toLowerCase()
  const keysItem = condition.find(([k]) => /^keys?$/i.test(k))
  const ta = `${titleAnn || ''}`.toUpperCase()
  const title_status = embedded.parts_only ? 'parts_only'
    : embedded.no_title || /NO TITLE|BILL OF SALE/.test(ta) ? 'bill_of_sale_only'
      : /SALVAGE/.test(ta) ? 'salvage' : /REBUILT/.test(ta) ? 'rebuilt' : /CLEAN/.test(ta) ? 'clean' : 'unknown'
  const damages = condition
    .filter(([k]) => !/^(car|keys?|odometer|title)$/i.test(k))
    .map(([k, v]) => ({ area: mapArea(k), label: titleCase(k), description: `${titleCase(k)}: ${titleCase(v)}` }))

  const notes = [
    info['stock#'] && `Stock#: ${info['stock#']}`,
    info['type'] && `Tipo: ${info['type']}`, info['drive'] && `Tração: ${info['drive']}`, info['engine'] && `Motor: ${info['engine']}`,
    info['int color'] && `Interior: ${info['int color']}${info['int type'] ? ` (${info['int type']})` : ''}`,
    info['lights'] && `Luz do leilão: ${info['lights']}`,
    odoNote && `Odômetro: ${odoNote}`,
    sale.buy_now_price && Number(sale.buy_now_price) > 0 && `Buy now: $${Number(sale.buy_now_price)}`,
    sale.bid_increment && `Incremento de lance: $${sale.bid_increment}`,
    condition.length && `Relatório de condição: ${condition.map(([k, v]) => `${k}: ${v}`).join('; ')}`,
    carfax && `Carfax: ${carfax}`,
    titleAnn && `Título: ${titleAnn}`,
    embedded.dealer_only ? 'Somente dealers.' : null,
  ].filter(Boolean).join('\n')

  return {
    source_hint: /internet/i.test(event || '') ? 'online' : 'presencial',
    listing_url: url,
    auction_name: event,
    lot_number: runNo || info['stock#'] || null,
    auction_date: parseDateUS(at('Live Start')),
    location_city: city || null,
    location_state: state || null,
    vin: info['vin'] || null,
    year: info['year'] ? Number(info['year']) : null,
    make: titleCase(info['make']),
    model: titleCase(info['model']),
    trim: titleCase(info['trim']) || null,
    odometer: info['odo'] && /^\d+$/.test(info['odo']) && Number(info['odo']) > 0 ? Number(info['odo']) : null,
    color: titleCase(info['ext color']) || null,
    fuel_type: mapFuel(info['fuel type']),
    transmission: mapTrans(info['transmission']),
    run_condition: status === 'running' ? 'run_and_drive' : status.includes('not') ? 'does_not_start' : 'unknown',
    has_keys: keysItem ? !/(no|wrong|missing)/i.test(keysItem[1]) : null,
    title_status,
    primary_damage: damages[0]?.description || null,
    secondary_damage: damages[1]?.description || null,
    current_bid: sale.current_bid ? Number(sale.current_bid) : null,
    buy_now_price: sale.buy_now_price && Number(sale.buy_now_price) > 0 ? Number(sale.buy_now_price) : null,
    notes,
    damages,
    images,
  }
}

// Outros sites: tenta pelo menos VIN, ano/marca/modelo do título
function parseGeneric(html, url) {
  const title = decode((/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/i.exec(html) || /<title>([^<]*)<\/title>/i.exec(html) || [])[1] || '')
  const vin = (/\b([A-HJ-NPR-Z0-9]{17})\b/.exec(html.replace(/<[^>]+>/g, ' ')) || [])[1] || null
  const ymm = /\b(19[5-9]\d|20[0-4]\d)\s+([A-Za-z-]+)\s+([A-Za-z0-9-]+)/.exec(title)
  return {
    listing_url: url, vin,
    year: ymm ? Number(ymm[1]) : null, make: ymm ? titleCase(ymm[2]) : null, model: ymm ? titleCase(ymm[3]) : null,
    notes: title ? `Anúncio: ${title}` : '', damages: [], images: [],
  }
}

function parseListing(html, url) {
  const host = new URL(url).hostname.replace(/^www\./, '')
  if (host === 'capitalautoauction.com' && html.includes('Vehicle Information:')) return { site: 'capital', ...parseCapital(html, url) }
  return { site: 'generic', ...parseGeneric(html, url) }
}
// @parser-end

// ============================================================================
async function decodeVin(vin) {
  const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`)
  if (!r.ok) return null
  const d = (await r.json()).Results?.[0]
  if (!d || !d.ModelYear) return null
  return {
    vin, year: Number(d.ModelYear) || null, make: titleCase(d.Make) || null, model: d.Model || null,
    trim: d.Trim || d.Series || null, fuel_type: mapFuel(d.FuelTypePrimary),
    transmission: mapTrans(d.TransmissionStyle),
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const supa = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: { persistSession: false } })
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: { user } } = await supa.auth.getUser(token)
    if (!user) return json({ error: 'Faça login novamente.' }, 401)

    const body = await req.json()
    if (body.vin) {
      const v = String(body.vin).trim().toUpperCase()
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(v)) return json({ error: 'VIN inválido (17 caracteres, sem I, O ou Q).' }, 400)
      const data = await decodeVin(v)
      return data ? json({ data }) : json({ error: 'Não encontrei dados para este VIN.' }, 404)
    }

    let url: URL
    try { url = new URL(String(body.url ?? '').trim()) } catch { return json({ error: 'Link inválido.' }, 400) }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return json({ error: 'Link inválido.' }, 400)
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) return json({ error: 'Link não permitido.' }, 400)

    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept-Language': 'en-US,en' },
      redirect: 'follow',
    })
    if (!res.ok) return json({ error: `O site do leilão respondeu com erro ${res.status}. Alguns leilões (Copart, IAA) bloqueiam leitura automática.` }, 502)
    const html = (await res.text()).slice(0, 3_000_000)
    const data = parseListing(html, url.toString())

    // completa com a base oficial do VIN o que o anúncio não trouxe
    if (data.vin && (!data.year || !data.make || !data.model || !data.fuel_type || !data.transmission)) {
      try {
        const v = await decodeVin(data.vin)
        if (v) for (const k of Object.keys(v)) if (!data[k] && v[k]) data[k] = v[k]
      } catch { /* opcional */ }
    }
    if (!data.vin && !data.make) return json({ error: 'Não consegui ler os dados deste anúncio. Preencha manualmente ou use o botão do VIN.' }, 422)
    return json({ data })
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
