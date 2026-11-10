// Endereços antigos do sistema (ex.: /#/veiculos) e o app instalado no celular
// agora abrem o sistema em /sistema/.
(function () {
  var h = location.hash || ''
  var installed = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches
  if (h.indexOf('#/') === 0 || h.indexOf('#access_token') === 0 || h.indexOf('#error') === 0 || installed) {
    location.replace('sistema/' + h)
  }
})()
