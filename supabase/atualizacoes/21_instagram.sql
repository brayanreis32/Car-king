-- =============================================================================
-- CARKING — Atualização 21: posts do Instagram no site
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 21 · Posts do Instagram no site
-- =============================================================================
-- * A chave de acesso (token) do Instagram fica guardada aqui e NUNCA é lida
--   pelo app nem pelo site: só a Edge Function "instagram-feed" (service role).
-- * set_instagram_token(): o administrador cola a chave em Configurações.
-- * instagram_status(): mostra se está conectado (sem expor a chave).
-- * A função guarda os últimos posts em cache (atualiza no máximo 1x por hora).
-- =============================================================================

create table if not exists public.instagram_settings (
  company_id        uuid primary key references public.companies(id) on delete cascade,
  access_token      text,
  token_updated_at  timestamptz,
  username          text,
  cached_posts      jsonb not null default '[]'::jsonb,
  cached_at         timestamptz,
  last_error        text,
  updated_at        timestamptz not null default now()
);
alter table public.instagram_settings enable row level security;
-- sem políticas: ninguém do app/site lê ou grava direto (só as funções abaixo e a Edge Function)
revoke all on public.instagram_settings from anon, authenticated;

create or replace function public.set_instagram_token(p_token text)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_token text := nullif(trim(coalesce(p_token, '')), '');
begin
  if not app.has_permission('settings', 'edit') then
    raise exception 'Sem permissão.';
  end if;
  if v_token is not null and (length(v_token) < 40 or v_token ~ '\s') then
    raise exception 'Essa chave não parece válida. Copie a chave inteira gerada no Meta for Developers.';
  end if;
  insert into public.instagram_settings (company_id, access_token, token_updated_at, username, cached_posts, cached_at, last_error)
  values (app.current_company_id(), v_token, case when v_token is null then null else now() end, null, '[]'::jsonb, null, null)
  on conflict (company_id) do update
     set access_token = excluded.access_token, token_updated_at = excluded.token_updated_at,
         username = null, cached_posts = '[]'::jsonb, cached_at = null, last_error = null, updated_at = now();
end $$;

create or replace function public.instagram_status()
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'connected', coalesce(s.access_token is not null, false),
    'username', s.username,
    'token_updated_at', s.token_updated_at,
    'cached_at', s.cached_at,
    'posts', coalesce(jsonb_array_length(s.cached_posts), 0),
    'last_error', s.last_error)
  from (select 1) x
  left join public.instagram_settings s on s.company_id = app.current_company_id()
  where app.has_permission('settings', 'view')
$$;

revoke execute on function public.set_instagram_token(text), public.instagram_status() from anon, public;
grant execute on function public.set_instagram_token(text), public.instagram_status() to authenticated;
