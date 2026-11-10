import { bindLeadForm, carName, esc, getInventory, initChrome, money } from './lib.js'

const form = document.getElementById('apply')
const pick = new URLSearchParams(location.search).get('vehicle')

bindLeadForm(form, {
  kind: 'financing',
  details: (f) => {
    const sel = form.elements.vehicle_id
    return {
      down_payment: f.down || null, monthly_income: f.income || null, job_time: f.job_time || null,
      address_time: f.address_time || null, credit: f.credit || null, frequency: f.frequency || null,
      vehicle: sel.value ? sel.options[sel.selectedIndex].text : null, consent_contact: true,
    }
  },
})
// o consentimento é obrigatório antes de enviar
form.addEventListener('submit', (e) => {
  if (!form.elements.consent.checked) {
    e.stopImmediatePropagation(); e.preventDefault()
    const msg = form.querySelector('.form-msg')
    msg.className = 'form-msg err'
    msg.textContent = 'Please check the box to allow us to contact you about your application.'
  }
}, true)
initChrome('financing')

getInventory().then((cars) => {
  const sel = form.elements.vehicle_id
  sel.insertAdjacentHTML('beforeend', cars.map((v) =>
    `<option value="${v.id}">${esc(carName(v))}${v.trim ? ' ' + esc(v.trim) : ''} · ${money(v.price)}</option>`).join(''))
  if (pick) sel.value = pick
}).catch(() => {})
