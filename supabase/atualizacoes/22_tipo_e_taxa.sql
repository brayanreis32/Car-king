-- =============================================================================
-- CARKING — Atualização 22: tipo de carroceria e taxa de documentação (site)
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 22 · Tipo de carroceria e taxa de documentação (site)
-- =============================================================================
-- * body_style (sedan, suv, truck, hatchback, coupe, van, wagon, convertible)
--   em análises de leilão e veículos. Vem do VIN (NHTSA) ao importar; o
--   veículo herda da análise ao ser comprado. Usado no "Browse by style".
-- * companies.doc_fee: taxa de documentação do dealer, mostrada no site como
--   "Price + doc fee = total". 0 = não mostra.
-- =============================================================================

do $$ begin
  create type public.body_style as enum ('sedan', 'suv', 'truck', 'hatchback', 'coupe', 'van', 'wagon', 'convertible', 'other');
exception when duplicate_object then null; end $$;

alter table public.auction_opportunities add column if not exists body_style public.body_style;
alter table public.vehicles add column if not exists body_style public.body_style;
alter table public.companies add column if not exists doc_fee numeric(10,2) not null default 0 check (doc_fee >= 0);

-- veículo herda o tipo da análise de leilão
create or replace function app.vehicle_body_from_opportunity()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.body_style is null and new.opportunity_id is not null then
    select body_style into new.body_style from public.auction_opportunities where id = new.opportunity_id;
  end if;
  return new;
end $$;
drop trigger if exists vehicles_body_from_opportunity on public.vehicles;
create trigger vehicles_body_from_opportunity before insert on public.vehicles
  for each row execute function app.vehicle_body_from_opportunity();

-- estoque público: inclui tipo e taxa de documentação
create or replace function public.public_inventory(p_vehicle_id uuid default null)
returns jsonb
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(x order by x.sort_date desc), '[]'::jsonb)
  from (
    select v.id, v.stock_number, v.vin, v.year, v.make, v.model, v.trim,
           case when v.odometer_unit = 'km' then round(v.odometer * 0.621371) else v.odometer end as mileage,
           v.color, v.fuel_type, v.transmission, v.title_status, v.body_style,
           (v.status = 'reserved') as reserved,
           coalesce(v.listed_price, v.expected_sale_price) as price,
           (select doc_fee from public.companies where id = v.company_id) as doc_fee,
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
revoke execute on function public.public_inventory(uuid) from public;
grant execute on function public.public_inventory(uuid) to anon, authenticated;
