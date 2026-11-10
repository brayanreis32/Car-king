import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { SUPABASE_URL } from './src/config.js'

// Política de segurança (CSP): o app só carrega código próprio e só conversa com o
// seu Supabase. Aplicada apenas no build (o modo de desenvolvimento usa scripts inline).
const supabaseHost = new URL(SUPABASE_URL).host
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  `img-src 'self' data: blob: https://${supabaseHost}`,
  `connect-src 'self' https://${supabaseHost} wss://${supabaseHost}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

const securityHeaders = {
  name: 'carking-security-meta',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<meta name="referrer"', `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n    <meta name="referrer"`),
}

// base './' permite hospedar em qualquer subpasta (GitHub Pages, Netlify, Vercel, Cloudflare Pages)
export default defineConfig({
  plugins: [react(), securityHeaders],
  base: './',
})
