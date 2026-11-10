-- =============================================================================
-- CARKING — Atualização 12: Desenvolvedor invisível para os demais perfis
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 12 · Desenvolvedor invisível para os demais perfis
-- =============================================================================
-- Quem não é Desenvolvedor (super_admin) não vê, não altera e não atribui
-- perfis e logins de Desenvolvedor. A regra fica no banco (RLS), não só na tela.
-- =============================================================================

create or replace function app.role_code_of(p_role_id uuid)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select code from public.roles where id = p_role_id
$$;

create or replace function app.is_developer()
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(app.current_role_code() = 'super_admin', false)
$$;

grant execute on function app.role_code_of(uuid), app.is_developer() to authenticated;

-- Perfis de acesso: o perfil Desenvolvedor só aparece para Desenvolvedores
drop policy if exists roles_select on public.roles;
drop policy if exists roles_select_all on public.roles;
create policy roles_select on public.roles for select to authenticated
  using (company_id = app.current_company_id() and (code <> 'super_admin' or app.is_developer()));

-- Funcionários: logins de Desenvolvedor só aparecem para Desenvolvedores (e para o próprio)
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (company_id = app.current_company_id()
         and (id = auth.uid() or app.is_developer() or app.role_code_of(role_id) <> 'super_admin'));

drop policy if exists profiles_update_admin on public.profiles;
create policy profiles_update_admin on public.profiles for update to authenticated
  using (company_id = app.current_company_id() and app.has_permission('employees', 'edit')
         and (app.is_developer() or app.role_code_of(role_id) <> 'super_admin'))
  with check (company_id = app.current_company_id());

-- Permissões do perfil Desenvolvedor também ficam ocultas
drop policy if exists permissions_select on public.permissions;
create policy permissions_select on public.permissions for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('employees', 'view')
         and (app.is_developer() or app.role_code_of(role_id) <> 'super_admin'));

-- A trava de perfis passa a ler os papéis sem depender do que o usuário enxerga
create or replace function app.profile_guard()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_old_code text := app.role_code_of(old.role_id);
  v_new_code text := app.role_code_of(new.role_id);
  v_me text;
begin
  if auth.uid() is null then
    return new; -- operação do sistema (SQL Editor / Edge Function)
  end if;
  if new.company_id <> old.company_id then
    raise exception 'Não é permitido mover funcionários entre empresas.';
  end if;
  v_me := coalesce(app.current_role_code(), '');
  if auth.uid() = new.id and not app.has_permission('employees', 'edit')
     and (new.role_id, new.is_active) is distinct from (old.role_id, old.is_active) then
    raise exception 'Você não pode alterar seu próprio perfil de acesso.';
  end if;
  if auth.uid() = new.id and old.is_active and not new.is_active then
    raise exception 'Você não pode desativar o próprio acesso.';
  end if;
  if v_old_code = 'super_admin' and v_me <> 'super_admin'
     and (new.role_id, new.is_active, new.company_id) is distinct from (old.role_id, old.is_active, old.company_id) then
    raise exception 'Somente o desenvolvedor pode alterar este acesso.';
  end if;
  if v_new_code = 'super_admin' and coalesce(v_old_code, '') <> 'super_admin' and v_me <> 'super_admin' then
    raise exception 'Perfil inválido.';
  end if;
  return new;
end $$;
