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

export function carCard(v, url) {
  const name = carName(v)
  return `<a class="card car" href="${carUrl(v)}">
    <div class="car-photo">${url ? `<img src="${esc(url)}" alt="${esc(name)}" loading="lazy" />` : `<div class="no-photo">${CAR_ICON}<span>Photos coming soon</span></div>`}
      ${v.reserved ? '<span class="badge badge-reserved">Reserved</span>' : ''}</div>
    <div class="car-body">
      <h3>${esc(name)}</h3>
      <div class="car-trim">${esc(v.trim || '')}</div>
      <div class="car-meta">${[miles(v.mileage), v.stock_number ? `Stock ${esc(v.stock_number)}` : ''].filter(Boolean).join(' · ')}</div>
      <div class="car-foot"><span class="price">${money(v.price)}</span>${titleBadge(v.title_status)}</div>
    </div>
  </a>`
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
