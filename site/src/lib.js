// Funções compartilhadas do site: estoque, fotos, cards, formulários e menu
import { createClient } from '@supabase/supabase-js'
import { BUSINESS, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'
import './site.css'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})

// ---------- Formatação ----------
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
export const money = (v) => (v === null || v === undefined || v === '' || Number(v) <= 0 ? 'Call for price' : usd.format(Number(v)))
export const miles = (v) => (v === null || v === undefined ? '' : `${new Intl.NumberFormat('en-US').format(v)} mi`)
export const carName = (v) => [v.year, v.make, v.model].filter(Boolean).join(' ')
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
export const slug = (v) => [v.year, v.make, v.model, v.trim].filter(Boolean).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
export const carUrl = (v) => `./vehicle.html?id=${v.id}#${slug(v)}`

export const LABEL = {
  fuel_type: { gasoline: 'Gasoline', diesel: 'Diesel', hybrid: 'Hybrid', plug_in_hybrid: 'Plug-in hybrid', electric: 'Electric', flex: 'Flex fuel', other: 'Other' },
  transmission: { automatic: 'Automatic', manual: 'Manual', cvt: 'CVT automatic', dual_clutch: 'Dual-clutch', other: 'Other' },
  title_status: { clean: 'Clean title', rebuilt: 'Rebuilt title', salvage: 'Salvage title', flood: 'Flood title', lemon_buyback: 'Lemon buyback', other: 'See dealer', unknown: 'Ask dealer' },
}
export const titleBadge = (t) => (t && t !== 'clean' && t !== 'unknown' ? `<span class="badge badge-title">${esc(LABEL.title_status[t] || t)}</span>` : '')

// ---------- Estoque ----------
let inventoryPromise
export function getInventory() {
  if (!inventoryPromise) {
    inventoryPromise = supabase.rpc('public_inventory').then(({ data, error }) => {
      if (error) throw error
      return data || []
    })
    inventoryPromise.catch(() => { inventoryPromise = null })
  }
  return inventoryPromise
}
export async function getVehicle(id) {
  const { data, error } = await supabase.rpc('public_inventory', { p_vehicle_id: id })
  if (error) throw error
  return data?.[0] || null
}

// Links temporários das fotos (válidos por 1 dia)
export async function photoUrls(paths) {
  const list = [...new Set(paths.filter(Boolean))]
  if (!list.length) return {}
  const { data } = await supabase.storage.from('vehicle-media').createSignedUrls(list, 86400)
  return Object.fromEntries((data || []).filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl]))
}

const CAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17h14M3 13l2-6a2 2 0 0 1 2-1h10a2 2 0 0 1 2 1l2 6v5h-3v-2H6v2H3zM7 13h.01M17 13h.01"/></svg>'

// ---------- Tipos de carroceria ----------
export const STYLES = [
  ['suv', 'SUVs'], ['sedan', 'Sedans'], ['truck', 'Trucks'], ['hatchback', 'Hatchbacks'], ['van', 'Vans'], ['coupe', 'Coupes'],
]
// Silhuetas laterais simples (carroceria + vidros + rodas)
const SIL = {
  sedan: ['M6 33l2-7c1-3 4-4 8-4.5l20-2.5 13-8c2-1 4-1.5 7-1.5h17c4 0 6 1 8 3l9 9 13 2c4 .7 6 2.5 6 6v4z', 'M40 19.5l11-7h11v7zM66 12.5h12c2 0 3 .5 4 1.5l5 5.5H66z'],
  suv: ['M5 33l1-10c0-3 2-5 6-5.5l16-1.5 9-9c2-1.5 4-2 7-2h44c3 0 5 1 7 3l9 9c4 .5 7 2 7 6v10z', 'M30 16l8-8h13v8zM55 8h17v8H55zM76 8h11c2 0 3 .5 4 1.5l6 6.5H76z'],
  truck: ['M5 33V22h44v-2l6-10c1-1.5 3-2.5 5-2.5h18c2 0 3.5 1 4.5 2.5l7 12 19 1c3 .3 5 2 5 5v5z', 'M56 20l5-9h11v9zM76 11h6c1.5 0 2.5.5 3 1.5l4.5 7.5H76z'],
  hatchback: ['M10 33l1-8c1-3 3-4.5 7-5l13-1.5 13-9c2-1.5 4-2 7-2h21c3 0 5 1 7 3l10 11 5 1c3 .5 5 2.5 5 5.5v5z', 'M36 18.5l11-7.5h10v7.5zM61 11h11c2 0 3 .5 4 1.5l6 6H61z'],
  van: ['M5 33V11c0-4 2-6 6-6h68c4 0 6 1.5 8 4l13 12c4 .5 7 2 7 6v6z', 'M12 10h16v9H12zM32 10h18v9H32zM54 10h22c2 0 3 .5 4 1.5l8 7.5H54z'],
  coupe: ['M6 33l2-6c1-3 4-4 10-4.5l24-2 14-8c2-1 4-1.5 7-1.5h12c4 0 6 1.5 9 4l7 6 13 2c4 .7 6 2.5 6 6v4z', 'M45 20.5l12-7h10v7zM71 13.5h7c2 0 3 .5 4.5 2l4 4.5H71z'],
}
export function styleIcon(type) {
  const [body, glass] = SIL[type] || SIL.sedan
  const wheels = type === 'van' ? [26, 92] : type === 'truck' ? [22, 96] : [28, 94]
  return `<svg class="sil" viewBox="0 0 120 42" aria-hidden="true"><path class="sil-body" d="${body}"/><path class="sil-glass" d="${glass}"/>${wheels.map((x) => `<circle class="sil-tire" cx="${x}" cy="33" r="7.5"/><circle class="sil-rim" cx="${x}" cy="33" r="3.5"/>`).join('')}</svg>`
}
// Quando o carro ainda não tem tipo cadastrado, deduz pelo modelo
const MODEL_STYLE = {
  truck: /f-?150|f-?250|silverado|sierra|ram|tundra|tacoma|ranger|colorado|frontier|ridgeline|titan|gladiator|canyon|maverick|santa cruz/i,
  suv: /rogue|cr-?v|rav4|explorer|escape|equinox|tahoe|suburban|highlander|pilot|tucson|santa fe|sorento|sportage|cx-?\d|outback|forester|wrangler|cherokee|compass|edge|murano|pathfinder|x[1-7]\b|q[3-8]\b|gx|rx|nx|traverse|trailblazer|kicks|hr-?v|bronco|4runner|durango|journey|telluride|palisade|kona|venue|atlas|tiguan|terrain|acadia|blazer|encore|envision|enclave|ascent|crosstrek|patriot|renegade|seltos|soul/i,
  van: /odyssey|sienna|pacifica|caravan|transit|sprinter|promaster|carnival|sedona|express|savana|nv200|quest/i,
  hatchback: /fit|yaris|golf|versa note|fiesta|sonic|spark|mirage|veloster|prius|bolt|leaf|mini|rio 5|accent hatch|impreza hatch/i,
  coupe: /mustang|camaro|challenger|corvette|brz|86|370z|rc ?f|miata/i,
}
export function bodyOf(v) {
  if (v.body_style && v.body_style !== 'other') return v.body_style
  for (const [k, re] of Object.entries(MODEL_STYLE)) if (re.test(`${v.model || ''} ${v.trim || ''}`)) return k
  return 'sedan'
}

export function carCard(v, url) {
  const name = carName(v)
  const price = Number(v.price) > 0 ? Number(v.price) : 0
  const fee = Number(v.doc_fee) || 0
  return `<article class="card car">
    <a class="car-photo" href="${carUrl(v)}">${url ? `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy" />` : `<div class="no-photo">${CAR_ICON}<span>Photos coming soon</span></div>`}
      ${v.reserved ? '<span class="badge badge-reserved">Reserved</span>' : ''}</a>
    <div class="car-body">
      <div class="car-stock">${v.stock_number ? `Stock # ${esc(v.stock_number)}` : '&nbsp;'}</div>
      <h3><a href="${carUrl(v)}">${esc(name)}</a></h3>
      <div class="car-sub"><span>${esc(v.trim || '')}</span><span>${miles(v.mileage)}</span></div>
      <table class="price-table">
        ${price && fee ? `<tr><td>Vehicle Price</td><td>${money(price)}</td></tr>
        <tr class="small-row"><td>Dealer Documentation Fee</td><td>${money(fee)}</td></tr>
        <tr class="total"><td>Total with fees</td><td>${money(price + fee)}</td></tr>`
        : `<tr class="total"><td>Price</td><td>${money(price)}</td></tr>`}
      </table>
      ${titleBadge(v.title_status)}
      <a class="btn btn-gold btn-block" href="${carUrl(v)}#avail"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>Confirm availability</a>
    </div>
  </article>`
}

export async function renderCards(el, cars, emptyHtml) {
  if (!cars.length) { el.innerHTML = emptyHtml; return }
  el.innerHTML = cars.map((v) => carCard(v, null)).join('')
  try {
    const urls = await photoUrls(cars.map((v) => v.photos?.[0]))
    el.innerHTML = cars.map((v) => carCard(v, urls[v.photos?.[0]])).join('')
  } catch { /* sem fotos, mantém os cards */ }
}

export const loadError = (el) => {
  el.innerHTML = `<div class="empty">We couldn't load the inventory right now. ${BUSINESS.phone ? `Please call us at <a href="tel:${BUSINESS.phone.replace(/\D/g, '')}">${esc(BUSINESS.phone)}</a>.` : 'Please try again in a moment.'}</div>`
}

// ---------- Formulários (contatos vão para o sistema, em Clientes) ----------
export function bindLeadForm(form, { kind, vehicleId, details } = {}) {
  form.dataset.bound = '1'
  const msg = form.querySelector('.form-msg')
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(form))
    if (f.website) return // robô preencheu o campo escondido
    const btn = form.querySelector('[type=submit]')
    msg.className = 'form-msg'
    if (!String(f.name || '').trim()) { msg.textContent = 'Please enter your name.'; msg.classList.add('err'); return }
    if (!String(f.phone || '').trim() && !String(f.email || '').trim()) { msg.textContent = 'Please enter a phone number or e-mail so we can reach you.'; msg.classList.add('err'); return }
    const extra = typeof details === 'function' ? details(f) : (details || {})
    btn.disabled = true
    const { error } = await supabase.rpc('submit_website_lead', {
      p_kind: f.topic || kind || form.dataset.lead || 'contact',
      p_name: f.name, p_phone: f.phone || null, p_email: f.email || null,
      p_message: f.message || null, p_vehicle_id: f.vehicle_id || vehicleId || null, p_details: extra,
    })
    btn.disabled = false
    if (error) { msg.textContent = error.message || 'Something went wrong. Please call us.'; msg.classList.add('err'); return }
    form.reset()
    msg.textContent = 'Thank you! We received your message and will contact you shortly.'
    msg.classList.add('ok')
  })
}

// ---------- Menu ----------
export function initChrome(page) {
  document.querySelectorAll(`[data-nav="${page}"]`).forEach((a) => a.setAttribute('aria-current', 'page'))
  const btn = document.querySelector('.menu-btn')
  const nav = document.getElementById('mobile-nav')
  btn?.addEventListener('click', () => {
    const open = nav.hidden
    nav.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
  })
  document.querySelectorAll('form[data-lead]').forEach((f) => { if (!f.dataset.bound) bindLeadForm(f) })
}
