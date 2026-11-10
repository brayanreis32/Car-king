-- =============================================================================
-- CARKING — Atualização 18: site público (estoque à venda e contatos do site)
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 18 · Site público: estoque à venda e contatos do site
-- =============================================================================
-- * O site (sem login) só enxerga o que estas funções devolvem: carros com
--   status "Pronto para venda", "Anunciado" ou "Reservado", com preço, fotos
--   e dados técnicos. Custos, lucro, fornecedores e clientes NUNCA saem daqui.
-- * Fotos: o visitante só consegue abrir fotos de veículos (aba Fotos) de
--   carros à venda. Fotos de danos, notas e documentos continuam privados.
-- * website_leads: contatos, "confirmar disponibilidade" e pré-aprovação de
--   financiamento enviados pelo site. Aparecem no sistema em Clientes.
--   Não pedimos SSN nem dados bancários pelo site.
-- =============================================================================

alter table public.companies add column if not exists public_site boolean not null default false;
-- a primeira empresa cadastrada é a do site
update public.companies set public_site = true
 where id = (select id from public.companies order by created_at limit 1)
   and not exists (select 1 from public.companies where public_site);

create or replace function app.site_company_id()
returns uuid language sql stable security definer
set search_path = public, pg_temp
as $$ select id from public.companies order by public_site desc, created_at limit 1 $$;  -- sem marcação: a primeira empresa

-- -----------------------------------------------------------------------------
-- Estoque público
-- -----------------------------------------------------------------------------
create or replace function public.public_inventory(p_vehicle_id uuid default null)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x order by x.sort_date desc), '[]'::jsonb)
  from (
    select v.id, v.stock_number, v.vin, v.year, v.make, v.model, v.trim,
           case when v.odometer_unit = 'km' then round(v.odometer * 0.621371) else v.odometer end as mileage,
           v.color, v.fuel_type, v.transmission, v.title_status,
           (v.status = 'reserved') as reserved,
           coalesce(v.listed_price, v.expected_sale_price) as price,
           coalesce(v.listed_at, v.ready_at, v.created_at) as sort_date,
           coalesce((select jsonb_agg(a.path order by a.sort_order, a.created_at)
                       from public.attachments a
                      where a.entity_type = 'vehicle' and a.entity_id = v.id and a.kind = 'photo'
                        and a.bucket = 'vehicle-media'), '[]'::jsonb) as photos
      from public.vehicles v
     where v.company_id = app.site_company_id()
       and v.status in ('ready_for_sale', 'listed', 'reserved')
       and (p_vehicle_id is null or v.id = p_vehicle_id)
  ) x
$$;

-- Usada pela regra do Storage: a foto pertence a um carro à venda?
create or replace function public.site_photo_is_public(p_path text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.attachments a join public.vehicles v on v.id = a.entity_id
     where a.bucket = 'vehicle-media' and a.path = p_path
       and a.entity_type = 'vehicle' and a.kind = 'photo'
       and v.company_id = app.site_company_id()
       and v.status in ('ready_for_sale', 'listed', 'reserved'))
$$;

create policy carking_storage_public_photos on storage.objects for select to anon
  using (bucket_id = 'vehicle-media' and public.site_photo_is_public(name));

-- -----------------------------------------------------------------------------
-- Contatos do site
-- -----------------------------------------------------------------------------
create table if not exists public.website_leads (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  kind         text not null check (kind in ('contact', 'availability', 'financing', 'trade_in', 'test_drive')),
  name         text not null,
  phone        text,
  email        text,
  message      text,
  vehicle_id   uuid references public.vehicles(id) on delete set null,
  vehicle_label text,
  details      jsonb not null default '{}'::jsonb,
  status       text not null default 'new' check (status in ('new', 'contacted', 'closed')),
  customer_id  uuid references public.customers(id) on delete set null,
  handled_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists website_leads_company_idx on public.website_leads(company_id, status, created_at desc);

alter table public.website_leads enable row level security;
create policy website_leads_select on public.website_leads for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('customers', 'view'));
create policy website_leads_update on public.website_leads for update to authenticated
  using (company_id = app.current_company_id() and app.has_permission('customers', 'edit'))
  with check (company_id = app.current_company_id());
create policy website_leads_delete on public.website_leads for delete to authenticated
  using (company_id = app.current_company_id() and app.has_permission('customers', 'delete'));
grant select, update, delete on public.website_leads to authenticated;
revoke all on public.website_leads from anon;

-- Envio pelo site (visitante sem login). Validação e limite contra spam.
create or replace function public.submit_website_lead(
  p_kind       text,
  p_name       text,
  p_phone      text default null,
  p_email      text default null,
  p_message    text default null,
  p_vehicle_id uuid default null,
  p_details    jsonb default '{}'::jsonb
)
returns boolean
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_company uuid := app.site_company_id();
  v_phone   text := nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '');
  v_email   text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_label   text;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if v_company is null then raise exception 'Site indisponível.'; end if;
  if p_kind not in ('contact', 'availability', 'financing', 'trade_in', 'test_drive') then
    raise exception 'Invalid request.';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 or length(p_name) > 120 then
    raise exception 'Please enter your name.';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'Please enter a phone number or e-mail.';
  end if;
  if v_phone is not null and length(regexp_replace(v_phone, '\D', '', 'g')) not between 10 and 15 then
    raise exception 'Please enter a valid phone number.';
  end if;
  if v_email is not null and (length(v_email) > 160 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'Please enter a valid e-mail.';
  end if;
  if length(coalesce(p_message, '')) > 2000 or length(v_details::text) > 4000 then
    raise exception 'Message is too long.';
  end if;
  -- nunca guardar número de seguro social, mesmo se alguém digitar
  if coalesce(p_message, '') ~ '\d{3}-?\d{2}-?\d{4}' and coalesce(p_message, '') ~* 'ssn|social' then
    raise exception 'Please do not send your Social Security Number here.';
  end if;
  -- limite anti-spam
  if (select count(*) from public.website_leads
       where company_id = v_company and created_at > now() - interval '1 hour'
         and ((v_phone is not null and phone = v_phone) or (v_email is not null and email = v_email))) >= 3
     or (select count(*) from public.website_leads
          where company_id = v_company and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'Too many requests. Please call us instead.';
  end if;

  if p_vehicle_id is not null then
    select concat_ws(' ', year, make, model, trim) || coalesce(' · ' || stock_number, '') into v_label
      from public.vehicles where id = p_vehicle_id and company_id = v_company;
    if v_label is null then p_vehicle_id := null; end if;
  end if;

  insert into public.website_leads (company_id, kind, name, phone, email, message, vehicle_id, vehicle_label, details)
  values (v_company, p_kind, trim(p_name), v_phone, v_email, nullif(trim(coalesce(p_message, '')), ''), p_vehicle_id, v_label, v_details);
  return true;
end $$;

revoke execute on function public.public_inventory(uuid), public.site_photo_is_public(text),
  public.submit_website_lead(text, text, text, text, text, uuid, jsonb) from public;
grant execute on function public.public_inventory(uuid), public.site_photo_is_public(text),
  public.submit_website_lead(text, text, text, text, text, uuid, jsonb) to anon, authenticated;
revoke execute on function app.site_company_id() from public, anon;
grant execute on function app.site_company_id() to authenticated;
