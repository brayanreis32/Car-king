import { esc, getInventory, initChrome, loadError, renderCards, supabase } from './lib.js'

initChrome('home')

const el = document.getElementById('featured')
getInventory()
  .then((cars) => renderCards(el, cars.slice(0, 8),
    '<div class="empty">New arrivals are being prepared. Check back soon or <a href="./contact.html">tell us what you are looking for</a>.</div>'))
  .catch(() => loadError(el))

// Posts do Instagram (clientes recebendo os carros). Some se não houver posts.
supabase.functions.invoke('instagram-feed', { method: 'GET' }).then(({ data }) => {
  const posts = (data?.posts || []).slice(0, 8)
  if (!posts.length) return
  const grid = document.getElementById('ig-grid')
  grid.innerHTML = posts.map((p) => `<a class="ig-post" href="${esc(p.permalink)}" target="_blank" rel="noopener" title="${esc(p.caption)}">
    <img src="${esc(p.image)}" alt="${esc(p.caption || 'Instagram post')}" loading="lazy" referrerpolicy="no-referrer" />
    ${p.type === 'VIDEO' ? '<span class="ig-play" aria-label="Video"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>' : ''}
  </a>`).join('')
  document.getElementById('instagram').hidden = false
}).catch(() => {})
