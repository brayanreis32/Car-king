-- =============================================================================
-- CARKING — 11 · Acessos: desenvolvedor (acesso total), administrador, vendedor
-- =============================================================================
-- * O perfil super_admin passa a se chamar "Desenvolvedor (acesso total)".
-- * Somente um Desenvolvedor pode alterar, desativar ou promover alguém a
--   Desenvolvedor. Um Administrador gerencia todos os outros acessos.
-- * Operações do sistema (SQL Editor / Edge Function com service role, onde
--   auth.uid() é nulo) não passam por essas travas.
-- =============================================================================

update public.roles set name = 'Desenvolvedor (acesso total)',
       description = 'Acesso total ao sistema. Único perfil que gerencia outros desenvolvedores.'
 where code = 'super_admin';
update public.roles set description = 'Cadastra e edita carros, valores, custos, vendas e metas; cria logins de funcionários.'
 where code = 'admin';
update public.roles set description = 'Estoque, anúncios, propostas, clientes e vendas. Não vê leilão, compras nem financeiro.'
 where code = 'seller';

create or replace function app.profile_guard()
returns trigger language plpgsql as $$
declare
  v_old_code text := (select code from public.roles where id = old.role_id);
  v_new_code text := (select code from public.roles where id = new.role_id);
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
  if v_new_code = 'super_admin' and v_old_code <> 'super_admin' and v_me <> 'super_admin' then
    raise exception 'Apenas o desenvolvedor pode dar acesso total a outro usuário.';
  end if;
  return new;
end $$;

-- Empresas criadas depois desta atualização também recebem os nomes novos
create or replace function app.role_display_defaults()
returns trigger language plpgsql as $$
begin
  if new.is_system then
    case new.code
      when 'super_admin' then
        new.name := 'Desenvolvedor (acesso total)';
        new.description := 'Acesso total ao sistema. Único perfil que gerencia outros desenvolvedores.';
      when 'admin' then
        new.description := 'Cadastra e edita carros, valores, custos, vendas e metas; cria logins de funcionários.';
      when 'seller' then
        new.description := 'Estoque, anúncios, propostas, clientes e vendas. Não vê leilão, compras nem financeiro.';
      else null;
    end case;
  end if;
  return new;
end $$;
create trigger roles_display_defaults before insert on public.roles
  for each row execute function app.role_display_defaults();
