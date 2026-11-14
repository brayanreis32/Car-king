import { carName, matchStyle, esc, getInventory, initChrome, loadError, renderCards } from './lib.js'

initChrome('inventory')

const form = document.getElementById('filters')
const list = document.getElementById('list')
const count = document.getElementById('count')
const params = new URLSearchParams(location.search)
for (const k of ['q', 'type', 'make', 'max', 'sort']) if (params.get(k) && form.elements[k]) form.elements[k].value = params.get(k)

let cars = []
const SORT = {
  new: (a, b) => String(b.sort_date).localeCompare(String(a.sort_date)),
  price_asc: (a, b) => (Number(a.price) || 1e9) - (Number(b.price) || 1e9),
  price_desc: (a, b) => (Number(b.price) || 0) - (Number(a.price) || 0),
  miles: (a, b) => (a.mileage ?? 1e9) - (b.mileage ?? 1e9),
  year: (a, b) => b.year - a.year,
}

function apply() {
  const f = Object.fromEntries(new FormData(form))
  const terms = String(f.q || '').toLowerCase().split(/\s+/).filter(Boolean)
  const rows = cars.filter((v) => {
    const text = `${carName(v)} ${v.trim || ''} ${v.color || ''}`.toLowerCase()
    if (terms.some((t) => !text.includes(t))) return false
    if (f.type && !matchStyle(v, f.type)) return false
    if (f.make && v.make !== f.make) return false
    if (f.max && !(Number(v.price) > 0 && Number(v.price) <= Number(f.max))) return false
    return true
  }).sort(SORT[f.sort] || SORT.new)
  const qs = new URLSearchParams(Object.entries(f).filter(([k, v]) => v && !(k === 'sort' && v === 'new')))
  history.replaceState(null, '', qs.toString() ? `?${qs}` : location.pathname)
  count.textContent = `${rows.length} vehicle${rows.length === 1 ? '' : 's'} ${rows.length === cars.length ? 'for sale' : `of ${cars.length} match your search`}`
  renderCards(list, rows, cars.length
    ? '<div class="empty">No vehicles match your search. <button type="button" class="link-btn" id="clear">Clear filters</button></div>'
    : '<div class="empty">Our next cars are being prepared. <a href="./contact.html">Tell us what you are looking for</a> and we will contact you.</div>')
}

list.addEventListener('click', (e) => { if (e.target.id === 'clear') { form.reset(); apply() } })
form.addEventListener('input', apply)
form.addEventListener('submit', (e) => { e.preventDefault(); apply() })

getInventory().then((data) => {
  cars = data
  const makes = [...new Set(cars.map((v) => v.make))].sort()
  form.elements.make.insertAdjacentHTML('beforeend', makes.map((m) => `<option>${esc(m)}</option>`).join(''))
  if (params.get('make')) form.elements.make.value = params.get('make')
  apply()
}).catch(() => { count.textContent = ''; loadError(list) })
