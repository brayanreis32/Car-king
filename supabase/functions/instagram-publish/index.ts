// @ts-nocheck
// CARKING — Edge Function "instagram-publish"
// Publica no Instagram da loja as artes geradas pelo sistema (carrossel ou foto
// única) com a legenda. Só para usuários logados com permissão de editar
// veículos. A chave do Instagram fica no banco e nunca vai para o navegador.
//
// POST { vehicle_id, paths: ["empresa/instagram/.../1.jpg", ...], caption, auto }
// auto: true = publicação automática; não posta de novo um carro já postado.
//
// Ao publicar: deixe "Verify JWT with legacy secret" DESLIGADO.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const GRAPH = 'https://graph.instagram.com/v23.0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function ig(path, params, method = 'POST') {
  const url = `${GRAPH}/${path}`
  const body = new URLSearchParams(params)
  const r = method === 'GET' ? await fetch(`${url}?${body}`) : await fetch(url, { method: 'POST', body })
  const j = await r.json()
  if (j.error) throw new Error(j.error.error_user_msg || j.error.message || 'Erro do Instagram')
  return j
}

// espera o Instagram terminar de baixar a imagem
async function waitReady(id, token) {
  for (let i = 0; i < 10; i++) {
    const s = await ig(id, { fields: 'status_code', access_token: token }, 'GET')
    if (!s.status_code || s.status_code === 'FINISHED') return
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('O Instagram não conseguiu processar uma das imagens.')
    await sleep(1500)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const url = Deno.env.get('SUPABASE_URL'), anon = Deno.env.get('SUPABASE_ANON_KEY')
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const user = createClient(url, anon, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${token}` } } })
    const { data: { user: me } } = await user.auth.getUser(token)
    if (!me) return json({ error: 'Faça login novamente.' }, 401)

    const { vehicle_id, paths, caption, auto } = await req.json()
    if (!Array.isArray(paths) || !paths.length || paths.length > 10) return json({ error: 'Envie de 1 a 10 imagens.' }, 400)
    if (String(caption || '').length > 2200) return json({ error: 'Legenda passa de 2.200 caracteres.' }, 400)

    // permissão e empresa do usuário (pelas regras do banco)
    const perms = await user.rpc('my_permissions')
    const canEdit = (perms.data || []).some((p) => p.module === 'vehicles' && p.can_edit)
    if (!canEdit) return json({ error: 'Sem permissão para publicar.' }, 403)
    const { data: profile } = await user.from('profiles').select('company_id').eq('id', me.id).single()
    const companyId = profile?.company_id
    if (!companyId || paths.some((p) => !String(p).startsWith(`${companyId}/instagram/`))) return json({ error: 'Imagens inválidas.' }, 400)

    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
    const { data: cfg } = await admin.from('instagram_settings').select('access_token').eq('company_id', companyId).maybeSingle()
    if (!cfg?.access_token) return json({ error: 'Conecte o Instagram em Configurações → Instagram no site.' }, 400)
    const at = cfg.access_token

    if (auto && vehicle_id) {
      const { count } = await admin.from('instagram_posts').select('id', { count: 'exact', head: true })
        .eq('vehicle_id', vehicle_id).eq('status', 'published')
      if ((count || 0) > 0) return json({ ok: true, skipped: 'already_posted' })
    }

    // links temporários para o Instagram baixar as imagens
    const { data: signed, error: sErr } = await admin.storage.from('vehicle-media').createSignedUrls(paths, 3600)
    if (sErr) throw new Error(sErr.message)
    const urls = signed.map((s) => s.signedUrl)

    const acct = await ig('me', { fields: 'user_id,username', access_token: at }, 'GET')
    const igId = acct.user_id || acct.id
    let creationId
    if (urls.length === 1) {
      creationId = (await ig(`${igId}/media`, { image_url: urls[0], caption: caption || '', access_token: at })).id
      await waitReady(creationId, at)
    } else {
      const children = []
      for (const u of urls) {
        const c = await ig(`${igId}/media`, { image_url: u, is_carousel_item: 'true', access_token: at })
        children.push(c.id)
      }
      for (const c of children) await waitReady(c, at)
      creationId = (await ig(`${igId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: caption || '', access_token: at })).id
      await waitReady(creationId, at)
    }
    const pub = await ig(`${igId}/media_publish`, { creation_id: creationId, access_token: at })
    let permalink = null
    try { permalink = (await ig(pub.id, { fields: 'permalink', access_token: at }, 'GET')).permalink } catch { /* opcional */ }

    await admin.from('instagram_posts').insert({ company_id: companyId, vehicle_id: vehicle_id || null, caption, media_paths: paths, status: 'published', ig_media_id: pub.id, permalink, created_by: me.id })
    return json({ ok: true, permalink, username: acct.username })
  } catch (e) {
    return json({ error: String(e.message || e) }, 500)
  }
})
