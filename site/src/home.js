import { getInventory, initChrome, loadError, renderCards } from './lib.js'

initChrome('home')

const el = document.getElementById('featured')
getInventory()
  .then((cars) => renderCards(el, cars.slice(0, 8),
    '<div class="empty">New arrivals are being prepared. Check back soon or <a href="./contact.html">tell us what you are looking for</a>.</div>'))
  .catch(() => loadError(el))
