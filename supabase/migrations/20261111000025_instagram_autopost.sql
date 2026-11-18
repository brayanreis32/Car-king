-- =============================================================================
-- CARKING — 25 · Post automático no Instagram pelo servidor
-- =============================================================================
-- * A cada 5 minutos o banco chama a Edge Function "instagram-autopost".
-- * Ela pega os carros "Pronto para venda"/"Anunciado" com fotos de venda que
--   ainda não foram postados (espera 3 min depois da última foto, para o
--   carrossel sair com todas) e publica. Não precisa do sistema aberto.
-- * Trava "publishing" evita post duplicado; erro tenta de novo após 1 hora
--   (no máximo 3 tentativas por carro).
-- =============================================================================

alter table public.instagram_posts drop constraint if exists instagram_posts_status_check;
alter table public.instagram_posts add constraint instagram_posts_status_check
  check (status in ('published', 'downloaded', 'failed', 'publishing'));
create unique index if not exists instagram_posts_one_publishing
  on public.instagram_posts(vehicle_id, kind) where status = 'publishing';

create or replace function public.instagram_autopost_candidates(p_settle_minutes integer default 3, p_limit integer default 3)
returns table (company_id uuid, vehicle_id uuid, vehicle jsonb, phone text, access_token text, ig_user_id text, photo_paths text[])
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  -- trava esquecida (função caiu no meio): libera depois de 15 minutos
  update public.instagram_posts set status = 'failed', error = 'tempo esgotado'
   where status = 'publishing' and created_at < now() - interval '15 minutes';

  return query
  select v.company_id, v.id,
         jsonb_build_object('year', v.year, 'make', v.make, 'model', v.model, 'trim', v.trim, 'odometer',
           case when v.odometer_unit = 'km' then round(v.odometer * 0.621371) else v.odometer end,
           'color', v.color, 'title_status', v.title_status, 'transmission', v.transmission),
         c.phone, s.access_token, s.ig_user_id,
         array(select a.path from public.attachments a
                where a.entity_type = 'vehicle' and a.entity_id = v.id and a.kind = 'photo' and a.bucket = 'vehicle-media'
                order by a.sort_order, a.created_at limit 8)
    from public.vehicles v
    join public.companies c on c.id = v.company_id and c.ig_auto_post
    join public.instagram_settings s on s.company_id = v.company_id and s.access_token is not null
   where v.status in ('ready_for_sale', 'listed')
     and v.updated_at < now() - make_interval(mins => p_settle_minutes)
     and exists (select 1 from public.attachments a
                  where a.entity_type = 'vehicle' and a.entity_id = v.id and a.kind = 'photo' and a.bucket = 'vehicle-media')
     and not exists (select 1 from public.attachments a
                      where a.entity_type = 'vehicle' and a.entity_id = v.id and a.kind = 'photo'
                        and a.created_at > now() - make_interval(mins => p_settle_minutes))
     and not exists (select 1 from public.instagram_posts p
                      where p.vehicle_id = v.id and p.kind = 'for_sale'
                        and (p.status in ('published', 'downloaded', 'publishing')
                             or (p.status = 'failed' and p.created_at > now() - interval '1 hour')))
     and (select count(*) from public.instagram_posts p
           where p.vehicle_id = v.id and p.kind = 'for_sale' and p.status = 'failed') < 3
   order by coalesce(v.listed_at, v.ready_at, v.updated_at)
   limit p_limit;
end $$;

revoke execute on function public.instagram_autopost_candidates(integer, integer) from public, anon, authenticated;
grant execute on function public.instagram_autopost_candidates(integer, integer) to service_role;

-- Agendamento a cada 5 minutos (no Supabase; no teste local as extensões não existem)
do $$
begin
  create extension if not exists pg_net with schema extensions;
  create extension if not exists pg_cron;
  perform cron.unschedule(jobid) from cron.job where jobname = 'carking-instagram-autopost';
  perform cron.schedule('carking-instagram-autopost', '*/5 * * * *', $job$
    select net.http_post(
      url := 'https://tokewrstbecqqmlzinsh.supabase.co/functions/v1/instagram-autopost',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb,
      timeout_milliseconds := 120000)
  $job$);
exception when others then
  raise notice 'Agendamento não criado (%). Ative pg_cron e pg_net em Database → Extensions e rode de novo.', sqlerrm;
end $$;
