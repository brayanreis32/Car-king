-- =============================================================================
-- CARKING — 23 · Postar carros no Instagram
-- =============================================================================
-- * instagram_posts: histórico dos posts de cada carro (para não postar duas
--   vezes e para mostrar o link do post no sistema).
-- * companies.ig_auto_post: ao marcar o carro "Pronto para venda" ou
--   "Anunciado" (com fotos), o sistema publica sozinho no Instagram, uma vez
--   por carro. Pode ser desligado em Configurações.
-- * A publicação é feita pela Edge Function "instagram-publish" (com a chave
--   guardada em instagram_settings, que o app nunca lê).
-- =============================================================================

alter table public.companies add column if not exists ig_auto_post boolean not null default true;

create table if not exists public.instagram_posts (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default app.current_company_id() references public.companies(id) on delete cascade,
  vehicle_id   uuid references public.vehicles(id) on delete cascade,
  kind         text not null default 'for_sale' check (kind in ('for_sale', 'sold', 'other')),
  caption      text,
  media_paths  jsonb not null default '[]'::jsonb,
  status       text not null default 'published' check (status in ('published', 'downloaded', 'failed')),
  ig_media_id  text,
  permalink    text,
  error        text,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);
create index if not exists instagram_posts_vehicle_idx on public.instagram_posts(vehicle_id, created_at desc);

alter table public.instagram_posts enable row level security;
create policy instagram_posts_select on public.instagram_posts for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('vehicles', 'view'));
create policy instagram_posts_insert on public.instagram_posts for insert to authenticated
  with check (company_id = app.current_company_id() and app.has_permission('vehicles', 'edit'));
create policy instagram_posts_delete on public.instagram_posts for delete to authenticated
  using (company_id = app.current_company_id() and app.has_permission('vehicles', 'delete'));
grant select, insert, delete on public.instagram_posts to authenticated;
revoke all on public.instagram_posts from anon;

-- exclusão de veículo (teste) também apaga o histórico de posts
-- (on delete cascade já cobre)
