// CARKING — Edge Function "manage-employees"
// Cria logins de funcionários, redefine senhas, ativa/desativa e troca o perfil.
// Roda no Supabase com a chave de serviço (que nunca vai para o navegador) e
// confere as permissões de quem chamou antes de qualquer alteração.
//
// Regras:
//  - Precisa da permissão "employees" (criar ou editar) do usuário logado.
//  - Só um Desenvolvedor (super_admin) cria, altera ou desativa outro Desenvolvedor.
//  - Ninguém desativa o próprio acesso.
import { createClient } from 'npm:@supabase/supabase-js@2.119.0'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const fail = (error: string, status = 400) => json({ error }, status)

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('Método não permitido.', 405)

  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const authHeader = req.headers.get('Authorization') ?? ''

    // Cliente com a identidade de quem chamou (respeita RLS e permissões)
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    })
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const { data: { user } } = await caller.auth.getUser(token)
    if (!user) return fail('Faça login novamente.', 401)

    // Cliente de serviço (pode criar usuários no Auth)
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

    const { data: me } = await admin.from('profiles')
      .select('id, company_id, is_active, roles(code)').eq('id', user.id).single()
    if (!me || !me.is_active) return fail('Seu acesso está inativo.', 403)
    const myRole = (me.roles as { code: string }).code

    const { data: perms } = await caller.rpc('my_permissions')
    const can = (action: string) =>
      Boolean((perms ?? []).find((p: { module: string }) => p.module === 'employees')?.[`can_${action}`])

    const body = await req.json()
    const action = body.action as string

    const roleByCode = async (code: string) =>
      (await admin.from('roles').select('id, code').eq('company_id', me.company_id).eq('code', code).maybeSingle()).data

    // ---------------------------------------------------------------- criar
    if (action === 'create') {
      if (!can('create')) return fail('Você não tem permissão para criar logins.', 403)
      const email = String(body.email ?? '').trim().toLowerCase()
      const password = String(body.password ?? '')
      const fullName = String(body.full_name ?? '').trim()
      const roleCode = String(body.role_code ?? '')
      if (!email || !fullName || !roleCode) return fail('Informe nome, e-mail e perfil.')
      if (password.length < 8) return fail('A senha precisa ter pelo menos 8 caracteres.')
      if (roleCode === 'super_admin' && myRole !== 'super_admin') return fail('Apenas o desenvolvedor pode criar outro acesso total.', 403)
      const role = await roleByCode(roleCode)
      if (!role) return fail('Perfil inválido.')

      const { data: created, error } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: fullName },
      })
      if (error || !created.user) {
        const msg = error?.message ?? ''
        return fail(/already|registered|exists/i.test(msg) ? 'Já existe um login com este e-mail.' : msg || 'Não foi possível criar o login.')
      }
      const { error: profileError } = await admin.from('profiles').insert({
        id: created.user.id, company_id: me.company_id, role_id: role.id,
        full_name: fullName, email, phone: body.phone || null, branch_id: body.branch_id || null,
      })
      if (profileError) {
        await admin.auth.admin.deleteUser(created.user.id)
        return fail(profileError.message)
      }
      return json({ ok: true, user_id: created.user.id })
    }

    // ------------------------------------------------- alterar um funcionário
    if (!['reset_password', 'set_active', 'update'].includes(action)) return fail('Ação desconhecida.')
    if (!can('edit')) return fail('Você não tem permissão para alterar logins.', 403)

    const targetId = String(body.user_id ?? '')
    const { data: target } = await admin.from('profiles')
      .select('id, company_id, roles(code)').eq('id', targetId).maybeSingle()
    if (!target || target.company_id !== me.company_id) return fail('Funcionário não encontrado.', 404)
    const targetRole = (target.roles as { code: string }).code
    if (targetRole === 'super_admin' && myRole !== 'super_admin') return fail('Somente o desenvolvedor pode alterar este acesso.', 403)

    if (action === 'reset_password') {
      const password = String(body.password ?? '')
      if (password.length < 8) return fail('A senha precisa ter pelo menos 8 caracteres.')
      const { error } = await admin.auth.admin.updateUserById(targetId, { password })
      if (error) return fail(error.message)
      return json({ ok: true })
    }

    if (action === 'set_active') {
      const active = Boolean(body.is_active)
      if (targetId === user.id && !active) return fail('Você não pode desativar o próprio acesso.')
      const { error } = await admin.from('profiles').update({ is_active: active }).eq('id', targetId)
      if (error) return fail(error.message)
      // bloqueia/desbloqueia o login também no Auth
      await admin.auth.admin.updateUserById(targetId, { ban_duration: active ? 'none' : '876000h' })
      return json({ ok: true })
    }

    // update: nome, telefone e perfil
    const changes: Record<string, unknown> = {}
    if (body.full_name) changes.full_name = String(body.full_name).trim()
    if (body.phone !== undefined) changes.phone = body.phone || null
    if (body.role_code) {
      if (body.role_code === 'super_admin' && myRole !== 'super_admin') return fail('Apenas o desenvolvedor pode dar acesso total.', 403)
      if (targetId === user.id && body.role_code !== targetRole) return fail('Você não pode mudar o próprio perfil.')
      const role = await roleByCode(String(body.role_code))
      if (!role) return fail('Perfil inválido.')
      changes.role_id = role.id
    }
    const { error } = await admin.from('profiles').update(changes).eq('id', targetId)
    if (error) return fail(error.message)
    return json({ ok: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500)
  }
})
