import { bodyOf, esc, getInventory, initChrome, loadError, renderCards, STYLES, supabase } from './lib.js'

initChrome('home')

// Browse by Style: sempre mostra os tipos principais (com a quantidade no estoque)
const stylesEl = document.getElementById('styles')
// tipos que já têm imagem em public/styles/<tipo>.png
const STYLE_IMAGES = []
const drawStyles = (cars = []) => {
  const count = (k) => cars.filter((v) => bodyOf(v) === k).length
  stylesEl.innerHTML = STYLES.map(([k, label]) => `<a class="style-tile" href="./inventory.html?type=${k}">
    <img src="./styles/${k}.png" alt="" loading="lazy" width="340" height="148" onerror="this.style.visibility='hidden'" />
    <span class="style-label">${label}${cars.length ? `<small>${count(k)} in stock</small>` : ''}</span></a>`).join('')
}
drawStyles()

const featured = document.getElementById('featured')
getInventory().then((cars) => {
  drawStyles(cars)
  renderCards(featured, cars.slice(0, 8),
    '<div class="empty">New arrivals are being prepared. Check back soon or <a href="./contact.html">tell us what you are looking for</a>.</div>')
  // Browse Inventory: marcas que estão no estoque
  const makes = {}
  for (const v of cars) makes[v.make] = (makes[v.make] || 0) + 1
  const list = Object.entries(makes).sort((a, b) => a[0].localeCompare(b[0]))
  if (list.length) {
    document.getElementById('makes').innerHTML = list.map(([m, n]) => `<a href="./inventory.html?make=${encodeURIComponent(m)}">${esc(m)} <small>(${n})</small></a>`).join('')
    document.getElementById('makes-section').hidden = false
  }
}).catch(() => loadError(featured))

// Posts do Instagram (clientes recebendo os carros). Some se não houver posts.
supabase.functions.invoke('instagram-feed', { method: 'GET' }).then(({ data }) => {
  const posts = (data?.posts || []).slice(0, 8)
  if (!posts.length) return
  document.getElementById('ig-grid').innerHTML = posts.map((p) => `<a class="ig-post" href="${esc(p.permalink)}" target="_blank" rel="noopener" title="${esc(p.caption)}">
    <img src="${esc(p.image)}" alt="${esc(p.caption || 'Instagram post')}" loading="lazy" referrerpolicy="no-referrer" />
    ${p.type === 'VIDEO' ? '<span class="ig-play" aria-label="Video"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>' : ''}
  </a>`).join('')
  document.getElementById('instagram').hidden = false
}).catch(() => {})
