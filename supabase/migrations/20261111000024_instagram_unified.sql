-- =============================================================================
-- CARKING — 24 · Instagram: aceita a chave do "login unificado" da Meta
-- =============================================================================
-- A Meta passou a oferecer a chave "Token do usuário do sistema" (começa com
-- EAA…, não expira). Com ela, as chamadas vão para graph.facebook.com e é
-- preciso o ID da conta do Instagram (descoberto automaticamente quando
-- possível, ou informado em Configurações).
-- =============================================================================

alter table public.instagram_settings add column if not exists ig_user_id text;

drop function if exists public.set_instagram_token(text);
create or replace function public.set_instagram_token(p_token text, p_ig_user_id text default null)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := nullif(trim(coalesce(p_token, '')), '');
  v_ig    text := nullif(regexp_replace(coalesce(p_ig_user_id, ''), '\D', '', 'g'), '');
begin
  if not app.has_permission('settings', 'edit') then
    raise exception 'Sem permissão.';
  end if;
  if v_token is not null and (length(v_token) < 40 or v_token ~ '\s') then
    raise exception 'Essa chave não parece válida. Copie a chave inteira gerada no Meta for Developers.';
  end if;
  insert into public.instagram_settings (company_id, access_token, token_updated_at, ig_user_id, username, cached_posts, cached_at, last_error)
  values (app.current_company_id(), v_token, case when v_token is null then null else now() end, v_ig, null, '[]'::jsonb, null, null)
  on conflict (company_id) do update
     set access_token = excluded.access_token, token_updated_at = excluded.token_updated_at, ig_user_id = excluded.ig_user_id,
         username = null, cached_posts = '[]'::jsonb, cached_at = null, last_error = null, updated_at = now();
end $$;

revoke execute on function public.set_instagram_token(text, text) from anon, public;
grant execute on function public.set_instagram_token(text, text) to authenticated;
