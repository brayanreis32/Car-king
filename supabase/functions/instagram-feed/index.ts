// @ts-nocheck
// CARKING — Edge Function "instagram-feed"
// Entrega ao site os últimos posts do Instagram da loja (fotos e vídeos de
// clientes recebendo os carros). Pública: devolve só o que já é público no
// Instagram. A chave de acesso fica no banco e nunca sai daqui.
//
// GET  -> lista de posts (cache de 1 hora)
// POST { refresh: true } -> força atualizar (usado pelo botão em Configurações)
//
// Ao publicar: deixe "Verify JWT with legacy secret" DESLIGADO.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body, status = 200, cache = 'public, max-age=300') =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': cache } })

const CACHE_MS = 60 * 60 * 1000          // 1 hora
const REFRESH_TOKEN_MS = 20 * 24 * 3600e3 // renova a chave a cada 20 dias (ela vale 60)
const GRAPH = 'https://graph.instagram.com'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const db = createClient(Deno.env.get('SUPABASE_URL'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
  try {
    let force = false
    if (req.method === 'POST') { try { force = Boolean((await req.json()).refresh) } catch { /* sem corpo */ } }

    // empresa do site: a marcada como pública (ou a primeira)
    const { data: company } = await db.from('companies').select('id').order('public_site', { ascending: false }).order('created_at').limit(1).maybeSingle()
    if (!company) return json({ posts: [] })
    const { data: cfg } = await db.from('instagram_settings').select('*').eq('company_id', company.id).maybeSingle()
    if (!cfg?.access_token) return json({ posts: [], connected: false })

    const fresh = cfg.cached_at && Date.now() - new Date(cfg.cached_at).getTime() < (force ? 60e3 : CACHE_MS)
    if (fresh) return json({ posts: cfg.cached_posts, username: cfg.username, connected: true })

    let token = cfg.access_token
    const patch = {}
    try {
      // renova a chave de longa duração antes de vencer
      if (!cfg.token_updated_at || Date.now() - new Date(cfg.token_updated_at).getTime() > REFRESH_TOKEN_MS) {
        const r = await fetch(`${GRAPH}/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`)
        if (r.ok) { const j = await r.json(); if (j.access_token) { token = j.access_token; patch.access_token = token; patch.token_updated_at = new Date().toISOString() } }
      }
      const me = await fetch(`${GRAPH}/me?fields=username&access_token=${encodeURIComponent(token)}`).then((r) => r.json())
      if (me.error) throw new Error(me.error.message)
      const fields = 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp'
      const media = await fetch(`${GRAPH}/me/media?fields=${fields}&limit=12&access_token=${encodeURIComponent(token)}`).then((r) => r.json())
      if (media.error) throw new Error(media.error.message)
      const posts = (media.data || []).map((m) => ({
        id: m.id, type: m.media_type, permalink: m.permalink, timestamp: m.timestamp,
        image: m.media_type === 'VIDEO' ? (m.thumbnail_url || null) : m.media_url,
        video: m.media_type === 'VIDEO' ? m.media_url : null,
        caption: (m.caption || '').slice(0, 300),
      })).filter((p) => p.image)
      await db.from('instagram_settings').update({ ...patch, username: me.username, cached_posts: posts, cached_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq('company_id', company.id)
      return json({ posts, username: me.username, connected: true })
    } catch (e) {
      await db.from('instagram_settings').update({ ...patch, last_error: String(e.message || e).slice(0, 300), updated_at: new Date().toISOString() }).eq('company_id', company.id)
      // em caso de erro, o site continua mostrando os últimos posts salvos
      return json({ posts: cfg.cached_posts || [], username: cfg.username, connected: true, stale: true })
    }
  } catch (e) {
    return json({ posts: [], error: 'unavailable' }, 200, 'no-store')
  }
})
