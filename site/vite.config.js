import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { BUSINESS as B, SUPABASE_URL } from './src/config.js'

// -----------------------------------------------------------------------------
// Páginas do site (HTML estático = bom para o Google)
// -----------------------------------------------------------------------------
const PAGES = ['index', 'inventory', 'vehicle', 'financing', 'contact']

const digits = (v) => String(v || '').replace(/\D/g, '')
const telHref = (v) => { const d = digits(v); return d ? `+${d.length === 10 ? '1' + d : d}` : '' }
const textPhone = B.textPhone || B.phone
const address = [B.street, [B.city, [B.state, B.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ')
const cityState = [B.city, B.state].filter(Boolean).join(', ')
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'AutoDealer',
  name: B.name,
  url: B.siteUrl + '/',
  logo: B.siteUrl + '/logo.jpg',
  image: B.siteUrl + '/og-image.png',
  ...(B.phone && { telephone: telHref(B.phone) }),
  ...(B.email && { email: B.email }),
  ...(B.street && { address: { '@type': 'PostalAddress', streetAddress: B.street, addressLocality: B.city, addressRegion: B.state, postalCode: B.zip, addressCountry: 'US' } }),
  ...(B.languages?.length && { knowsLanguage: B.languages }),
  ...((B.instagram || B.facebook) && { sameAs: [B.instagram, B.facebook].filter(Boolean) }),
}

const VARS = {
  name: esc(B.name),
  siteUrl: B.siteUrl,
  phone: esc(B.phone),
  phoneHref: telHref(B.phone),
  textPhone: esc(textPhone),
  smsHref: telHref(textPhone),
  waNumber: digits(telHref(textPhone)),
  email: esc(B.email),
  address: esc(address),
  street: esc(B.street),
  cityLine: esc([B.city, [B.state, B.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')),
  cityState: esc(cityState),
  inCity: cityState ? ` in ${esc(cityState)}` : '',
  mapsUrl: address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(B.name + ', ' + address)}` : '',
  hours: (B.hours || []).map(([d, h]) => `<tr><td>${esc(d)}</td><td>${esc(h)}</td></tr>`).join(''),
  languages: esc((B.languages || []).join(' · ')),
  instagram: esc(B.instagram),
  facebook: esc(B.facebook),
  byAppointment: B.byAppointment ? '1' : '',
  year: String(new Date().getFullYear()),
  jsonld: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
}

function render(html) {
  for (let i = 0; i < 3; i++) {
    html = html.replace(/<!--#include (\w+)-->/g, (_, n) => readFileSync(resolve(__dirname, `partials/${n}.html`), 'utf8'))
  }
  // <!--#if a-->…<!--/if a-->  e  <!--#if !a-->…<!--/if !a-->
  html = html.replace(/<!--#if (!?)(\w+)-->([\s\S]*?)<!--\/if \1\2-->/g, (_, neg, k, body) => ((Boolean(VARS[k]) !== Boolean(neg)) ? body : ''))
  html = html.replace(/\{\{(\w+)\}\}/g, (_, k) => VARS[k] ?? '')
  return html
}

const supabaseHost = new URL(SUPABASE_URL).host
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: https://${supabaseHost}`,
  `connect-src 'self' https://${supabaseHost}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const site = {
  name: 'carking-site',
  transformIndexHtml: {
    order: 'pre',
    handler: (html, ctx) => {
      let out = render(html)
      if (ctx.server) return out
      return out.replace('<meta name="referrer"', `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer"`)
    },
  },
  generateBundle() {
    const base = B.siteUrl.replace(/\/$/, '')
    const urls = ['', 'inventory.html', 'financing.html', 'contact.html']
    this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source:
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${base}/${u}</loc></url>`).join('\n')}\n</urlset>\n` })
    this.emitFile({ type: 'asset', fileName: 'robots.txt', source:
      `# Site público da ${B.name}. O sistema interno (/sistema/) não é indexado.\nUser-agent: *\nAllow: /\nDisallow: /sistema/\n\nSitemap: ${base}/sitemap.xml\n` })
  },
}

export default defineConfig({
  base: './',
  plugins: [site],
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: { input: Object.fromEntries(PAGES.map((p) => [p, resolve(__dirname, `${p}.html`)])) },
  },
})
