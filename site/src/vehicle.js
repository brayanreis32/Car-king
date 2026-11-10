import { BUSINESS } from './config.js'
import { bindLeadForm, carName, esc, getVehicle, initChrome, LABEL, miles, money, photoUrls } from './lib.js'

const root = document.getElementById('car')
const id = new URLSearchParams(location.search).get('id')

function notFound() {
  root.innerHTML = `<div class="empty big"><h1>This vehicle is no longer available</h1>
    <p>It may have been sold. <a href="./inventory.html">See our current inventory</a>.</p></div>`
  document.title = `Vehicle not available · ${BUSINESS.name}`
  initChrome('inventory')
}

async function main() {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return notFound()
  let v
  try { v = await getVehicle(id) } catch { root.innerHTML = '<div class="empty">We could not load this vehicle. Please try again.</div>'; return initChrome('inventory') }
  if (!v) return notFound()

  const name = carName(v)
  const full = [name, v.trim].filter(Boolean).join(' ')
  root.replaceChildren(document.getElementById('car-tpl').content.cloneNode(true))
  document.title = `${full} for sale · ${money(v.price)} · ${BUSINESS.name}`
  setMeta('description', `${full}${v.mileage ? `, ${miles(v.mileage)}` : ''} for sale at ${BUSINESS.name}. ${money(v.price)}. Photos, details and financing.`)
  setMeta('og:title', `${full} · ${money(v.price)}`, 'property')

  root.querySelector('.vd-title').textContent = name
  root.querySelector('.vd-trim').textContent = [v.trim, miles(v.mileage)].filter(Boolean).join(' · ')
  root.querySelector('.vd-price').textContent = money(v.price)
  const badges = []
  if (v.reserved) badges.push('<span class="badge badge-reserved">Reserved · ask about availability</span>')
  if (v.title_status && v.title_status !== 'clean' && v.title_status !== 'unknown') badges.push(`<span class="badge badge-title">${esc(LABEL.title_status[v.title_status] || v.title_status)}</span>`)
  root.querySelector('.vd-badges').innerHTML = badges.join('')

  const specs = [
    ['Year', v.year], ['Make', v.make], ['Model', v.model], ['Trim', v.trim],
    ['Mileage', miles(v.mileage)], ['Exterior color', v.color],
    ['Transmission', LABEL.transmission[v.transmission]], ['Fuel', LABEL.fuel_type[v.fuel_type]],
    ['Title', LABEL.title_status[v.title_status]], ['VIN', v.vin], ['Stock #', v.stock_number],
  ].filter(([, val]) => val)
  root.querySelector('.specs').innerHTML = specs.map(([k, val]) => `<div><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('')
  if (['rebuilt', 'salvage', 'flood'].includes(v.title_status)) {
    root.querySelector('.title-note').textContent = 'This vehicle has a branded title. It was repaired and inspected. Ask us for the repair history and photos before purchase.'
  }

  // links com o carro já escolhido
  root.querySelector('#apply').href = `./financing.html?vehicle=${v.id}`
  const wa = root.querySelector('#wa')
  if (wa) wa.href += `?text=${encodeURIComponent(`Hi! I'm interested in the ${full}${v.stock_number ? ` (stock ${v.stock_number})` : ''}. Is it still available?`)}`

  // formulário de disponibilidade
  const form = root.querySelector('#avail')
  bindLeadForm(form, { kind: 'availability', vehicleId: v.id })
  initChrome('inventory')

  // calculadora
  const calc = root.querySelector('#calc')
  calc.price.value = Number(v.price) > 0 ? Math.round(v.price) : ''
  calc.down.value = Number(v.price) > 0 ? Math.round(v.price * 0.2 / 100) * 100 : ''
  const out = root.querySelector('#calc-out')
  const update = () => {
    const P = Math.max(0, Number(calc.price.value || 0) - Number(calc.down.value || 0))
    const n = Number(calc.term.value)
    const r = Number(calc.apr.value || 0) / 100 / 12
    const pay = !P ? 0 : r ? (P * r) / (1 - (1 + r) ** -n) : P / n
    out.textContent = pay ? `$${pay.toFixed(2)}/mo` : '—'
  }
  calc.addEventListener('input', update)
  update()

  // fotos
  const gallery = root.querySelector('.gallery')
  const img = root.querySelector('#g-img')
  img.alt = full
  const paths = v.photos || []
  if (!paths.length) {
    gallery.classList.add('no-photos')
    gallery.querySelector('.g-main').innerHTML = '<div class="no-photo big"><span>Photos coming soon</span></div>'
  } else {
    const urls = await photoUrls(paths)
    const list = paths.map((p) => urls[p]).filter(Boolean)
    let i = 0
    const thumbs = root.querySelector('.g-thumbs')
    thumbs.innerHTML = list.map((u, k) => `<button type="button" data-k="${k}" aria-label="Photo ${k + 1}"><img src="${esc(u)}" alt="" loading="lazy" /></button>`).join('')
    const show = (k) => {
      i = (k + list.length) % list.length
      img.src = list[i]
      root.querySelector('.g-count').textContent = `${i + 1} / ${list.length}`
      thumbs.querySelectorAll('button').forEach((b, n) => b.classList.toggle('on', n === i))
    }
    thumbs.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(Number(b.dataset.k)) })
    root.querySelector('.g-prev').onclick = () => show(i - 1)
    root.querySelector('.g-next').onclick = () => show(i + 1)
    if (list.length < 2) gallery.classList.add('single')
    let x0 = null
    img.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX }, { passive: true })
    img.addEventListener('touchend', (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1)); x0 = null })
    document.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') show(i + 1); if (e.key === 'ArrowLeft') show(i - 1) })
    show(0)
  }

  // dados estruturados para o Google
  const ld = {
    '@context': 'https://schema.org', '@type': 'Car', name: full, brand: { '@type': 'Brand', name: v.make }, model: v.model,
    vehicleModelDate: String(v.year), ...(v.vin && { vehicleIdentificationNumber: v.vin }), ...(v.color && { color: v.color }),
    ...(v.mileage && { mileageFromOdometer: { '@type': 'QuantitativeValue', value: v.mileage, unitCode: 'SMI' } }),
    itemCondition: 'https://schema.org/UsedCondition',
    ...(Number(v.price) > 0 && { offers: { '@type': 'Offer', price: Number(v.price), priceCurrency: 'USD', availability: 'https://schema.org/InStock', seller: { '@type': 'AutoDealer', name: BUSINESS.name } } }),
  }
  const s = document.createElement('script')
  s.type = 'application/ld+json'
  s.textContent = JSON.stringify(ld)
  document.head.appendChild(s)
}

function setMeta(name, content, attr = 'name') {
  let m = document.head.querySelector(`meta[${attr}="${name}"]`)
  if (!m) { m = document.createElement('meta'); m.setAttribute(attr, name); document.head.appendChild(m) }
  m.setAttribute('content', content)
}

main()
