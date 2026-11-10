-- =============================================================================
-- CARKING — instalação completa do banco (gerado a partir de supabase/migrations)
-- Cole TUDO no Supabase → SQL Editor → New query → Run. Execute uma única vez.
-- =============================================================================

-- >>> 20261110000001_core.sql
-- =============================================================================
-- CARKING — 01 · Núcleo: empresa, filiais, perfis, papéis, permissões, auditoria
-- =============================================================================
-- Convenções do projeto:
--   * Todas as chaves primárias são UUID.
--   * Valores monetários usam numeric(12,2). Percentuais usam numeric(7,4).
--   * Toda tabela de negócio possui company_id (isolamento multiempresa via RLS).
--   * company_id tem default app.current_company_id(): o app não precisa enviá-lo.
--   * Funções auxiliares ficam no schema "app" (não exposto pela API REST).
-- =============================================================================

create extension if not exists pgcrypto;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.app_module as enum (
  'dashboard', 'auction', 'vehicles', 'purchases', 'inspections', 'parts',
  'repairs', 'transport', 'inventory', 'sales', 'customers', 'suppliers',
  'finance', 'documents', 'reports', 'employees', 'settings'
);

create type public.permission_action as enum ('view', 'create', 'edit', 'approve', 'delete');

-- -----------------------------------------------------------------------------
-- Empresa e filiais
-- -----------------------------------------------------------------------------
create table public.companies (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null check (length(trim(name)) > 0),
  legal_name               text,
  ein                      text,
  dealer_license           text,
  phone                    text,
  email                    text,
  address                  text,
  city                     text,
  state                    text,
  zip                      text,
  currency                 char(3) not null default 'USD',
  timezone                 text not null default 'America/New_York',
  locale                   text not null default 'pt-BR',
  -- Parâmetros de negócio usados nos cálculos e alertas
  default_min_profit       numeric(12,2) not null default 2000 check (default_min_profit >= 0),
  default_min_margin_pct   numeric(7,4)  not null default 15   check (default_min_margin_pct >= 0 and default_min_margin_pct < 100),
  default_min_roi_pct      numeric(7,4)  not null default 0    check (default_min_roi_pct >= 0),
  default_contingency_pct  numeric(7,4)  not null default 10   check (default_contingency_pct >= 0),
  budget_alert_pct         numeric(7,4)  not null default 10   check (budget_alert_pct >= 0),
  stale_vehicle_days       integer       not null default 45   check (stale_vehicle_days > 0),
  payable_alert_days       integer       not null default 7    check (payable_alert_days >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  name        text not null,
  address     text,
  city        text,
  state       text,
  zip         text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, name)
);

-- -----------------------------------------------------------------------------
-- Papéis e permissões (matriz módulo × ação)
-- -----------------------------------------------------------------------------
create table public.roles (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  code         text not null check (code ~ '^[a-z_]+$'),
  name         text not null,
  description  text,
  is_system    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, code)
);

create table public.permissions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  role_id      uuid not null references public.roles(id) on delete cascade,
  module       public.app_module not null,
  can_view     boolean not null default false,
  can_create   boolean not null default false,
  can_edit     boolean not null default false,
  can_approve  boolean not null default false,
  can_delete   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (role_id, module)
);

-- -----------------------------------------------------------------------------
-- Perfis (funcionários). id = auth.users.id
-- -----------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete restrict,
  branch_id   uuid references public.branches(id) on delete set null,
  role_id     uuid not null references public.roles(id) on delete restrict,
  full_name   text not null,
  email       text,
  phone       text,
  job_title   text,
  avatar_path text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index profiles_company_idx on public.profiles(company_id);

-- -----------------------------------------------------------------------------
-- Auditoria
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  table_name  text not null,
  record_id   uuid,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data    jsonb,
  new_data    jsonb,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index audit_logs_record_idx  on public.audit_logs(table_name, record_id);
create index audit_logs_company_idx on public.audit_logs(company_id, changed_at desc);

-- -----------------------------------------------------------------------------
-- Funções auxiliares
-- -----------------------------------------------------------------------------
create or replace function app.current_company_id()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.company_id from public.profiles p
  where p.id = auth.uid() and p.is_active
$$;

create or replace function app.current_role_code()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select r.code from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = auth.uid() and p.is_active
$$;

create or replace function app.has_permission(p_module public.app_module, p_action public.permission_action)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when r.code = 'super_admin' then true
      else case p_action
        when 'view'    then pm.can_view
        when 'create'  then pm.can_create
        when 'edit'    then pm.can_edit
        when 'approve' then pm.can_approve
        when 'delete'  then pm.can_delete
      end
    end
    from public.profiles pr
    join public.roles r on r.id = pr.role_id
    left join public.permissions pm on pm.role_id = r.id and pm.module = p_module
    where pr.id = auth.uid() and pr.is_active
  ), false)
$$;

-- Exposta ao app para mostrar/ocultar menus no FlutterFlow
create or replace function public.my_permissions()
returns table (module public.app_module, can_view boolean, can_create boolean,
               can_edit boolean, can_approve boolean, can_delete boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select m.module,
         app.has_permission(m.module, 'view'),
         app.has_permission(m.module, 'create'),
         app.has_permission(m.module, 'edit'),
         app.has_permission(m.module, 'approve'),
         app.has_permission(m.module, 'delete')
  from unnest(enum_range(null::public.app_module)) as m(module)
  where auth.uid() is not null
$$;

create or replace function app.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.audit_row()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new; -- nada mudou de fato
  end if;
  insert into public.audit_logs (company_id, table_name, record_id, action, old_data, new_data, changed_by)
  values (
    coalesce((v_new ->> 'company_id')::uuid, (v_old ->> 'company_id')::uuid),
    tg_table_name,
    coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid),
    tg_op, v_old, v_new, auth.uid()
  );
  return coalesce(new, old);
end $$;

-- Impede exclusão física (usado em tabelas cujo histórico deve ser preservado)
create or replace function app.prevent_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Registros de % não podem ser excluídos; use o status de cancelamento para preservar o histórico.', tg_table_name
    using errcode = 'P0001';
end $$;

-- >>> 20261110000002_partners.sql
-- =============================================================================
-- CARKING — 02 · Clientes e fornecedores
-- =============================================================================

create type public.supplier_type as enum (
  'parts', 'mechanic', 'body_shop', 'paint_shop', 'detailing', 'transport',
  'auction', 'documentation', 'inspection', 'other'
);

create table public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  name         text not null,
  company_name text,
  supplier_type public.supplier_type not null default 'other',
  specialty    text,
  contact_name text,
  phone        text,
  email        text,
  website      text,
  address      text,
  city         text,
  state        text,
  zip          text,
  notes        text,
  is_active    boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index suppliers_company_idx on public.suppliers(company_id, supplier_type);

create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  full_name     text not null,
  customer_type text not null default 'individual' check (customer_type in ('individual', 'business', 'dealer')),
  phone         text,
  email         text,
  document_id   text, -- driver license / EIN
  address       text,
  city          text,
  state         text,
  zip           text,
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index customers_company_idx on public.customers(company_id, full_name);

-- >>> 20261110000003_auction.sql
-- =============================================================================
-- CARKING — 03 · Auction Analyzer: plataformas, tabelas de taxas, oportunidades,
--               avaliação de danos, simulações e lances
-- =============================================================================

create type public.title_status as enum (
  'clean', 'salvage', 'rebuilt', 'flood', 'certificate_of_destruction',
  'parts_only', 'bill_of_sale_only', 'lemon_buyback', 'other', 'unknown'
);

create type public.run_condition as enum (
  'run_and_drive', 'engine_starts', 'does_not_start', 'stationary', 'unknown'
);

create type public.fuel_type as enum (
  'gasoline', 'diesel', 'hybrid', 'plug_in_hybrid', 'electric', 'flex', 'other'
);

create type public.transmission_type as enum ('automatic', 'manual', 'cvt', 'dual_clutch', 'other');

create type public.vehicle_area as enum (
  'front', 'rear', 'left_side', 'right_side', 'roof', 'engine', 'transmission',
  'suspension', 'brakes', 'structure', 'airbags', 'electrical', 'interior',
  'wheels', 'tires', 'glass', 'undercarriage', 'other'
);

create type public.item_condition as enum (
  'good', 'damaged', 'needs_repair', 'needs_replacement', 'needs_diagnosis'
);

create type public.severity_level as enum ('none', 'low', 'medium', 'high', 'critical');

create type public.opportunity_status as enum (
  'analyzing',          -- Em análise
  'awaiting_inspection',-- Aguardando inspeção
  'awaiting_quote',     -- Aguardando orçamento
  'approved',           -- Aprovado para compra
  'bid_placed',         -- Lance realizado
  'won',                -- Arrematado
  'lost',               -- Não arrematado
  'discarded'           -- Descartado
);

-- -----------------------------------------------------------------------------
-- Plataformas de leilão e tabelas de taxas configuráveis
-- -----------------------------------------------------------------------------
create table public.auction_sources (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  name                  text not null,           -- ex.: Copart, IAA, Manheim
  website               text,
  bid_increment         numeric(12,2) not null default 25 check (bid_increment > 0),
  -- Taxas fixas por veículo que não dependem do lance (gate, environmental, title...)
  flat_fees             numeric(12,2) not null default 0 check (flat_fees >= 0),
  flat_fees_description text,
  notes                 text,
  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (company_id, name)
);

-- Cada linha é uma faixa de preço de um tipo de taxa.
-- Taxa da faixa = fixed_fee + lance × percent_fee / 100.
-- Faixa vale para min_amount <= lance < max_amount (max_amount nulo = sem limite).
-- Vários fee_type somam-se (ex.: buyer_fee + virtual_bid_fee).
create table public.auction_fee_tiers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  source_id    uuid not null references public.auction_sources(id) on delete cascade,
  fee_type     text not null default 'buyer_fee',
  min_amount   numeric(12,2) not null default 0 check (min_amount >= 0),
  max_amount   numeric(12,2) check (max_amount is null or max_amount > min_amount),
  fixed_fee    numeric(12,2) not null default 0 check (fixed_fee >= 0),
  percent_fee  numeric(7,4)  not null default 0 check (percent_fee >= 0 and percent_fee < 100),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index auction_fee_tiers_source_idx on public.auction_fee_tiers(source_id, fee_type, min_amount);

-- Impede faixas sobrepostas para o mesmo tipo de taxa
create or replace function app.check_fee_tier_overlap()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.auction_fee_tiers t
    where t.source_id = new.source_id and t.fee_type = new.fee_type and t.id <> new.id
      and numrange(t.min_amount, t.max_amount, '[)') && numrange(new.min_amount, new.max_amount, '[)')
  ) then
    raise exception 'Faixa de taxa sobreposta para % (%–%).', new.fee_type, new.min_amount, coalesce(new.max_amount::text, '∞');
  end if;
  return new;
end $$;
create trigger auction_fee_tiers_overlap before insert or update on public.auction_fee_tiers
  for each row execute function app.check_fee_tier_overlap();

-- -----------------------------------------------------------------------------
-- Oportunidades (veículos encontrados em leilão, ainda não comprados)
-- -----------------------------------------------------------------------------
create table public.auction_opportunities (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  source_id              uuid references public.auction_sources(id) on delete restrict,
  auction_name           text,
  lot_number             text,
  vin                    text,
  make                   text not null,
  model                  text not null,
  year                   integer not null check (year between 1950 and 2100),
  trim                   text,
  odometer               integer check (odometer >= 0),
  odometer_unit          text not null default 'mi' check (odometer_unit in ('mi', 'km')),
  color                  text,
  fuel_type              public.fuel_type,
  transmission           public.transmission_type,
  location_city          text,
  location_state         text,
  location_zip           text,
  auction_date           timestamptz,
  title_status           public.title_status not null default 'unknown',
  title_state            text,
  primary_damage         text,
  secondary_damage       text,
  run_condition          public.run_condition not null default 'unknown',
  has_keys               boolean,
  listing_url            text,
  current_bid            numeric(12,2) check (current_bid >= 0),
  buy_now_price          numeric(12,2) check (buy_now_price >= 0),
  auction_acv            numeric(12,2) check (auction_acv >= 0),     -- valor declarado pelo leilão
  market_value_clean     numeric(12,2) check (market_value_clean >= 0), -- valor de revenda em condições normais
  expected_value_repaired numeric(12,2) check (expected_value_repaired >= 0), -- valor esperado após reparos
  -- Validação obrigatória do título antes de aprovar/arrematar
  title_verified         boolean not null default false,
  title_verified_by      uuid references public.profiles(id),
  title_verified_at      timestamptz,
  title_notes            text,
  status                 public.opportunity_status not null default 'analyzing',
  discard_reason         text,
  assigned_to            uuid references public.profiles(id),
  notes                  text,
  created_by             uuid default auth.uid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index auction_opportunities_company_idx on public.auction_opportunities(company_id, status, auction_date);
create index auction_opportunities_vin_idx on public.auction_opportunities(company_id, vin);
create index auction_opportunities_lot_idx on public.auction_opportunities(company_id, source_id, lot_number);

create or replace function app.opportunity_before_write()
returns trigger language plpgsql as $$
begin
  if new.vin is not null then
    new.vin := upper(regexp_replace(new.vin, '\s', '', 'g'));
    if new.vin !~ '^[A-HJ-NPR-Z0-9]{11,17}$' then
      raise exception 'VIN inválido: % (use 17 caracteres, sem I, O ou Q).', new.vin;
    end if;
  end if;

  if new.title_verified and (tg_op = 'INSERT' or not old.title_verified) then
    new.title_verified_at := coalesce(new.title_verified_at, now());
    new.title_verified_by := coalesce(new.title_verified_by, auth.uid());
  end if;

  if new.status in ('approved', 'bid_placed', 'won') and not new.title_verified then
    raise exception 'O status do título (%) precisa ser validado antes de aprovar ou comprar o veículo.', new.title_status
      using hint = 'Confirme as regras de circulação/revenda do título no estado e marque title_verified.';
  end if;

  if new.status = 'discarded' and coalesce(trim(new.discard_reason), '') = '' then
    raise exception 'Informe o motivo do descarte.';
  end if;
  return new;
end $$;
create trigger auction_opportunities_before_write before insert or update on public.auction_opportunities
  for each row execute function app.opportunity_before_write();

-- -----------------------------------------------------------------------------
-- Avaliação de danos (preliminar no leilão ou na chegada)
-- -----------------------------------------------------------------------------
create table public.vehicle_damage_assessments (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  opportunity_id   uuid references public.auction_opportunities(id) on delete cascade,
  vehicle_id       uuid, -- FK adicionada após a criação de vehicles
  stage            text not null default 'pre_purchase' check (stage in ('pre_purchase', 'arrival')),
  area             public.vehicle_area not null,
  condition        public.item_condition not null default 'good',
  severity         public.severity_level not null default 'none',
  description      text,
  repair_needed    text,
  estimated_cost   numeric(12,2) not null default 0 check (estimated_cost >= 0),
  assessed_by      uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (opportunity_id is not null or vehicle_id is not null)
);
create index vehicle_damage_assessments_opp_idx on public.vehicle_damage_assessments(opportunity_id);

-- -----------------------------------------------------------------------------
-- Simulações de compra (entradas + resultados calculados por trigger)
-- -----------------------------------------------------------------------------
create table public.auction_simulations (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  opportunity_id           uuid not null references public.auction_opportunities(id) on delete cascade,
  name                     text not null default 'Simulação',
  is_baseline              boolean not null default false, -- simulação usada como orçamento
  locked                   boolean not null default false, -- travada após a compra (preservada)
  -- Entradas: preços de venda
  expected_sale_price      numeric(12,2) not null check (expected_sale_price > 0),
  conservative_sale_price  numeric(12,2) check (conservative_sale_price > 0),
  optimistic_sale_price    numeric(12,2) check (optimistic_sale_price > 0),
  -- Entradas: custos
  planned_bid              numeric(12,2) not null default 0 check (planned_bid >= 0),
  auction_fees_override    numeric(12,2) check (auction_fees_override >= 0), -- se nulo, usa a tabela da plataforma
  transport_cost           numeric(12,2) not null default 0 check (transport_cost >= 0),
  documentation_cost       numeric(12,2) not null default 0 check (documentation_cost >= 0),
  parts_cost               numeric(12,2) not null default 0 check (parts_cost >= 0),
  labor_cost               numeric(12,2) not null default 0 check (labor_cost >= 0),
  inspection_cost          numeric(12,2) not null default 0 check (inspection_cost >= 0),
  other_costs              numeric(12,2) not null default 0 check (other_costs >= 0),
  contingency_amount       numeric(12,2) check (contingency_amount >= 0), -- valor fixo de imprevistos
  contingency_pct          numeric(7,4)  check (contingency_pct >= 0),     -- ou % sobre peças+mão de obra+inspeção+outros
  selling_costs            numeric(12,2) not null default 0 check (selling_costs >= 0),
  -- Metas
  min_profit               numeric(12,2) check (min_profit >= 0),
  min_margin_pct           numeric(7,4)  check (min_margin_pct >= 0 and min_margin_pct < 100),
  min_roi_pct              numeric(7,4)  check (min_roi_pct >= 0),
  -- Resultados (preenchidos automaticamente)
  auction_fees             numeric(12,2),
  contingency_total        numeric(12,2),
  total_investment         numeric(12,2),
  projected_profit         numeric(12,2),
  margin_pct               numeric(9,4),
  roi_pct                  numeric(9,4),
  conservative_profit      numeric(12,2),
  optimistic_profit        numeric(12,2),
  break_even_sale_price    numeric(12,2),
  max_bid                  numeric(12,2),
  max_bid_fees             numeric(12,2),
  max_bid_binding_rule     text,
  decision                 text check (decision in ('viable', 'above_limit', 'not_viable')),
  notes                    text,
  created_by               uuid default auth.uid(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index auction_simulations_opp_idx on public.auction_simulations(opportunity_id);
create unique index auction_simulations_one_baseline on public.auction_simulations(opportunity_id) where is_baseline;

-- -----------------------------------------------------------------------------
-- Lances
-- -----------------------------------------------------------------------------
create table public.auction_bids (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  opportunity_id   uuid not null references public.auction_opportunities(id) on delete cascade,
  bid_type         text not null default 'live' check (bid_type in ('preliminary', 'proxy', 'live', 'buy_now', 'counter_offer')),
  amount           numeric(12,2) not null check (amount > 0),
  max_bid_at_time  numeric(12,2), -- lance máximo recomendado no momento do lance
  exceeds_max_bid  boolean not null default false,
  result           text not null default 'pending' check (result in ('pending', 'outbid', 'won', 'lost', 'cancelled')),
  placed_at        timestamptz not null default now(),
  placed_by        uuid default auth.uid(),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index auction_bids_opp_idx on public.auction_bids(opportunity_id, placed_at desc);

-- >>> 20261110000004_vehicles_operations.sql
-- =============================================================================
-- CARKING — 04 · Veículos, compras, orçamento, inspeção, peças, reparos,
--               transporte, documentos, despesas, anúncios e propostas
-- =============================================================================
-- REGRA DE OURO DOS CUSTOS (não duplicar):
--   Cada custo real de um veículo vive em UM único lugar:
--     compra e taxas do leilão  -> vehicle_purchases
--     transporte                -> transport_orders.actual_cost
--     peças                     -> parts (+ frete/impostos em part_orders)
--     mão de obra / serviços    -> labor_entries
--     demais custos             -> expenses (documentação, inspeção, estadia,
--                                  detalhamento, marketing, despesas de venda...)
--   Contas a pagar e transações financeiras registram PAGAMENTOS desses custos,
--   nunca um custo novo. A view vehicle_cost_ledger une as fontes acima.
-- =============================================================================

create type public.vehicle_status as enum (
  'purchased',        -- Comprado
  'awaiting_pickup',  -- Aguardando retirada
  'in_transit',       -- Em transporte
  'received',         -- Recebido
  'in_inspection',    -- Em inspeção
  'in_preparation',   -- Em preparação
  'awaiting_parts',   -- Aguardando peças
  'in_repair',        -- Em reparo
  'in_detailing',     -- Em detalhamento
  'ready_for_sale',   -- Pronto para venda
  'listed',           -- Anunciado
  'reserved',         -- Reservado para venda
  'sold'              -- Vendido
);

create type public.cost_group as enum (
  'purchase', 'auction_fees', 'transport', 'parts', 'labor', 'documentation',
  'inspection', 'storage', 'detailing', 'marketing', 'other', 'selling'
);

create type public.part_status as enum (
  'identified', 'awaiting_quote', 'to_buy', 'purchased',
  'awaiting_delivery', 'received', 'installed', 'returned'
);

create type public.part_condition as enum ('new', 'used', 'refurbished', 'aftermarket');

create type public.repair_status as enum (
  'pending', 'quote_requested', 'approved', 'in_progress',
  'awaiting_parts', 'completed', 'cancelled'
);

create type public.priority_level as enum ('low', 'medium', 'high', 'critical');

create type public.document_type as enum (
  'bill_of_sale', 'title', 'salvage_title', 'rebuilt_title', 'auction_document',
  'payment_receipt', 'invoice', 'transport_document', 'inspection_report',
  'transfer_record', 'sale_contract', 'other'
);

create type public.document_status as enum (
  'pending', 'requested', 'received', 'submitted', 'approved',
  'rejected', 'expired', 'not_applicable'
);

-- -----------------------------------------------------------------------------
-- Veículos
-- -----------------------------------------------------------------------------
create table public.vehicles (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  branch_id                uuid references public.branches(id) on delete set null,
  opportunity_id           uuid unique references public.auction_opportunities(id) on delete restrict,
  stock_number             text,
  vin                      text not null,
  make                     text not null,
  model                    text not null,
  year                     integer not null check (year between 1950 and 2100),
  trim                     text,
  odometer                 integer check (odometer >= 0),
  odometer_unit            text not null default 'mi' check (odometer_unit in ('mi', 'km')),
  color                    text,
  fuel_type                public.fuel_type,
  transmission             public.transmission_type,
  title_status             public.title_status not null default 'unknown',
  title_state              text,
  title_number             text,
  run_condition            public.run_condition not null default 'unknown',
  has_keys                 boolean,
  status                   public.vehicle_status not null default 'purchased',
  -- Preços de venda (atuais; o planejado original fica em vehicle_budgets)
  market_value_clean       numeric(12,2) check (market_value_clean >= 0),
  expected_sale_price      numeric(12,2) check (expected_sale_price >= 0),
  conservative_sale_price  numeric(12,2) check (conservative_sale_price >= 0),
  optimistic_sale_price    numeric(12,2) check (optimistic_sale_price >= 0),
  listed_price             numeric(12,2) check (listed_price >= 0),
  -- Marcos de tempo (preenchidos automaticamente pela mudança de status)
  purchased_at             date,
  received_at              timestamptz,
  ready_at                 timestamptz,
  listed_at                timestamptz,
  sold_at                  timestamptz,
  location                 text,
  notes                    text,
  created_by               uuid default auth.uid(),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  unique (company_id, vin),
  unique (company_id, stock_number)
);
create index vehicles_company_status_idx on public.vehicles(company_id, status);

alter table public.vehicle_damage_assessments
  add constraint vehicle_damage_assessments_vehicle_fk foreign key (vehicle_id) references public.vehicles(id) on delete cascade;
create index vehicle_damage_assessments_vehicle_idx on public.vehicle_damage_assessments(vehicle_id);

create table public.vehicle_status_history (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete restrict,
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  from_status  public.vehicle_status,
  to_status    public.vehicle_status not null,
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);
create index vehicle_status_history_vehicle_idx on public.vehicle_status_history(vehicle_id, changed_at);

create table public.vehicle_price_history (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete restrict,
  vehicle_id   uuid not null references public.vehicles(id) on delete cascade,
  old_price    numeric(12,2),
  new_price    numeric(12,2),
  changed_by   uuid,
  changed_at   timestamptz not null default now()
);
create index vehicle_price_history_vehicle_idx on public.vehicle_price_history(vehicle_id, changed_at);

create or replace function app.vehicle_before_write()
returns trigger language plpgsql as $$
begin
  new.vin := upper(regexp_replace(new.vin, '\s', '', 'g'));
  if new.vin !~ '^[A-HJ-NPR-Z0-9]{11,17}$' then
    raise exception 'VIN inválido: % (use 17 caracteres, sem I, O ou Q).', new.vin;
  end if;

  if tg_op = 'UPDATE' and old.status = 'sold' and new.status <> 'sold'
     and exists (select 1 from public.sales s where s.vehicle_id = new.id and s.status = 'completed') then
    raise exception 'Veículo vendido. Cancele a venda antes de alterar o status.';
  end if;

  if tg_op = 'INSERT' or new.status is distinct from old.status then
    case new.status
      when 'received'       then new.received_at := coalesce(new.received_at, now());
      when 'ready_for_sale' then new.ready_at    := coalesce(new.ready_at, now());
      when 'listed'         then new.listed_at   := coalesce(new.listed_at, now());
                                 new.ready_at    := coalesce(new.ready_at, now());
      when 'sold'           then new.sold_at     := coalesce(new.sold_at, now());
      else null;
    end case;
    if new.status in ('in_inspection', 'in_preparation', 'awaiting_parts', 'in_repair', 'in_detailing') then
      new.received_at := coalesce(new.received_at, now());
    end if;
  end if;
  return new;
end $$;
create trigger vehicles_before_write before insert or update on public.vehicles
  for each row execute function app.vehicle_before_write();

create or replace function app.vehicle_after_write()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' or new.status is distinct from old.status then
    insert into public.vehicle_status_history (company_id, vehicle_id, from_status, to_status, changed_by)
    values (new.company_id, new.id, case when tg_op = 'UPDATE' then old.status end, new.status, auth.uid());
  end if;
  if (tg_op = 'INSERT' and new.listed_price is not null)
     or (tg_op = 'UPDATE' and new.listed_price is distinct from old.listed_price) then
    insert into public.vehicle_price_history (company_id, vehicle_id, old_price, new_price, changed_by)
    values (new.company_id, new.id, case when tg_op = 'UPDATE' then old.listed_price end, new.listed_price, auth.uid());
  end if;
  return new;
end $$;
create trigger vehicles_after_write after insert or update on public.vehicles
  for each row execute function app.vehicle_after_write();

-- -----------------------------------------------------------------------------
-- Aquisição (obrigatória para todo veículo) e orçamento
-- -----------------------------------------------------------------------------
create table public.vehicle_purchases (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id          uuid not null unique references public.vehicles(id) on delete restrict,
  opportunity_id      uuid references public.auction_opportunities(id) on delete restrict,
  source_id           uuid references public.auction_sources(id) on delete restrict,
  supplier_id         uuid references public.suppliers(id) on delete restrict,
  auction_name        text,
  lot_number          text,
  purchase_date       date not null default current_date,
  final_bid           numeric(12,2) not null check (final_bid >= 0),
  buyer_fee           numeric(12,2) not null default 0 check (buyer_fee >= 0),
  other_auction_fees  numeric(12,2) not null default 0 check (other_auction_fees >= 0),
  auction_fees_total  numeric(12,2) generated always as (buyer_fee + other_auction_fees) stored,
  total_paid_to_auction numeric(12,2) generated always as (final_bid + buyer_fee + other_auction_fees) stored,
  payment_method      text,
  payment_due_date    date,
  payment_reference   text,
  notes               text,
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Todo veículo deve ter uma aquisição registrada na mesma transação
create or replace function app.vehicle_requires_purchase()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.vehicles v where v.id = new.id)
     and not exists (select 1 from public.vehicle_purchases p where p.vehicle_id = new.id) then
    raise exception 'Todo veículo precisa de uma aquisição registrada. Use as funções register_purchase() ou register_direct_purchase().';
  end if;
  return null;
end $$;
create constraint trigger vehicles_require_purchase
  after insert on public.vehicles deferrable initially deferred
  for each row execute function app.vehicle_requires_purchase();

create table public.vehicle_budgets (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id            uuid not null unique references public.vehicles(id) on delete cascade,
  simulation_id         uuid references public.auction_simulations(id) on delete set null,
  purchase              numeric(12,2) not null default 0 check (purchase >= 0),
  auction_fees          numeric(12,2) not null default 0 check (auction_fees >= 0),
  transport             numeric(12,2) not null default 0 check (transport >= 0),
  parts                 numeric(12,2) not null default 0 check (parts >= 0),
  labor                 numeric(12,2) not null default 0 check (labor >= 0),
  documentation         numeric(12,2) not null default 0 check (documentation >= 0),
  inspection            numeric(12,2) not null default 0 check (inspection >= 0),
  other                 numeric(12,2) not null default 0 check (other >= 0),
  contingency           numeric(12,2) not null default 0 check (contingency >= 0),
  selling_costs         numeric(12,2) not null default 0 check (selling_costs >= 0),
  planned_sale_price    numeric(12,2) check (planned_sale_price >= 0),
  planned_profit        numeric(12,2),
  alert_threshold_pct   numeric(7,4), -- se nulo, usa companies.budget_alert_pct
  notes                 text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Categorias de despesa e despesas avulsas
-- -----------------------------------------------------------------------------
create table public.expense_categories (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default app.current_company_id() references public.companies(id) on delete cascade,
  name        text not null,
  cost_group  public.cost_group not null,
  is_system   boolean not null default false,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, name)
);

create table public.expenses (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id      uuid references public.vehicles(id) on delete restrict, -- nulo = despesa geral da empresa
  category_id     uuid not null references public.expense_categories(id) on delete restrict,
  supplier_id     uuid references public.suppliers(id) on delete restrict,
  description     text not null,
  expense_date    date not null default current_date,
  due_date        date,
  amount          numeric(12,2) not null check (amount > 0),
  status          text not null default 'confirmed' check (status in ('pending', 'confirmed', 'cancelled')),
  invoice_number  text,
  notes           text,
  created_by      uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index expenses_vehicle_idx on public.expenses(vehicle_id);
create index expenses_company_date_idx on public.expenses(company_id, expense_date);

create or replace function app.expense_check_category()
returns trigger language plpgsql as $$
declare v_group public.cost_group;
begin
  select cost_group into v_group from public.expense_categories where id = new.category_id;
  if v_group in ('purchase', 'auction_fees') then
    raise exception 'Custos de compra e taxas de leilão são registrados no módulo Compras (vehicle_purchases).';
  elsif v_group = 'transport' then
    raise exception 'Custos de transporte são registrados no módulo Transporte (transport_orders).';
  elsif v_group = 'parts' then
    raise exception 'Custos de peças são registrados na Parts List (parts / part_orders).';
  elsif v_group = 'labor' then
    raise exception 'Custos de mão de obra são registrados em Labor & Repairs (labor_entries).';
  end if;
  return new;
end $$;
create trigger expenses_check_category before insert or update on public.expenses
  for each row execute function app.expense_check_category();

-- -----------------------------------------------------------------------------
-- Inspeção e diagnóstico
-- -----------------------------------------------------------------------------
create table public.inspection_checklist_templates (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null default app.current_company_id() references public.companies(id) on delete cascade,
  area        public.vehicle_area not null,
  item        text not null,
  sort_order  integer not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, area, item)
);

create table public.vehicle_inspections (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id       uuid not null references public.vehicles(id) on delete restrict,
  inspection_type  text not null default 'arrival' check (inspection_type in ('arrival', 'post_repair', 'pre_sale', 'third_party')),
  status           text not null default 'in_progress' check (status in ('in_progress', 'completed', 'approved', 'rejected')),
  inspector_id     uuid references public.profiles(id),
  inspector_name   text,
  supplier_id      uuid references public.suppliers(id),
  inspected_at     timestamptz not null default now(),
  odometer_reading integer check (odometer_reading >= 0),
  summary          text,
  approved_by      uuid references public.profiles(id),
  approved_at      timestamptz,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index vehicle_inspections_vehicle_idx on public.vehicle_inspections(vehicle_id);

create table public.inspection_items (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  inspection_id     uuid not null references public.vehicle_inspections(id) on delete cascade,
  vehicle_id        uuid not null references public.vehicles(id) on delete restrict,
  area              public.vehicle_area not null,
  item              text not null,
  condition         public.item_condition,
  problem_type      text check (problem_type in ('defect', 'damaged_part', 'missing_part', 'mechanical', 'electrical', 'structural', 'interior', 'cosmetic')),
  description       text,
  priority          public.priority_level not null default 'medium',
  required_action   text not null default 'none' check (required_action in ('none', 'repair', 'replace', 'diagnose')),
  required_part     text,
  estimated_cost    numeric(12,2) not null default 0 check (estimated_cost >= 0),
  repair_status     text not null default 'pending' check (repair_status in ('pending', 'in_progress', 'done', 'not_needed')),
  sort_order        integer not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index inspection_items_inspection_idx on public.inspection_items(inspection_id, sort_order);
create index inspection_items_vehicle_idx on public.inspection_items(vehicle_id);

-- -----------------------------------------------------------------------------
-- Parts List
-- -----------------------------------------------------------------------------
create table public.part_orders (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id           uuid not null references public.vehicles(id) on delete restrict,
  supplier_id          uuid references public.suppliers(id) on delete restrict,
  order_number         text,
  order_date           date not null default current_date,
  expected_delivery    date,
  tracking_number      text,
  shipping_cost        numeric(12,2) not null default 0 check (shipping_cost >= 0),
  tax                  numeric(12,2) not null default 0 check (tax >= 0),
  other_fees           numeric(12,2) not null default 0 check (other_fees >= 0),
  status               text not null default 'ordered' check (status in ('draft', 'ordered', 'shipped', 'delivered', 'cancelled')),
  notes                text,
  created_by           uuid default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index part_orders_vehicle_idx on public.part_orders(vehicle_id);

create table public.parts (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id             uuid not null references public.vehicles(id) on delete restrict,
  part_order_id          uuid references public.part_orders(id) on delete set null,
  inspection_item_id     uuid references public.inspection_items(id) on delete set null,
  repair_item_id         uuid, -- FK adicionada após repair_items
  name                   text not null,
  category               text not null default 'other' check (category in (
                           'body', 'lighting', 'mechanical', 'engine', 'transmission', 'electrical',
                           'suspension', 'brakes', 'cooling', 'tires_wheels', 'glass', 'interior',
                           'airbag_srs', 'fluids', 'other')),
  oem_number             text,
  part_number            text,
  internal_code          text,
  quantity               integer not null default 1 check (quantity > 0),
  part_condition         public.part_condition not null default 'new',
  supplier_id            uuid references public.suppliers(id) on delete restrict,
  product_url            text,
  estimated_unit_price   numeric(12,2) not null default 0 check (estimated_unit_price >= 0),
  actual_unit_price      numeric(12,2) check (actual_unit_price >= 0),
  estimated_total        numeric(12,2) generated always as (round(quantity * estimated_unit_price, 2)) stored,
  actual_total           numeric(12,2) generated always as (round(quantity * actual_unit_price, 2)) stored,
  refund_amount          numeric(12,2) not null default 0 check (refund_amount >= 0), -- quando devolvida
  purchase_date          date,
  expected_delivery_date date,
  received_date          date,
  installed_date         date,
  status                 public.part_status not null default 'identified',
  notes                  text,
  created_by             uuid default auth.uid(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint parts_actual_price_required check (
    status in ('identified', 'awaiting_quote', 'to_buy') or actual_unit_price is not null
  ),
  constraint parts_refund_le_paid check (refund_amount <= coalesce(actual_unit_price * quantity, 0))
);
create index parts_vehicle_idx on public.parts(vehicle_id, status);
create index parts_order_idx on public.parts(part_order_id);

create or replace function app.part_before_write()
returns trigger language plpgsql as $$
begin
  if new.status in ('purchased', 'awaiting_delivery', 'received', 'installed') then
    new.purchase_date := coalesce(new.purchase_date, current_date);
  end if;
  if new.status in ('received', 'installed') then
    new.received_date := coalesce(new.received_date, current_date);
  end if;
  if new.status = 'installed' then
    new.installed_date := coalesce(new.installed_date, current_date);
  end if;
  if new.part_order_id is not null and exists (
       select 1 from public.part_orders o where o.id = new.part_order_id and o.vehicle_id <> new.vehicle_id) then
    raise exception 'A peça e o pedido precisam pertencer ao mesmo veículo.';
  end if;
  return new;
end $$;
create trigger parts_before_write before insert or update on public.parts
  for each row execute function app.part_before_write();

-- -----------------------------------------------------------------------------
-- Labor & Repairs
-- -----------------------------------------------------------------------------
create table public.repair_orders (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id          uuid not null references public.vehicles(id) on delete restrict,
  order_number        text,
  title               text not null,
  supplier_id         uuid references public.suppliers(id) on delete restrict, -- oficina
  mechanic_id         uuid references public.profiles(id),                    -- mecânico interno
  mechanic_name       text,
  responsible_id      uuid references public.profiles(id),
  start_date          date,
  due_date            date,
  completed_date      date,
  status              public.repair_status not null default 'pending',
  notes               text,
  created_by          uuid default auth.uid(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index repair_orders_vehicle_idx on public.repair_orders(vehicle_id, status);

create table public.repair_items (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  repair_order_id     uuid not null references public.repair_orders(id) on delete cascade,
  vehicle_id          uuid not null references public.vehicles(id) on delete restrict,
  inspection_item_id  uuid references public.inspection_items(id) on delete set null,
  area                public.vehicle_area,
  problem             text,
  service             text not null,
  estimated_cost      numeric(12,2) not null default 0 check (estimated_cost >= 0), -- mão de obra prevista
  estimated_hours     numeric(7,2) check (estimated_hours >= 0),
  status              public.repair_status not null default 'pending',
  started_at          date,
  completed_at        date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index repair_items_order_idx on public.repair_items(repair_order_id);
create index repair_items_vehicle_idx on public.repair_items(vehicle_id);

alter table public.parts
  add constraint parts_repair_item_fk foreign key (repair_item_id) references public.repair_items(id) on delete set null;

-- Custo REAL de mão de obra/serviço. Valor = flat_amount ou horas × valor/hora.
create table public.labor_entries (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id        uuid not null references public.vehicles(id) on delete restrict,
  repair_order_id   uuid references public.repair_orders(id) on delete restrict,
  repair_item_id    uuid references public.repair_items(id) on delete restrict,
  supplier_id       uuid references public.suppliers(id) on delete restrict,
  worker_id         uuid references public.profiles(id),
  worker_name       text,
  description       text not null,
  work_date         date not null default current_date,
  hours             numeric(7,2) check (hours >= 0),
  hourly_rate       numeric(12,2) check (hourly_rate >= 0),
  flat_amount       numeric(12,2) check (flat_amount >= 0),
  amount            numeric(12,2) generated always as (coalesce(flat_amount, round(hours * hourly_rate, 2))) stored,
  invoice_number    text,
  status            text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  notes             text,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint labor_entries_amount_source check (flat_amount is not null or (hours is not null and hourly_rate is not null))
);
create index labor_entries_vehicle_idx on public.labor_entries(vehicle_id);
create index labor_entries_item_idx on public.labor_entries(repair_item_id);

create or replace function app.repair_child_consistency()
returns trigger language plpgsql as $$
declare v_vehicle uuid;
begin
  if tg_table_name = 'repair_items' then
    select vehicle_id into v_vehicle from public.repair_orders where id = new.repair_order_id;
    if v_vehicle <> new.vehicle_id then raise exception 'O serviço e a ordem de reparo precisam ser do mesmo veículo.'; end if;
    if new.status = 'in_progress' then new.started_at := coalesce(new.started_at, current_date); end if;
    if new.status = 'completed' then new.completed_at := coalesce(new.completed_at, current_date); end if;
  else -- labor_entries
    if new.repair_item_id is not null then
      select vehicle_id, repair_order_id into v_vehicle, new.repair_order_id
      from public.repair_items where id = new.repair_item_id;
      if v_vehicle <> new.vehicle_id then raise exception 'O lançamento e o serviço precisam ser do mesmo veículo.'; end if;
    elsif new.repair_order_id is not null then
      select vehicle_id into v_vehicle from public.repair_orders where id = new.repair_order_id;
      if v_vehicle <> new.vehicle_id then raise exception 'O lançamento e a ordem de reparo precisam ser do mesmo veículo.'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger repair_items_consistency before insert or update on public.repair_items
  for each row execute function app.repair_child_consistency();
create trigger labor_entries_consistency before insert or update on public.labor_entries
  for each row execute function app.repair_child_consistency();

create or replace function app.repair_order_before_write()
returns trigger language plpgsql as $$
begin
  if new.status = 'in_progress' then new.start_date := coalesce(new.start_date, current_date); end if;
  if new.status = 'completed' then new.completed_date := coalesce(new.completed_date, current_date); end if;
  return new;
end $$;
create trigger repair_orders_before_write before insert or update on public.repair_orders
  for each row execute function app.repair_order_before_write();

-- -----------------------------------------------------------------------------
-- Transporte
-- -----------------------------------------------------------------------------
create table public.transport_orders (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id              uuid not null references public.vehicles(id) on delete restrict,
  supplier_id             uuid references public.suppliers(id) on delete restrict,
  carrier_name            text,
  contact_name            text,
  contact_phone           text,
  pickup_address          text,
  destination_address     text,
  pickup_date             date,
  expected_delivery_date  date,
  delivered_at            timestamptz,
  estimated_cost          numeric(12,2) not null default 0 check (estimated_cost >= 0),
  actual_cost             numeric(12,2) check (actual_cost >= 0),
  booking_reference       text,
  status                  text not null default 'quoted' check (status in ('quoted', 'booked', 'picked_up', 'in_transit', 'delivered', 'cancelled')),
  notes                   text,
  created_by              uuid default auth.uid(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index transport_orders_vehicle_idx on public.transport_orders(vehicle_id);

-- Atualiza o status do veículo conforme o transporte avança
create or replace function app.transport_sync_vehicle()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'booked' then
    update public.vehicles set status = 'awaiting_pickup'
    where id = new.vehicle_id and status = 'purchased';
  elsif new.status in ('picked_up', 'in_transit') then
    update public.vehicles set status = 'in_transit'
    where id = new.vehicle_id and status in ('purchased', 'awaiting_pickup');
  elsif new.status = 'delivered' then
    if new.delivered_at is null then
      update public.transport_orders set delivered_at = now() where id = new.id;
    end if;
    update public.vehicles set status = 'received'
    where id = new.vehicle_id and status in ('purchased', 'awaiting_pickup', 'in_transit');
  end if;
  return new;
end $$;
create trigger transport_orders_sync_vehicle after insert or update on public.transport_orders
  for each row execute function app.transport_sync_vehicle();

-- -----------------------------------------------------------------------------
-- Documentação
-- -----------------------------------------------------------------------------
create table public.documents (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id        uuid references public.vehicles(id) on delete restrict,
  opportunity_id    uuid references public.auction_opportunities(id) on delete restrict,
  doc_type          public.document_type not null,
  title             text,
  reference_number  text,
  issue_date        date,
  due_date          date,     -- prazo para obter/entregar
  expires_at        date,
  status            public.document_status not null default 'pending',
  is_required       boolean not null default true,
  storage_bucket    text,
  storage_path      text,
  notes             text,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index documents_vehicle_idx on public.documents(vehicle_id, status);

-- -----------------------------------------------------------------------------
-- Anexos (fotos, vídeos, recibos) de qualquer registro
-- Caminho no Storage: {company_id}/{entity_type}/{entity_id}/{arquivo}
-- -----------------------------------------------------------------------------
create table public.attachments (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  entity_type     text not null check (entity_type in (
                    'auction_opportunity', 'damage_assessment', 'vehicle', 'vehicle_purchase',
                    'inspection', 'inspection_item', 'part', 'part_order', 'repair_order',
                    'repair_item', 'labor_entry', 'transport_order', 'document', 'expense',
                    'listing', 'sale', 'sale_payment', 'financial_transaction')),
  entity_id       uuid not null,
  vehicle_id      uuid references public.vehicles(id) on delete restrict,
  opportunity_id  uuid references public.auction_opportunities(id) on delete cascade,
  kind            text not null default 'photo' check (kind in ('photo', 'video', 'receipt', 'invoice', 'document', 'other')),
  stage           text check (stage in ('before', 'after')),
  bucket          text not null,
  path            text not null,
  file_name       text,
  mime_type       text,
  size_bytes      bigint,
  caption         text,
  sort_order      integer not null default 0,
  uploaded_by     uuid default auth.uid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (bucket, path)
);
create index attachments_entity_idx on public.attachments(entity_type, entity_id);
create index attachments_vehicle_idx on public.attachments(vehicle_id);

-- -----------------------------------------------------------------------------
-- Anúncios, interessados e propostas
-- -----------------------------------------------------------------------------
create table public.listings (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id   uuid not null references public.vehicles(id) on delete restrict,
  platform     text not null, -- Facebook Marketplace, site próprio, Craigslist...
  url          text,
  title        text,
  description  text,
  price        numeric(12,2) check (price >= 0),
  listed_at    date not null default current_date,
  ended_at     date,
  status       text not null default 'active' check (status in ('draft', 'active', 'paused', 'ended')),
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index listings_vehicle_idx on public.listings(vehicle_id);

create table public.vehicle_offers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id    uuid not null references public.vehicles(id) on delete restrict,
  customer_id   uuid references public.customers(id) on delete set null,
  listing_id    uuid references public.listings(id) on delete set null,
  contact_name  text,
  contact_phone text,
  channel       text,
  offer_amount  numeric(12,2) check (offer_amount > 0), -- nulo = apenas interessado
  offered_at    timestamptz not null default now(),
  status        text not null default 'open' check (status in ('open', 'countered', 'accepted', 'rejected', 'expired', 'withdrawn')),
  counter_amount numeric(12,2) check (counter_amount > 0),
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (customer_id is not null or contact_name is not null)
);
create index vehicle_offers_vehicle_idx on public.vehicle_offers(vehicle_id, offered_at desc);

-- >>> 20261110000005_sales_finance.sql
-- =============================================================================
-- CARKING — 05 · Vendas e financeiro
-- =============================================================================
-- Contas a pagar são geradas automaticamente a partir dos custos lançados nos
-- módulos operacionais (uma conta por origem, sem duplicar). Pagamentos e
-- recebimentos são financial_transactions; saldos de contas a pagar/receber são
-- recalculados a partir delas.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Vendas
-- -----------------------------------------------------------------------------
create table public.sales (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id       uuid not null references public.vehicles(id) on delete restrict,
  customer_id      uuid not null references public.customers(id) on delete restrict,
  seller_id        uuid references public.profiles(id),
  sale_date        date not null default current_date,
  listed_price     numeric(12,2) check (listed_price >= 0),
  offer_amount     numeric(12,2) check (offer_amount >= 0),
  discount         numeric(12,2) not null default 0 check (discount >= 0),
  final_price      numeric(12,2) not null check (final_price > 0),
  payment_method   text check (payment_method in ('cash', 'check', 'wire', 'zelle', 'card', 'financing', 'mixed', 'other')),
  down_payment     numeric(12,2) not null default 0 check (down_payment >= 0),
  installments     integer not null default 1 check (installments >= 1),
  first_due_date   date,
  status           text not null default 'completed' check (status in ('pending', 'completed', 'cancelled')),
  cancel_reason    text,
  contract_path    text,
  receipt_path     text,
  notes            text,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (down_payment <= final_price)
);
-- Não permitir venda duplicada do mesmo veículo
create unique index sales_one_active_per_vehicle on public.sales(vehicle_id) where status <> 'cancelled';
create index sales_company_date_idx on public.sales(company_id, sale_date);

-- -----------------------------------------------------------------------------
-- Contas financeiras (cadastro manual, sem integração bancária)
-- -----------------------------------------------------------------------------
create table public.financial_accounts (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  name             text not null,
  account_type     text not null check (account_type in ('bank', 'cash', 'credit_card', 'other')),
  institution      text,
  last4            text check (last4 ~ '^[0-9]{4}$'),
  opening_balance  numeric(12,2) not null default 0,
  opening_date     date not null default current_date,
  currency         char(3) not null default 'USD',
  is_active        boolean not null default true,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, name)
);

-- -----------------------------------------------------------------------------
-- Contas a pagar e a receber
-- -----------------------------------------------------------------------------
create table public.accounts_payable (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  vehicle_id    uuid references public.vehicles(id) on delete restrict,
  supplier_id   uuid references public.suppliers(id) on delete restrict,
  category_id   uuid references public.expense_categories(id) on delete restrict,
  description   text not null,
  source_type   text not null default 'manual' check (source_type in (
                  'vehicle_purchase', 'transport_order', 'part', 'part_order',
                  'labor_entry', 'expense', 'manual')),
  source_id     uuid,
  amount        numeric(12,2) not null check (amount >= 0),
  paid_amount   numeric(12,2) not null default 0,
  balance       numeric(12,2) generated always as (amount - paid_amount) stored,
  issue_date    date not null default current_date,
  due_date      date,
  status        text not null default 'open' check (status in ('open', 'partial', 'paid', 'cancelled')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (source_type = 'manual' or source_id is not null)
);
create unique index accounts_payable_source_uq on public.accounts_payable(source_type, source_id) where source_id is not null;
create index accounts_payable_company_due_idx on public.accounts_payable(company_id, status, due_date);
create index accounts_payable_vehicle_idx on public.accounts_payable(vehicle_id);

create table public.accounts_receivable (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  customer_id      uuid references public.customers(id) on delete restrict,
  vehicle_id       uuid references public.vehicles(id) on delete restrict,
  sale_id          uuid references public.sales(id) on delete restrict,
  description      text not null,
  amount           numeric(12,2) not null check (amount >= 0),
  received_amount  numeric(12,2) not null default 0,
  balance          numeric(12,2) generated always as (amount - received_amount) stored,
  issue_date       date not null default current_date,
  due_date         date,
  status           text not null default 'open' check (status in ('open', 'partial', 'received', 'cancelled')),
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index accounts_receivable_sale_uq on public.accounts_receivable(sale_id) where sale_id is not null;
create index accounts_receivable_company_due_idx on public.accounts_receivable(company_id, status, due_date);

-- -----------------------------------------------------------------------------
-- Transferências e transações (movimentações de caixa)
-- -----------------------------------------------------------------------------
create table public.financial_transfers (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  from_account_id  uuid not null references public.financial_accounts(id) on delete restrict,
  to_account_id    uuid not null references public.financial_accounts(id) on delete restrict,
  amount           numeric(12,2) not null check (amount > 0),
  transfer_date    date not null default current_date,
  description      text,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);

create table public.sale_payments (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  sale_id               uuid not null references public.sales(id) on delete restrict,
  financial_account_id  uuid not null references public.financial_accounts(id) on delete restrict,
  paid_at               date not null default current_date,
  amount                numeric(12,2) not null check (amount > 0),
  method                text,
  reference             text,
  status                text not null default 'confirmed' check (status in ('confirmed', 'cancelled')),
  notes                 text,
  created_by            uuid default auth.uid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index sale_payments_sale_idx on public.sale_payments(sale_id);

create table public.financial_transactions (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  account_id       uuid not null references public.financial_accounts(id) on delete restrict,
  direction        text not null check (direction in ('in', 'out')),
  amount           numeric(12,2) not null check (amount > 0),
  transaction_date date not null default current_date,
  description      text not null,
  category_id      uuid references public.expense_categories(id) on delete restrict,
  vehicle_id       uuid references public.vehicles(id) on delete restrict,
  supplier_id      uuid references public.suppliers(id) on delete restrict,
  customer_id      uuid references public.customers(id) on delete restrict,
  payable_id       uuid references public.accounts_payable(id) on delete restrict,
  receivable_id    uuid references public.accounts_receivable(id) on delete restrict,
  sale_payment_id  uuid unique references public.sale_payments(id) on delete restrict,
  transfer_id      uuid references public.financial_transfers(id) on delete restrict,
  status           text not null default 'confirmed' check (status in ('pending', 'confirmed', 'reversed', 'cancelled')),
  reversal_reason  text,
  proof_path       text,
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (not (payable_id is not null and receivable_id is not null)),
  check (payable_id is null or direction = 'out'),
  check (receivable_id is null or direction = 'in')
);
create index financial_transactions_account_idx on public.financial_transactions(account_id, transaction_date);
create index financial_transactions_company_idx on public.financial_transactions(company_id, transaction_date);
create index financial_transactions_payable_idx on public.financial_transactions(payable_id);
create index financial_transactions_receivable_idx on public.financial_transactions(receivable_id);

-- =============================================================================
-- Regras financeiras
-- =============================================================================

-- Transações confirmadas não podem ser apagadas nem alteradas silenciosamente;
-- só podem ser estornadas (status 'reversed', com motivo).
create or replace function app.transaction_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('confirmed', 'reversed') then
      raise exception 'Transações confirmadas não podem ser excluídas. Estorne a transação (status reversed).';
    end if;
    return old;
  end if;
  if old.status in ('reversed', 'cancelled') and new is distinct from old then
    raise exception 'Transação estornada/cancelada não pode ser alterada.';
  end if;
  if old.status = 'confirmed' then
    if new.status not in ('confirmed', 'reversed') then
      raise exception 'Transação confirmada só pode ser estornada.';
    end if;
    if (new.amount, new.direction, new.account_id, new.transaction_date, new.payable_id, new.receivable_id)
       is distinct from (old.amount, old.direction, old.account_id, old.transaction_date, old.payable_id, old.receivable_id) then
      raise exception 'Valores de uma transação confirmada não podem ser alterados. Estorne e lance novamente.';
    end if;
    if new.status = 'reversed' and coalesce(trim(new.reversal_reason), '') = '' then
      raise exception 'Informe o motivo do estorno.';
    end if;
  end if;
  return new;
end $$;
create trigger financial_transactions_guard before update or delete on public.financial_transactions
  for each row execute function app.transaction_guard();

create or replace function app.refresh_payable(p_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_paid numeric(12,2);
begin
  if p_id is null then return; end if;
  select coalesce(sum(amount), 0) into v_paid
  from public.financial_transactions where payable_id = p_id and status = 'confirmed';
  update public.accounts_payable
     set paid_amount = v_paid,
         status = case
           when status = 'cancelled' and v_paid = 0 then 'cancelled'
           when v_paid >= amount and amount > 0 then 'paid'
           when v_paid > 0 then 'partial'
           else 'open' end
   where id = p_id;
end $$;

create or replace function app.refresh_receivable(p_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_recv numeric(12,2);
begin
  if p_id is null then return; end if;
  select coalesce(sum(amount), 0) into v_recv
  from public.financial_transactions where receivable_id = p_id and status = 'confirmed';
  update public.accounts_receivable
     set received_amount = v_recv,
         status = case
           when status = 'cancelled' and v_recv = 0 then 'cancelled'
           when v_recv >= amount and amount > 0 then 'received'
           when v_recv > 0 then 'partial'
           else 'open' end
   where id = p_id;
end $$;

create or replace function app.transaction_after_write()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  perform app.refresh_payable(new.payable_id);
  perform app.refresh_receivable(new.receivable_id);
  if tg_op = 'UPDATE' then
    if old.payable_id is distinct from new.payable_id then perform app.refresh_payable(old.payable_id); end if;
    if old.receivable_id is distinct from new.receivable_id then perform app.refresh_receivable(old.receivable_id); end if;
  end if;
  return new;
end $$;
create trigger financial_transactions_after_write after insert or update on public.financial_transactions
  for each row execute function app.transaction_after_write();

-- Cria/atualiza a conta a pagar de uma origem operacional (uma por origem).
-- p_amount nulo ou zero => cancela a conta, se ainda não houver pagamentos.
create or replace function app.sync_payable(
  p_company uuid, p_source_type text, p_source_id uuid, p_vehicle uuid, p_supplier uuid,
  p_category_group public.cost_group, p_description text, p_amount numeric, p_due date)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_category uuid;
begin
  select id into v_category from public.expense_categories
  where company_id = p_company and cost_group = p_category_group and is_system
  order by created_at limit 1;

  select id into v_id from public.accounts_payable where source_type = p_source_type and source_id = p_source_id;

  if coalesce(p_amount, 0) <= 0 then
    if v_id is not null then
      update public.accounts_payable set status = 'cancelled'
      where id = v_id and paid_amount = 0;
    end if;
    return;
  end if;

  if v_id is null then
    insert into public.accounts_payable (company_id, vehicle_id, supplier_id, category_id, description,
                                         source_type, source_id, amount, due_date)
    values (p_company, p_vehicle, p_supplier, v_category, p_description, p_source_type, p_source_id, p_amount, p_due)
    returning id into v_id;
  else
    update public.accounts_payable
       set amount = p_amount, supplier_id = p_supplier, description = p_description,
           due_date = coalesce(due_date, p_due),
           status = case when status = 'cancelled' then 'open' else status end
     where id = v_id;
  end if;
  perform app.refresh_payable(v_id);
end $$;

-- Gatilhos de geração de contas a pagar a partir dos módulos operacionais
create or replace function app.payable_from_source()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_vehicle_label text;
  v_order_total numeric(12,2);
begin
  if tg_table_name = 'vehicle_purchases' then
    select concat_ws(' ', year, make, model) into v_vehicle_label from public.vehicles where id = new.vehicle_id;
    perform app.sync_payable(new.company_id, 'vehicle_purchase', new.id, new.vehicle_id, new.supplier_id, 'purchase',
      'Compra em leilão — ' || coalesce(v_vehicle_label, '') || coalesce(' (lote ' || new.lot_number || ')', ''),
      new.total_paid_to_auction, coalesce(new.payment_due_date, new.purchase_date + 3));

  elsif tg_table_name = 'transport_orders' then
    perform app.sync_payable(new.company_id, 'transport_order', new.id, new.vehicle_id, new.supplier_id, 'transport',
      'Transporte — ' || coalesce(new.carrier_name, 'transportadora'),
      case when new.status = 'cancelled' then null else new.actual_cost end,
      coalesce(new.delivered_at::date, new.pickup_date, current_date));

  elsif tg_table_name = 'labor_entries' then
    if new.supplier_id is not null or (tg_op = 'UPDATE' and old.supplier_id is not null) then
      perform app.sync_payable(new.company_id, 'labor_entry', new.id, new.vehicle_id, new.supplier_id, 'labor',
        'Mão de obra — ' || new.description,
        case when new.status = 'cancelled' or new.supplier_id is null then null else new.amount end,
        new.work_date + 7);
    end if;

  elsif tg_table_name = 'parts' then
    -- peça sem pedido: uma conta por peça; com pedido: recalcula a conta do pedido
    if new.part_order_id is null then
      perform app.sync_payable(new.company_id, 'part', new.id, new.vehicle_id, new.supplier_id, 'parts',
        'Peça — ' || new.name,
        case when new.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned')
             then new.actual_total - new.refund_amount end,
        coalesce(new.purchase_date, current_date));
    else
      perform app.sync_payable(new.company_id, 'part', new.id, null, null, 'parts', '', null, null);
      perform app.sync_part_order_payable(new.part_order_id);
    end if;
    if tg_op = 'UPDATE' and old.part_order_id is not null and old.part_order_id is distinct from new.part_order_id then
      perform app.sync_part_order_payable(old.part_order_id);
    end if;

  elsif tg_table_name = 'part_orders' then
    perform app.sync_part_order_payable(new.id);

  elsif tg_table_name = 'expenses' then
    perform app.sync_payable(new.company_id, 'expense', new.id, new.vehicle_id, new.supplier_id,
      (select cost_group from public.expense_categories where id = new.category_id),
      new.description,
      case when new.status = 'cancelled' then null else new.amount end,
      coalesce(new.due_date, new.expense_date));
  end if;
  return new;
end $$;

create or replace function app.sync_part_order_payable(p_order_id uuid)
returns void language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  o public.part_orders;
  v_total numeric(12,2);
begin
  select * into o from public.part_orders where id = p_order_id;
  if not found then return; end if;
  select coalesce(sum(p.actual_total - p.refund_amount), 0) into v_total
  from public.parts p
  where p.part_order_id = o.id
    and p.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned');
  if o.status = 'cancelled' then
    v_total := null;
  elsif o.status <> 'draft' then
    v_total := v_total + o.shipping_cost + o.tax + o.other_fees;
  end if;
  perform app.sync_payable(o.company_id, 'part_order', o.id, o.vehicle_id, o.supplier_id, 'parts',
    'Pedido de peças' || coalesce(' #' || o.order_number, ''), v_total, o.order_date);
end $$;

create trigger vehicle_purchases_payable after insert or update on public.vehicle_purchases
  for each row execute function app.payable_from_source();
create trigger transport_orders_payable after insert or update on public.transport_orders
  for each row execute function app.payable_from_source();
create trigger labor_entries_payable after insert or update on public.labor_entries
  for each row execute function app.payable_from_source();
create trigger parts_payable after insert or update on public.parts
  for each row execute function app.payable_from_source();
create trigger part_orders_payable after insert or update on public.part_orders
  for each row execute function app.payable_from_source();
create trigger expenses_payable after insert or update on public.expenses
  for each row execute function app.payable_from_source();

-- Venda concluída => veículo vendido + conta a receber. Cancelada => reverte.
create or replace function app.sale_after_write()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
  v_recv uuid;
begin
  select concat_ws(' ', year, make, model) into v_label from public.vehicles where id = new.vehicle_id;

  if new.status = 'completed' then
    update public.vehicles set status = 'sold', sold_at = coalesce(sold_at, new.sale_date::timestamptz)
    where id = new.vehicle_id;
    insert into public.accounts_receivable (company_id, customer_id, vehicle_id, sale_id, description, amount, due_date)
    values (new.company_id, new.customer_id, new.vehicle_id, new.id, 'Venda — ' || coalesce(v_label, ''),
            new.final_price, coalesce(new.first_due_date, new.sale_date))
    on conflict (sale_id) where sale_id is not null
    do update set amount = excluded.amount, customer_id = excluded.customer_id,
                  status = case when accounts_receivable.status = 'cancelled' then 'open' else accounts_receivable.status end
    returning id into v_recv;
    perform app.refresh_receivable(v_recv);

    update public.vehicle_offers set status = 'accepted'
    where vehicle_id = new.vehicle_id and customer_id = new.customer_id and status in ('open', 'countered');

  elsif new.status = 'cancelled' and tg_op = 'UPDATE' and old.status <> 'cancelled' then
    if exists (select 1 from public.sale_payments where sale_id = new.id and status = 'confirmed') then
      raise exception 'A venda possui pagamentos confirmados. Cancele/estorne os pagamentos antes de cancelar a venda.';
    end if;
    if coalesce(trim(new.cancel_reason), '') = '' then
      raise exception 'Informe o motivo do cancelamento da venda.';
    end if;
    update public.accounts_receivable set status = 'cancelled' where sale_id = new.id;
    update public.vehicles set status = 'ready_for_sale', sold_at = null where id = new.vehicle_id;
  end if;
  return new;
end $$;
create trigger sales_after_write after insert or update on public.sales
  for each row execute function app.sale_after_write();

create or replace function app.sale_before_write()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'Venda cancelada não pode ser reativada; registre uma nova venda.';
  end if;
  if tg_op = 'UPDATE' and old.status = 'completed' and new.status = 'completed'
     and (new.final_price, new.vehicle_id) is distinct from (old.final_price, old.vehicle_id)
     and exists (select 1 from public.sale_payments where sale_id = new.id and status = 'confirmed') then
    raise exception 'Valor/veículo de uma venda com pagamentos não pode ser alterado.';
  end if;
  return new;
end $$;
create trigger sales_before_write before insert or update on public.sales
  for each row execute function app.sale_before_write();

-- Pagamento de venda => transação de entrada vinculada à conta a receber
create or replace function app.sale_payment_after_write()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  s public.sales;
  v_recv uuid;
begin
  select * into s from public.sales where id = new.sale_id;
  if s.status = 'cancelled' then
    raise exception 'Não é possível registrar pagamento em venda cancelada.';
  end if;
  select id into v_recv from public.accounts_receivable where sale_id = new.sale_id;

  if tg_op = 'INSERT' and new.status = 'confirmed' then
    insert into public.financial_transactions (company_id, account_id, direction, amount, transaction_date,
      description, vehicle_id, customer_id, receivable_id, sale_payment_id, status, created_by)
    values (new.company_id, new.financial_account_id, 'in', new.amount, new.paid_at,
      'Recebimento de venda', s.vehicle_id, s.customer_id, v_recv, new.id, 'confirmed', auth.uid());
  elsif tg_op = 'UPDATE' then
    if (new.amount, new.financial_account_id, new.paid_at) is distinct from (old.amount, old.financial_account_id, old.paid_at) then
      raise exception 'Pagamento registrado não pode ser alterado. Cancele e lance novamente.';
    end if;
    if old.status = 'confirmed' and new.status = 'cancelled' then
      update public.financial_transactions
         set status = 'reversed', reversal_reason = coalesce(new.notes, 'Pagamento de venda cancelado')
       where sale_payment_id = new.id and status = 'confirmed';
    elsif old.status = 'cancelled' and new.status = 'confirmed' then
      raise exception 'Pagamento cancelado não pode ser reativado.';
    end if;
  end if;
  return new;
end $$;
create trigger sale_payments_after_write after insert or update on public.sale_payments
  for each row execute function app.sale_payment_after_write();

-- Transferência => saída da conta de origem + entrada na conta de destino
create or replace function app.transfer_after_insert()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.financial_transactions (company_id, account_id, direction, amount, transaction_date, description, transfer_id, created_by)
  values (new.company_id, new.from_account_id, 'out', new.amount, new.transfer_date,
          coalesce(new.description, 'Transferência enviada'), new.id, auth.uid()),
         (new.company_id, new.to_account_id, 'in', new.amount, new.transfer_date,
          coalesce(new.description, 'Transferência recebida'), new.id, auth.uid());
  return new;
end $$;
create trigger financial_transfers_after_insert after insert on public.financial_transfers
  for each row execute function app.transfer_after_insert();

create or replace function app.transfer_guard()
returns trigger language plpgsql as $$
begin
  raise exception 'Transferências não podem ser alteradas ou excluídas; estorne as transações geradas.';
end $$;
create trigger financial_transfers_guard before update or delete on public.financial_transfers
  for each row execute function app.transfer_guard();

-- >>> 20261110000006_calculations.sql
-- =============================================================================
-- CARKING — 06 · Inteligência financeira: taxas, lance máximo, simulações,
--               razão de custos, orçamento x real, lucratividade e alertas
-- =============================================================================
-- Fórmulas (iguais em todo o sistema):
--   INVESTIMENTO = lance + taxas do leilão + transporte + documentação + peças
--                  + mão de obra + inspeção + outros + reserva de imprevistos
--   LUCRO        = preço de venda − investimento − despesas de venda
--   MARGEM (%)   = lucro ÷ preço de venda × 100
--   ROI (%)      = lucro ÷ investimento × 100
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Taxas do leilão para um valor de lance (tabela por plataforma)
-- -----------------------------------------------------------------------------
create or replace function public.calculate_auction_fees(p_source_id uuid, p_bid numeric)
returns numeric
language sql stable
set search_path = public, pg_temp
as $$
  select round(
    coalesce((select s.flat_fees from public.auction_sources s where s.id = p_source_id), 0)
    + coalesce((
        select sum(t.fixed_fee + p_bid * t.percent_fee / 100)
        from public.auction_fee_tiers t
        where t.source_id = p_source_id
          and p_bid >= t.min_amount
          and (t.max_amount is null or p_bid < t.max_amount)
      ), 0), 2)
$$;

-- -----------------------------------------------------------------------------
-- Lance máximo recomendado
-- -----------------------------------------------------------------------------
-- Encontra o MAIOR lance B tal que, com as taxas que dependem de B:
--   lucro  >= p_min_profit
--   margem >= p_min_margin_pct
--   ROI    >= p_min_roi_pct
-- Como as taxas variam por faixa, o cálculo percorre cada faixa da tabela
-- (onde a taxa é linear: a + b·B) e resolve B analiticamente; depois arredonda
-- para o incremento de lance da plataforma e confere o resultado.
-- p_other_costs = todos os custos exceto lance e taxas (incluindo imprevistos).
create or replace function public.calculate_max_bid(
  p_source_id       uuid,
  p_sale_price      numeric,
  p_other_costs     numeric,
  p_selling_costs   numeric default 0,
  p_min_profit      numeric default null,
  p_min_margin_pct  numeric default null,
  p_min_roi_pct     numeric default null,
  p_fees_override   numeric default null
)
returns table (
  max_bid           numeric,
  auction_fees      numeric,
  total_investment  numeric,
  projected_profit  numeric,
  margin_pct        numeric,
  roi_pct           numeric,
  binding_rule      text
)
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_net     numeric := p_sale_price - coalesce(p_selling_costs, 0);
  v_cap     numeric;              -- investimento máximo permitido
  v_rule    text := 'break_even';
  v_budget  numeric;              -- disponível para lance + taxas
  v_inc     numeric := 1;
  v_flat    numeric := 0;
  v_tiered  boolean;
  v_bps     numeric[];
  v_lo      numeric;
  v_hi      numeric;
  v_a       numeric;
  v_b       numeric;
  v_cand    numeric;
  v_best    numeric;
  v_fees    numeric;
  v_guard   integer := 0;
begin
  if p_sale_price is null or p_sale_price <= 0 then
    raise exception 'Informe o preço estimado de venda.';
  end if;

  v_cap := v_net;
  if p_min_profit is not null and v_net - p_min_profit < v_cap then
    v_cap := v_net - p_min_profit; v_rule := 'min_profit';
  end if;
  if p_min_margin_pct is not null and v_net - p_sale_price * p_min_margin_pct / 100 < v_cap then
    v_cap := v_net - p_sale_price * p_min_margin_pct / 100; v_rule := 'min_margin';
  end if;
  if p_min_roi_pct is not null and v_net / (1 + p_min_roi_pct / 100) < v_cap then
    v_cap := v_net / (1 + p_min_roi_pct / 100); v_rule := 'min_roi';
  end if;
  v_budget := v_cap - coalesce(p_other_costs, 0);

  if p_source_id is not null then
    select s.bid_increment, s.flat_fees into v_inc, v_flat from public.auction_sources s where s.id = p_source_id;
    v_inc := coalesce(v_inc, 1); v_flat := coalesce(v_flat, 0);
  end if;

  v_tiered := p_fees_override is null and p_source_id is not null
              and exists (select 1 from public.auction_fee_tiers t where t.source_id = p_source_id);

  if not v_tiered then
    v_best := v_budget - coalesce(p_fees_override, v_flat);
  else
    select array_agg(x order by x) into v_bps from (
      select 0::numeric as x
      union select t.min_amount from public.auction_fee_tiers t where t.source_id = p_source_id
      union select t.max_amount from public.auction_fee_tiers t where t.source_id = p_source_id and t.max_amount is not null
    ) q;

    for i in 1 .. array_length(v_bps, 1) loop
      v_lo := v_bps[i];
      v_hi := case when i < array_length(v_bps, 1) then v_bps[i + 1] end;
      select v_flat + coalesce(sum(t.fixed_fee), 0), coalesce(sum(t.percent_fee), 0) / 100
        into v_a, v_b
      from public.auction_fee_tiers t
      where t.source_id = p_source_id and v_lo >= t.min_amount and (t.max_amount is null or v_lo < t.max_amount);

      v_cand := (v_budget - v_a) / (1 + v_b);
      if v_cand >= v_lo then
        if v_hi is not null and v_cand >= v_hi then v_cand := v_hi - 0.01; end if;
        v_best := greatest(coalesce(v_best, v_cand), v_cand);
      end if;
    end loop;
  end if;

  if v_best is null or v_best <= 0 then
    v_best := 0;
    v_rule := 'not_viable';
  else
    v_best := floor(v_best / v_inc) * v_inc;
    -- conferência (protege contra faixas cuja taxa diminui ao subir o lance)
    loop
      v_fees := case when v_tiered then public.calculate_auction_fees(p_source_id, v_best)
                     else coalesce(p_fees_override, v_flat) end;
      exit when v_best <= 0 or v_best + v_fees <= v_budget + 0.005 or v_guard > 100000;
      v_best := v_best - v_inc;
      v_guard := v_guard + 1;
    end loop;
    if v_best <= 0 then v_best := 0; v_rule := 'not_viable'; end if;
  end if;

  v_fees := case when v_tiered then public.calculate_auction_fees(p_source_id, v_best)
                 else coalesce(p_fees_override, v_flat) end;

  max_bid          := round(v_best, 2);
  auction_fees     := round(v_fees, 2);
  total_investment := round(v_best + v_fees + coalesce(p_other_costs, 0), 2);
  projected_profit := round(v_net - total_investment, 2);
  margin_pct       := round(projected_profit / p_sale_price * 100, 4);
  roi_pct          := case when total_investment > 0 then round(projected_profit / total_investment * 100, 4) end;
  binding_rule     := v_rule;
  return next;
end $$;

-- -----------------------------------------------------------------------------
-- Cálculo de uma simulação (usado pelo trigger e pela calculadora ao vivo)
-- -----------------------------------------------------------------------------
create or replace function app.compute_simulation(s public.auction_simulations, p_source_id uuid)
returns public.auction_simulations
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_other numeric;
  v_net   numeric;
  m       record;
begin
  s.contingency_total := round(coalesce(
    s.contingency_amount,
    (s.parts_cost + s.labor_cost + s.inspection_cost + s.other_costs) * coalesce(s.contingency_pct, 0) / 100,
    0), 2);

  s.auction_fees := coalesce(s.auction_fees_override, public.calculate_auction_fees(p_source_id, s.planned_bid));

  v_other := s.transport_cost + s.documentation_cost + s.parts_cost + s.labor_cost
           + s.inspection_cost + s.other_costs + s.contingency_total;
  v_net   := s.expected_sale_price - s.selling_costs;

  s.total_investment      := round(s.planned_bid + s.auction_fees + v_other, 2);
  s.projected_profit      := round(v_net - s.total_investment, 2);
  s.margin_pct            := round(s.projected_profit / s.expected_sale_price * 100, 4);
  s.roi_pct               := case when s.total_investment > 0 then round(s.projected_profit / s.total_investment * 100, 4) end;
  s.conservative_profit   := case when s.conservative_sale_price is not null
                                  then round(s.conservative_sale_price - s.selling_costs - s.total_investment, 2) end;
  s.optimistic_profit     := case when s.optimistic_sale_price is not null
                                  then round(s.optimistic_sale_price - s.selling_costs - s.total_investment, 2) end;
  s.break_even_sale_price := round(s.total_investment + s.selling_costs, 2);

  select * into m from public.calculate_max_bid(
    p_source_id, s.expected_sale_price, v_other, s.selling_costs,
    s.min_profit, s.min_margin_pct, s.min_roi_pct, s.auction_fees_override);

  s.max_bid              := m.max_bid;
  s.max_bid_fees         := m.auction_fees;
  s.max_bid_binding_rule := m.binding_rule;
  s.decision := case
    when m.max_bid <= 0 then 'not_viable'
    when s.planned_bid <= m.max_bid then 'viable'
    else 'above_limit' end;
  return s;
end $$;

create or replace function app.simulation_before_write()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
declare
  c public.companies;
  v_source uuid;
begin
  if tg_op = 'UPDATE' and old.locked then
    raise exception 'Esta simulação foi usada na compra e está preservada. Crie uma nova simulação.';
  end if;
  select * into c from public.companies where id = new.company_id;
  if tg_op = 'INSERT' then
    new.min_profit     := coalesce(new.min_profit, c.default_min_profit);
    new.min_margin_pct := coalesce(new.min_margin_pct, c.default_min_margin_pct);
    new.min_roi_pct    := coalesce(new.min_roi_pct, nullif(c.default_min_roi_pct, 0));
    if new.contingency_amount is null and new.contingency_pct is null then
      new.contingency_pct := c.default_contingency_pct;
    end if;
  end if;
  select source_id into v_source from public.auction_opportunities where id = new.opportunity_id;
  new := app.compute_simulation(new, v_source);
  return new;
end $$;
create trigger auction_simulations_before_write before insert or update on public.auction_simulations
  for each row execute function app.simulation_before_write();

create or replace function app.simulation_before_delete()
returns trigger language plpgsql as $$
begin
  if old.locked then
    raise exception 'Esta simulação foi usada na compra e não pode ser excluída.';
  end if;
  return old;
end $$;
create trigger auction_simulations_before_delete before delete on public.auction_simulations
  for each row execute function app.simulation_before_delete();

-- Calculadora ao vivo (não grava nada) — chamada pelo FlutterFlow via RPC
create or replace function public.simulate_purchase(
  p_expected_sale_price     numeric,
  p_planned_bid             numeric default 0,
  p_source_id               uuid    default null,
  p_auction_fees_override   numeric default null,
  p_transport_cost          numeric default 0,
  p_documentation_cost      numeric default 0,
  p_parts_cost              numeric default 0,
  p_labor_cost              numeric default 0,
  p_inspection_cost         numeric default 0,
  p_other_costs             numeric default 0,
  p_contingency_amount      numeric default null,
  p_contingency_pct         numeric default null,
  p_selling_costs           numeric default 0,
  p_min_profit              numeric default null,
  p_min_margin_pct          numeric default null,
  p_min_roi_pct             numeric default null,
  p_conservative_sale_price numeric default null,
  p_optimistic_sale_price   numeric default null
)
returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
declare s public.auction_simulations;
begin
  s.expected_sale_price     := p_expected_sale_price;
  s.conservative_sale_price := p_conservative_sale_price;
  s.optimistic_sale_price   := p_optimistic_sale_price;
  s.planned_bid             := coalesce(p_planned_bid, 0);
  s.auction_fees_override   := p_auction_fees_override;
  s.transport_cost          := coalesce(p_transport_cost, 0);
  s.documentation_cost      := coalesce(p_documentation_cost, 0);
  s.parts_cost              := coalesce(p_parts_cost, 0);
  s.labor_cost              := coalesce(p_labor_cost, 0);
  s.inspection_cost         := coalesce(p_inspection_cost, 0);
  s.other_costs             := coalesce(p_other_costs, 0);
  s.contingency_amount      := p_contingency_amount;
  s.contingency_pct         := p_contingency_pct;
  s.selling_costs           := coalesce(p_selling_costs, 0);
  s.min_profit              := p_min_profit;
  s.min_margin_pct          := p_min_margin_pct;
  s.min_roi_pct             := p_min_roi_pct;
  s := app.compute_simulation(s, p_source_id);
  return jsonb_build_object(
    'auction_fees',          s.auction_fees,
    'contingency_total',     s.contingency_total,
    'total_investment',      s.total_investment,
    'projected_profit',      s.projected_profit,
    'margin_pct',            s.margin_pct,
    'roi_pct',               s.roi_pct,
    'conservative_profit',   s.conservative_profit,
    'optimistic_profit',     s.optimistic_profit,
    'break_even_sale_price', s.break_even_sale_price,
    'max_bid',               s.max_bid,
    'max_bid_fees',          s.max_bid_fees,
    'max_bid_binding_rule',  s.max_bid_binding_rule,
    'decision',              s.decision
  );
end $$;

-- Lances: registra o lance máximo vigente e avisa quando é ultrapassado
create or replace function app.bid_before_write()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    select s.max_bid into new.max_bid_at_time
    from public.auction_simulations s
    where s.opportunity_id = new.opportunity_id
    order by s.is_baseline desc, s.created_at desc
    limit 1;
  end if;
  new.exceeds_max_bid := new.max_bid_at_time is not null and new.amount > new.max_bid_at_time;
  return new;
end $$;
create trigger auction_bids_before_write before insert or update on public.auction_bids
  for each row execute function app.bid_before_write();

create or replace function app.bid_after_insert()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  update public.auction_opportunities set status = 'bid_placed'
  where id = new.opportunity_id and status = 'approved';
  return new;
end $$;
create trigger auction_bids_after_insert after insert on public.auction_bids
  for each row execute function app.bid_after_insert();

-- =============================================================================
-- VIEWS ANALÍTICAS
-- Executam com o dono da view e filtram explicitamente pela empresa do usuário
-- e pela permissão do módulo — assim os números são sempre completos e
-- consistentes, mesmo para perfis que não enxergam todas as tabelas de origem.
-- =============================================================================

-- Razão de custos REAIS por veículo (fonte única de verdade)
create or replace view public.vehicle_cost_ledger as
select * from (
  select p.company_id, p.vehicle_id, 'purchase'::public.cost_group as cost_group,
         'vehicle_purchase'::text as source_type, p.id as source_id,
         'Lance vencedor'::text as description, p.final_bid as amount, p.purchase_date as cost_date
  from public.vehicle_purchases p
  union all
  select p.company_id, p.vehicle_id, 'auction_fees', 'vehicle_purchase', p.id,
         'Taxas do leilão', p.auction_fees_total, p.purchase_date
  from public.vehicle_purchases p where p.auction_fees_total > 0
  union all
  select t.company_id, t.vehicle_id, 'transport', 'transport_order', t.id,
         'Transporte — ' || coalesce(t.carrier_name, ''), t.actual_cost,
         coalesce(t.delivered_at::date, t.pickup_date, t.created_at::date)
  from public.transport_orders t where t.status <> 'cancelled' and t.actual_cost is not null
  union all
  select pt.company_id, pt.vehicle_id, 'parts', 'part', pt.id,
         pt.name || case when pt.status = 'returned' then ' (devolvida)' else '' end,
         pt.actual_total - pt.refund_amount, coalesce(pt.purchase_date, pt.created_at::date)
  from public.parts pt
  where pt.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned')
  union all
  select o.company_id, o.vehicle_id, 'parts', 'part_order', o.id,
         'Frete/impostos do pedido' || coalesce(' #' || o.order_number, ''),
         o.shipping_cost + o.tax + o.other_fees, o.order_date
  from public.part_orders o
  where o.status not in ('draft', 'cancelled') and (o.shipping_cost + o.tax + o.other_fees) > 0
  union all
  select l.company_id, l.vehicle_id, 'labor', 'labor_entry', l.id, l.description, l.amount, l.work_date
  from public.labor_entries l where l.status = 'confirmed'
  union all
  select e.company_id, e.vehicle_id, c.cost_group, 'expense', e.id, e.description, e.amount, e.expense_date
  from public.expenses e join public.expense_categories c on c.id = e.category_id
  where e.vehicle_id is not null and e.status <> 'cancelled'
) ledger
where ledger.company_id = app.current_company_id()
  and app.has_permission('vehicles', 'view');

create or replace view public.vehicle_cost_summary as
select v.id as vehicle_id, v.company_id,
  coalesce(sum(l.amount) filter (where l.cost_group = 'purchase'), 0)      as purchase,
  coalesce(sum(l.amount) filter (where l.cost_group = 'auction_fees'), 0)  as auction_fees,
  coalesce(sum(l.amount) filter (where l.cost_group = 'transport'), 0)     as transport,
  coalesce(sum(l.amount) filter (where l.cost_group = 'parts'), 0)         as parts,
  coalesce(sum(l.amount) filter (where l.cost_group = 'labor'), 0)         as labor,
  coalesce(sum(l.amount) filter (where l.cost_group = 'documentation'), 0) as documentation,
  coalesce(sum(l.amount) filter (where l.cost_group = 'inspection'), 0)    as inspection,
  coalesce(sum(l.amount) filter (where l.cost_group = 'storage'), 0)       as storage,
  coalesce(sum(l.amount) filter (where l.cost_group = 'detailing'), 0)     as detailing,
  coalesce(sum(l.amount) filter (where l.cost_group = 'marketing'), 0)     as marketing,
  coalesce(sum(l.amount) filter (where l.cost_group = 'other'), 0)         as other,
  coalesce(sum(l.amount) filter (where l.cost_group = 'selling'), 0)       as selling,
  coalesce(sum(l.amount) filter (where l.cost_group <> 'selling'), 0)      as total_cost
from public.vehicles v
left join public.vehicle_cost_ledger l on l.vehicle_id = v.id
where v.company_id = app.current_company_id()
  and app.has_permission('vehicles', 'view')
group by v.id, v.company_id;

-- Orçamento previsto × real × projetado, por linha de custo
--   projetado = real + estimativas ainda não realizadas (peças a comprar,
--   serviços não concluídos, transportes sem valor final). Sem itens
--   cadastrados, usa o maior entre orçamento e real. A reserva de imprevistos
--   é consumida pelos estouros das outras linhas. Após a venda, projetado = real.
create or replace view public.vehicle_budget_vs_actual as
with base as (
  select v.id as vehicle_id, v.company_id, (v.status = 'sold') as is_sold,
         coalesce(b.alert_threshold_pct, c.budget_alert_pct) as threshold_pct,
         coalesce(b.purchase, 0) as b_purchase, coalesce(b.auction_fees, 0) as b_auction_fees,
         coalesce(b.transport, 0) as b_transport, coalesce(b.parts, 0) as b_parts,
         coalesce(b.labor, 0) as b_labor, coalesce(b.documentation, 0) as b_documentation,
         coalesce(b.inspection, 0) as b_inspection, coalesce(b.other, 0) as b_other,
         coalesce(b.contingency, 0) as b_contingency, coalesce(b.selling_costs, 0) as b_selling,
         s.purchase, s.auction_fees, s.transport, s.parts, s.labor, s.documentation, s.inspection,
         (s.storage + s.detailing + s.marketing + s.other) as other_actual, s.selling,
         exists (select 1 from public.transport_orders t where t.vehicle_id = v.id and t.status <> 'cancelled') as has_transport,
         (select coalesce(sum(t.estimated_cost), 0) from public.transport_orders t
           where t.vehicle_id = v.id and t.status <> 'cancelled' and t.actual_cost is null) as transport_pending,
         exists (select 1 from public.parts p where p.vehicle_id = v.id) as has_parts,
         (select coalesce(sum(p.estimated_total), 0) from public.parts p
           where p.vehicle_id = v.id and p.status in ('identified', 'awaiting_quote', 'to_buy')) as parts_pending,
         (exists (select 1 from public.repair_items ri where ri.vehicle_id = v.id and ri.status <> 'cancelled')
          or exists (select 1 from public.labor_entries le where le.vehicle_id = v.id and le.status = 'confirmed')) as has_labor,
         (select coalesce(sum(greatest(ri.estimated_cost - coalesce((
                    select sum(le.amount) from public.labor_entries le
                    where le.repair_item_id = ri.id and le.status = 'confirmed'), 0), 0)), 0)
            from public.repair_items ri
           where ri.vehicle_id = v.id and ri.status not in ('completed', 'cancelled')) as labor_pending
  from public.vehicles v
  join public.companies c on c.id = v.company_id
  left join public.vehicle_budgets b on b.vehicle_id = v.id
  join public.vehicle_cost_summary s on s.vehicle_id = v.id
  where v.company_id = app.current_company_id()
    and app.has_permission('vehicles', 'view')
),
lines as (
  select base.vehicle_id, base.company_id, base.is_sold, base.threshold_pct,
         x.line, x.sort_order, x.budget, x.actual,
         case
           when base.is_sold then x.actual
           when x.itemized is not null then x.itemized
           when x.line in ('purchase', 'auction_fees') then x.actual
           else greatest(x.budget, x.actual)
         end as projected
  from base
  cross join lateral (values
    ('purchase',      1, base.b_purchase,      base.purchase,      null::numeric),
    ('auction_fees',  2, base.b_auction_fees,  base.auction_fees,  null::numeric),
    ('transport',     3, base.b_transport,     base.transport,
        case when base.has_transport then base.transport + base.transport_pending end),
    ('parts',         4, base.b_parts,         base.parts,
        case when base.has_parts then base.parts + base.parts_pending end),
    ('labor',         5, base.b_labor,         base.labor,
        case when base.has_labor then base.labor + base.labor_pending end),
    ('documentation', 6, base.b_documentation, base.documentation, null::numeric),
    ('inspection',    7, base.b_inspection,    base.inspection,    null::numeric),
    ('other',         8, base.b_other,         base.other_actual,  null::numeric),
    ('selling',      10, base.b_selling,       base.selling,       null::numeric)
  ) as x(line, sort_order, budget, actual, itemized)
),
contingency as (
  select base.vehicle_id, base.company_id, base.is_sold, base.threshold_pct,
         'contingency'::text as line, 9 as sort_order, base.b_contingency as budget, 0::numeric as actual,
         case when base.is_sold then 0::numeric
              else greatest(0, base.b_contingency - coalesce((
                select sum(greatest(l.projected - l.budget, 0)) from lines l
                where l.vehicle_id = base.vehicle_id and l.line <> 'selling'), 0))
         end as projected
  from base
),
all_lines as (
  select * from lines
  union all
  select * from contingency
)
select a.vehicle_id, a.company_id, a.line, a.sort_order,
       a.budget, a.actual, a.projected,
       a.actual - a.budget as difference,
       case when a.budget > 0 then round((a.actual - a.budget) / a.budget * 100, 2) end as difference_pct,
       a.projected - a.budget as projected_difference,
       (a.line <> 'contingency' and a.actual > a.budget) as over_budget,
       case
         when a.line = 'contingency' then 'ok'
         when a.actual > a.budget * (1 + a.threshold_pct / 100) then 'critical'
         when a.actual > a.budget then 'warning'
         else 'ok'
       end as alert_level
from all_lines a;

-- Painel Profit Analysis
create or replace view public.vehicle_profit_analysis as
with agg as (
  select vehicle_id,
         sum(budget)    filter (where line <> 'selling') as planned_investment,
         sum(budget)    filter (where line = 'selling')  as planned_selling,
         sum(projected) filter (where line <> 'selling') as projected_cost,
         sum(projected) filter (where line = 'selling')  as projected_selling
  from public.vehicle_budget_vs_actual
  group by vehicle_id
),
calc as (
  select v.id as vehicle_id, v.company_id, v.stock_number, v.vin, v.year, v.make, v.model, v.trim, v.status,
         c.default_min_profit, c.default_min_margin_pct,
         b.planned_sale_price,
         agg.planned_investment, agg.planned_selling,
         b.planned_sale_price - agg.planned_investment - agg.planned_selling as planned_profit,
         s.total_cost as actual_cost, s.selling as actual_selling, s.storage as holding_costs,
         agg.projected_cost, agg.projected_selling,
         coalesce(v.expected_sale_price, b.planned_sale_price) as expected_sale_price,
         v.conservative_sale_price, v.optimistic_sale_price, v.listed_price,
         sa.final_price as sale_price, sa.sale_date,
         v.purchased_at, v.received_at, v.ready_at, v.listed_at, v.sold_at
  from public.vehicles v
  join public.companies c on c.id = v.company_id
  join agg on agg.vehicle_id = v.id
  join public.vehicle_cost_summary s on s.vehicle_id = v.id
  left join public.vehicle_budgets b on b.vehicle_id = v.id
  left join public.sales sa on sa.vehicle_id = v.id and sa.status = 'completed'
  where v.company_id = app.current_company_id()
    and (app.has_permission('reports', 'view') or app.has_permission('purchases', 'view'))
)
select calc.vehicle_id, calc.company_id, calc.stock_number, calc.vin, calc.year, calc.make, calc.model, calc.trim, calc.status,
       -- previsto (orçamento original)
       calc.planned_sale_price, calc.planned_investment, calc.planned_selling, calc.planned_profit,
       case when calc.planned_sale_price > 0 then round(calc.planned_profit / calc.planned_sale_price * 100, 2) end as planned_margin_pct,
       case when calc.planned_investment > 0 then round(calc.planned_profit / calc.planned_investment * 100, 2) end as planned_roi_pct,
       -- real até agora
       calc.actual_cost, calc.actual_selling,
       -- projetado (real + o que falta)
       calc.projected_cost, calc.projected_selling,
       calc.expected_sale_price, calc.conservative_sale_price, calc.optimistic_sale_price, calc.listed_price,
       calc.expected_sale_price - calc.projected_cost - calc.projected_selling as projected_profit,
       calc.conservative_sale_price - calc.projected_cost - calc.projected_selling as conservative_profit,
       calc.optimistic_sale_price - calc.projected_cost - calc.projected_selling as optimistic_profit,
       case when calc.expected_sale_price > 0 then round((calc.expected_sale_price - calc.projected_cost - calc.projected_selling) / calc.expected_sale_price * 100, 2) end as projected_margin_pct,
       case when calc.projected_cost > 0 then round((calc.expected_sale_price - calc.projected_cost - calc.projected_selling) / calc.projected_cost * 100, 2) end as projected_roi_pct,
       -- preços de referência
       calc.projected_cost + calc.projected_selling as break_even_price,
       round(greatest(
         calc.projected_cost + calc.projected_selling + calc.default_min_profit,
         (calc.projected_cost + calc.projected_selling) / (1 - calc.default_min_margin_pct / 100)
       ), 2) as min_target_price,
       round(greatest(
         coalesce(calc.expected_sale_price, 0),
         calc.projected_cost + calc.projected_selling + calc.default_min_profit,
         (calc.projected_cost + calc.projected_selling) / (1 - calc.default_min_margin_pct / 100)
       ), 2) as recommended_price,
       -- resultado real (após a venda)
       calc.sale_price, calc.sale_date,
       calc.sale_price - calc.actual_cost - calc.actual_selling as real_profit,
       case when calc.sale_price > 0 then round((calc.sale_price - calc.actual_cost - calc.actual_selling) / calc.sale_price * 100, 2) end as real_margin_pct,
       case when calc.actual_cost > 0 and calc.sale_price is not null then round((calc.sale_price - calc.actual_cost - calc.actual_selling) / calc.actual_cost * 100, 2) end as real_roi_pct,
       -- tempos
       (coalesce(calc.sold_at::date, current_date) - calc.purchased_at) as days_since_purchase,
       case when calc.received_at is not null then
         (coalesce(calc.ready_at, calc.sold_at, now())::date - calc.received_at::date) end as days_in_preparation,
       case when calc.listed_at is not null then
         (coalesce(calc.sold_at, now())::date - calc.listed_at::date) end as days_listed,
       calc.holding_costs,
       case when (coalesce(calc.sold_at::date, current_date) - calc.purchased_at) > 0 and calc.holding_costs > 0
            then round(calc.holding_costs / (coalesce(calc.sold_at::date, current_date) - calc.purchased_at), 2) end as holding_cost_per_day
from calc;

-- Propostas: atende ao lucro mínimo?
create or replace view public.vehicle_offers_analysis as
select o.id as offer_id, o.company_id, o.vehicle_id, o.customer_id, o.contact_name, o.channel,
       o.offer_amount, o.counter_amount, o.status, o.offered_at,
       pa.projected_cost, pa.projected_selling, pa.break_even_price, pa.min_target_price,
       o.offer_amount - pa.projected_cost - pa.projected_selling as profit_if_accepted,
       case when o.offer_amount > 0 then round((o.offer_amount - pa.projected_cost - pa.projected_selling) / o.offer_amount * 100, 2) end as margin_if_accepted_pct,
       (o.offer_amount >= pa.min_target_price) as meets_targets,
       (o.offer_amount >= pa.break_even_price) as covers_costs
from public.vehicle_offers o
join public.vehicle_profit_analysis pa on pa.vehicle_id = o.vehicle_id
where o.company_id = app.current_company_id()
  and app.has_permission('sales', 'view');

-- Parts List: resumo por veículo
create or replace view public.vehicle_parts_summary as
select p.vehicle_id, p.company_id,
       count(*) as items,
       count(*) filter (where p.status in ('identified', 'awaiting_quote', 'to_buy', 'purchased', 'awaiting_delivery')) as pending_items,
       count(*) filter (where p.status in ('identified', 'awaiting_quote', 'to_buy')) as to_buy_items,
       count(*) filter (where p.status in ('purchased', 'awaiting_delivery') and p.expected_delivery_date < current_date) as late_items,
       count(*) filter (where p.status = 'installed') as installed_items,
       coalesce(sum(p.estimated_total) filter (where p.status <> 'returned'), 0) as estimated_total,
       coalesce(sum(p.actual_total - p.refund_amount) filter (where p.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned')), 0) as actual_total,
       coalesce(sum(p.estimated_total) filter (where p.status in ('purchased', 'awaiting_delivery', 'received', 'installed')), 0) as estimated_of_purchased
from public.parts p
where p.company_id = app.current_company_id()
  and app.has_permission('parts', 'view')
group by p.vehicle_id, p.company_id;

-- Labor & Repairs: serviços com custo real (soma dos lançamentos) e variação
create or replace view public.repair_items_overview as
select ri.id as repair_item_id, ri.company_id, ri.vehicle_id, ri.repair_order_id, ro.title as repair_order_title,
       ro.supplier_id, ro.mechanic_id, ro.mechanic_name, ri.area, ri.problem, ri.service, ri.status,
       ri.estimated_cost, ri.estimated_hours,
       coalesce(l.amount, 0) as actual_cost, coalesce(l.hours, 0) as actual_hours,
       coalesce(l.amount, 0) - ri.estimated_cost as variance,
       coalesce(pp.parts_actual, 0) as related_parts_actual,
       ri.started_at, ri.completed_at
from public.repair_items ri
join public.repair_orders ro on ro.id = ri.repair_order_id
left join lateral (
  select sum(le.amount) as amount, sum(le.hours) as hours from public.labor_entries le
  where le.repair_item_id = ri.id and le.status = 'confirmed') l on true
left join lateral (
  select sum(p.actual_total - p.refund_amount) as parts_actual from public.parts p
  where p.repair_item_id = ri.id and p.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned')) pp on true
where ri.company_id = app.current_company_id()
  and app.has_permission('repairs', 'view');

-- Inspeção: valor real de cada item = peças + mão de obra vinculadas
create or replace view public.inspection_items_overview as
select ii.*,
       coalesce(pp.amount, 0) + coalesce(lb.amount, 0) as actual_cost
from public.inspection_items ii
left join lateral (
  select sum(p.actual_total - p.refund_amount) as amount from public.parts p
  where p.inspection_item_id = ii.id and p.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned')) pp on true
left join lateral (
  select sum(le.amount) as amount from public.repair_items ri
  join public.labor_entries le on le.repair_item_id = ri.id and le.status = 'confirmed'
  where ri.inspection_item_id = ii.id) lb on true
where ii.company_id = app.current_company_id()
  and app.has_permission('inspections', 'view');

-- Auction Analyzer: oportunidades com a simulação principal e danos
create or replace view public.auction_opportunity_overview as
select o.id as opportunity_id, o.company_id, o.status, o.source_id, src.name as source_name,
       o.auction_name, o.lot_number, o.vin, o.year, o.make, o.model, o.trim, o.odometer,
       o.auction_date, o.title_status, o.title_verified, o.primary_damage, o.secondary_damage,
       o.run_condition, o.has_keys, o.current_bid, o.market_value_clean, o.expected_value_repaired,
       d.damaged_areas, d.damage_estimated_cost,
       s.id as simulation_id, s.expected_sale_price, s.planned_bid, s.total_investment,
       s.projected_profit, s.margin_pct, s.roi_pct, s.max_bid, s.decision,
       case when o.current_bid is not null and s.max_bid is not null then s.max_bid - o.current_bid end as room_to_bid
from public.auction_opportunities o
left join public.auction_sources src on src.id = o.source_id
left join lateral (
  select count(*) filter (where da.condition <> 'good') as damaged_areas,
         coalesce(sum(da.estimated_cost), 0) as damage_estimated_cost
  from public.vehicle_damage_assessments da where da.opportunity_id = o.id) d on true
left join lateral (
  select * from public.auction_simulations x where x.opportunity_id = o.id
  order by x.is_baseline desc, x.created_at desc limit 1) s on true
where o.company_id = app.current_company_id()
  and app.has_permission('auction', 'view');

-- Saldos das contas financeiras
create or replace view public.financial_account_balances as
select a.id as account_id, a.company_id, a.name, a.account_type, a.is_active, a.opening_balance,
       a.opening_balance
         + coalesce(sum(t.amount) filter (where t.direction = 'in'), 0)
         - coalesce(sum(t.amount) filter (where t.direction = 'out'), 0) as balance
from public.financial_accounts a
left join public.financial_transactions t on t.account_id = a.id and t.status = 'confirmed'
where a.company_id = app.current_company_id()
  and app.has_permission('finance', 'view')
group by a.id;

-- Alertas automáticos
create or replace view public.alerts as
with c as (select * from public.companies where id = app.current_company_id())
select * from (
  -- Veículo parado há muitos dias
  select v.company_id, 'stale_vehicle'::text as alert_type,
         case when current_date - v.purchased_at > c.stale_vehicle_days * 2 then 'critical' else 'warning' end as severity,
         v.id as vehicle_id, 'vehicle'::text as entity_type, v.id as entity_id,
         concat_ws(' ', v.year, v.make, v.model) as title,
         'Veículo há ' || (current_date - v.purchased_at) || ' dias sem venda' as message,
         null::date as due_date, null::numeric as amount
  from public.vehicles v, c
  where v.company_id = c.id and v.status <> 'sold' and current_date - v.purchased_at > c.stale_vehicle_days
  union all
  -- Peça atrasada
  select p.company_id, 'part_late', 'warning', p.vehicle_id, 'part', p.id, p.name,
         'Entrega prevista para ' || to_char(p.expected_delivery_date, 'MM/DD/YYYY'),
         p.expected_delivery_date, p.actual_total
  from public.parts p, c
  where p.company_id = c.id and p.status in ('purchased', 'awaiting_delivery') and p.expected_delivery_date < current_date
  union all
  -- Orçamento ultrapassado
  select b.company_id, 'budget_overrun', b.alert_level, b.vehicle_id, 'budget_line', b.vehicle_id, b.line,
         'Gasto real ' || b.actual || ' vs orçamento ' || b.budget
           || coalesce(' (' || case when b.difference_pct > 0 then '+' else '' end || b.difference_pct || '%)', ''),
         null::date, b.difference
  from public.vehicle_budget_vs_actual b, c
  where b.company_id = c.id and b.alert_level <> 'ok'
    and exists (select 1 from public.vehicles v where v.id = b.vehicle_id and v.status <> 'sold')
  union all
  -- Lucro projetado abaixo da meta
  select pa.company_id, 'profit_below_target',
         case when pa.projected_profit < 0 then 'critical' else 'warning' end,
         pa.vehicle_id, 'vehicle', pa.vehicle_id, concat_ws(' ', pa.year, pa.make, pa.model),
         'Lucro projetado ' || pa.projected_profit || ' abaixo do mínimo ' || c.default_min_profit,
         null::date, pa.projected_profit
  from public.vehicle_profit_analysis pa, c
  where pa.company_id = c.id and pa.status <> 'sold' and pa.projected_profit < c.default_min_profit
  union all
  -- Documento pendente ou vencido
  select d.company_id, 'document_pending',
         case when d.due_date < current_date or d.expires_at < current_date then 'critical' else 'warning' end,
         d.vehicle_id, 'document', d.id, d.doc_type::text,
         case when d.expires_at < current_date then 'Documento vencido'
              when d.due_date < current_date then 'Documento pendente com prazo vencido'
              else 'Documento pendente' end,
         coalesce(d.due_date, d.expires_at), null::numeric
  from public.documents d, c
  where d.company_id = c.id and d.is_required
    and (d.status in ('pending', 'requested', 'rejected', 'expired') or d.expires_at < current_date)
  union all
  -- Reparo não concluído no prazo
  select r.company_id, 'repair_overdue', 'warning', r.vehicle_id, 'repair_order', r.id, r.title,
         'Prazo de conclusão: ' || to_char(r.due_date, 'MM/DD/YYYY'), r.due_date, null::numeric
  from public.repair_orders r, c
  where r.company_id = c.id and r.status not in ('completed', 'cancelled') and r.due_date < current_date
  union all
  -- Conta a pagar próxima do vencimento ou vencida
  select ap.company_id, 'payable_due',
         case when ap.due_date < current_date then 'critical' else 'warning' end,
         ap.vehicle_id, 'accounts_payable', ap.id, ap.description,
         case when ap.due_date < current_date then 'Conta vencida' else 'Conta vence em breve' end,
         ap.due_date, ap.balance
  from public.accounts_payable ap, c
  where ap.company_id = c.id and ap.status in ('open', 'partial')
    and ap.due_date <= current_date + c.payable_alert_days
  union all
  -- Veículo vendido com saldo pendente
  select ar.company_id, 'sold_with_balance',
         case when ar.due_date < current_date then 'critical' else 'warning' end,
         ar.vehicle_id, 'accounts_receivable', ar.id, ar.description,
         'Saldo a receber da venda', ar.due_date, ar.balance
  from public.accounts_receivable ar, c
  where ar.company_id = c.id and ar.sale_id is not null and ar.status in ('open', 'partial')
) a
where app.has_permission('dashboard', 'view');

-- Dashboard: indicadores principais
create or replace view public.dashboard_kpis as
with c as (select app.current_company_id() as id),
pa as (select * from public.vehicle_profit_analysis)
select c.id as company_id,
  (select count(*) from public.vehicles v where v.company_id = c.id) as total_vehicles,
  (select count(*) from public.auction_opportunities o where o.company_id = c.id
     and o.status in ('analyzing', 'awaiting_inspection', 'awaiting_quote', 'approved', 'bid_placed')) as opportunities_in_analysis,
  (select count(*) from public.vehicles v where v.company_id = c.id
     and v.status in ('purchased', 'awaiting_pickup', 'in_transit', 'received')) as vehicles_purchased_pending,
  (select count(*) from public.vehicles v where v.company_id = c.id
     and v.status in ('in_inspection', 'in_preparation', 'awaiting_parts', 'in_repair', 'in_detailing')) as vehicles_in_preparation,
  (select count(*) from public.vehicles v where v.company_id = c.id
     and v.status in ('ready_for_sale', 'listed', 'reserved')) as vehicles_ready_for_sale,
  (select count(*) from public.vehicles v where v.company_id = c.id and v.status = 'sold') as vehicles_sold,
  (select coalesce(sum(actual_cost), 0) from pa) as total_invested,
  (select coalesce(sum(actual_cost), 0) from pa where status <> 'sold') as inventory_value,
  (select coalesce(sum(e.amount), 0) from public.expenses e where e.company_id = c.id and e.status <> 'cancelled') as total_expenses,
  (select coalesce(sum(sale_price), 0) from pa where status = 'sold') as revenue,
  (select coalesce(sum(real_profit), 0) from pa where status = 'sold') as realized_profit,
  (select round(avg(real_margin_pct), 2) from pa where status = 'sold') as avg_margin_pct,
  (select coalesce(sum(projected_profit), 0) from pa where status <> 'sold') as projected_profit_inventory,
  (select coalesce(sum(balance), 0) from public.accounts_payable ap where ap.company_id = c.id and ap.status in ('open', 'partial')) as accounts_payable_open,
  (select coalesce(sum(balance), 0) from public.accounts_receivable ar where ar.company_id = c.id and ar.status in ('open', 'partial')) as accounts_receivable_open,
  (select round(avg(days_in_preparation), 1) from pa where days_in_preparation is not null) as avg_days_in_preparation,
  (select round(avg(days_since_purchase), 1) from pa where status = 'sold') as avg_days_to_sell
from c
where c.id is not null and app.has_permission('dashboard', 'view');

-- Resultado mensal (DRE gerencial simplificada)
create or replace view public.monthly_results as
with months as (
  select date_trunc('month', p.purchase_date)::date as month from public.vehicle_purchases p where p.company_id = app.current_company_id()
  union select date_trunc('month', s.sale_date)::date from public.sales s where s.company_id = app.current_company_id() and s.status = 'completed'
  union select date_trunc('month', e.expense_date)::date from public.expenses e where e.company_id = app.current_company_id() and e.status <> 'cancelled'
)
select app.current_company_id() as company_id, m.month,
  (select count(*) from public.vehicle_purchases p
    where p.company_id = app.current_company_id() and date_trunc('month', p.purchase_date) = m.month) as vehicles_purchased,
  (select coalesce(sum(p.total_paid_to_auction), 0) from public.vehicle_purchases p
    where p.company_id = app.current_company_id() and date_trunc('month', p.purchase_date) = m.month) as purchases_amount,
  (select count(*) from public.vehicle_profit_analysis pa
    where pa.status = 'sold' and date_trunc('month', pa.sale_date) = m.month) as vehicles_sold,
  (select coalesce(sum(pa.sale_price), 0) from public.vehicle_profit_analysis pa
    where pa.status = 'sold' and date_trunc('month', pa.sale_date) = m.month) as revenue,
  (select coalesce(sum(pa.actual_cost), 0) from public.vehicle_profit_analysis pa
    where pa.status = 'sold' and date_trunc('month', pa.sale_date) = m.month) as cost_of_vehicles_sold,
  (select coalesce(sum(pa.actual_selling), 0) from public.vehicle_profit_analysis pa
    where pa.status = 'sold' and date_trunc('month', pa.sale_date) = m.month) as selling_costs,
  (select coalesce(sum(pa.real_profit), 0) from public.vehicle_profit_analysis pa
    where pa.status = 'sold' and date_trunc('month', pa.sale_date) = m.month) as gross_profit,
  (select coalesce(sum(e.amount), 0) from public.expenses e
    where e.company_id = app.current_company_id() and e.vehicle_id is null and e.status <> 'cancelled'
      and date_trunc('month', e.expense_date) = m.month) as overhead_expenses,
  (select coalesce(sum(pa.real_profit), 0) from public.vehicle_profit_analysis pa
    where pa.status = 'sold' and date_trunc('month', pa.sale_date) = m.month)
  - (select coalesce(sum(e.amount), 0) from public.expenses e
    where e.company_id = app.current_company_id() and e.vehicle_id is null and e.status <> 'cancelled'
      and date_trunc('month', e.expense_date) = m.month) as net_result
from months m
where app.has_permission('reports', 'view');

-- Gastos por grupo de custo e mês
create or replace view public.monthly_costs_by_group as
select company_id, date_trunc('month', cost_date)::date as month, cost_group, sum(amount) as amount
from public.vehicle_cost_ledger
group by company_id, date_trunc('month', cost_date), cost_group;

-- >>> 20261110000007_workflows.sql
-- =============================================================================
-- CARKING — 07 · Fluxos de negócio (RPCs chamadas pelo app) e dados padrão
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Dados padrão de uma nova empresa: papéis, permissões, categorias, checklist
-- -----------------------------------------------------------------------------
create or replace function app.seed_company_defaults(p_company_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  r record;
  m public.app_module;
  v_flags text;
begin
  insert into public.roles (company_id, code, name, description, is_system) values
    (p_company_id, 'super_admin',   'Super Admin',          'Acesso total, incluindo configurações e funcionários', true),
    (p_company_id, 'admin',         'Administrador',        'Acesso total aos módulos', true),
    (p_company_id, 'finance',       'Financeiro',           'Contas, caixa, compras, vendas e relatórios', true),
    (p_company_id, 'manager',       'Gerente',              'Operação completa e aprovações', true),
    (p_company_id, 'auction_buyer', 'Comprador de leilão',  'Auction Analyzer, compras, transporte e documentos', true),
    (p_company_id, 'seller',        'Vendedor',             'Estoque, anúncios, propostas, clientes e vendas', true),
    (p_company_id, 'mechanic',      'Mecânico',             'Inspeção, peças e reparos', true),
    (p_company_id, 'attendant',     'Atendente',            'Atendimento de clientes e consulta de estoque', true)
  on conflict (company_id, code) do nothing;

  -- v = ver, c = criar, e = editar, a = aprovar, d = excluir
  for r in select id, code from public.roles where company_id = p_company_id loop
    foreach m in array enum_range(null::public.app_module) loop
      v_flags := case r.code
        when 'super_admin' then 'vcead'
        when 'admin'       then 'vcead'
        when 'manager' then case
          when m in ('auction', 'vehicles', 'purchases', 'inspections', 'parts', 'repairs', 'transport',
                     'inventory', 'sales', 'customers', 'suppliers', 'documents') then 'vcea'
          else 'v' end
        when 'finance' then case
          when m in ('finance', 'purchases', 'sales', 'documents', 'suppliers', 'customers') then 'vcea'
          when m = 'employees' then ''
          else 'v' end
        when 'auction_buyer' then case
          when m = 'auction' then 'vcea'
          when m in ('purchases', 'transport', 'documents', 'vehicles', 'suppliers') then 'vce'
          when m in ('dashboard', 'reports', 'inspections', 'parts', 'repairs', 'inventory') then 'v'
          else '' end
        when 'seller' then case
          when m in ('inventory', 'sales', 'customers') then 'vce'
          when m = 'documents' then 'vc'
          when m in ('vehicles', 'dashboard', 'reports') then 'v'
          else '' end
        when 'mechanic' then case
          when m in ('inspections', 'parts', 'repairs') then 'vce'
          when m = 'vehicles' then 've'
          when m in ('suppliers', 'documents', 'dashboard') then 'v'
          else '' end
        when 'attendant' then case
          when m = 'customers' then 'vce'
          when m in ('inventory', 'vehicles', 'sales', 'dashboard') then 'v'
          else '' end
        else '' end;

      insert into public.permissions (company_id, role_id, module, can_view, can_create, can_edit, can_approve, can_delete)
      values (p_company_id, r.id, m, v_flags like '%v%', v_flags like '%c%', v_flags like '%e%',
              v_flags like '%a%', v_flags like '%d%')
      on conflict (role_id, module) do nothing;
    end loop;
  end loop;

  insert into public.expense_categories (company_id, name, cost_group, is_system) values
    (p_company_id, 'Compra do veículo',          'purchase',      true),
    (p_company_id, 'Taxas de leilão',            'auction_fees',  true),
    (p_company_id, 'Transporte',                 'transport',     true),
    (p_company_id, 'Peças',                      'parts',         true),
    (p_company_id, 'Mão de obra',                'labor',         true),
    (p_company_id, 'Documentação e título',      'documentation', true),
    (p_company_id, 'Inspeções',                  'inspection',    true),
    (p_company_id, 'Estadia / armazenagem',      'storage',       true),
    (p_company_id, 'Detalhamento e limpeza',     'detailing',     true),
    (p_company_id, 'Fotos e anúncios',           'marketing',     true),
    (p_company_id, 'Outros custos do veículo',   'other',         true),
    (p_company_id, 'Despesas de venda',          'selling',       true)
  on conflict (company_id, name) do nothing;

  insert into public.inspection_checklist_templates (company_id, area, item, sort_order)
  select p_company_id, x.area::public.vehicle_area, x.item, x.sort_order
  from (values
    ('engine', 'Vazamentos', 10), ('engine', 'Ruídos', 11), ('engine', 'Funcionamento', 12),
    ('transmission', 'Câmbio', 20), ('transmission', 'Vazamentos', 21), ('transmission', 'Funcionamento', 22),
    ('front', 'Para-choque', 30), ('front', 'Capô', 31), ('front', 'Faróis', 32), ('front', 'Radiador', 33),
    ('rear', 'Tampa traseira', 40), ('rear', 'Lanternas', 41), ('rear', 'Para-choque', 42),
    ('left_side', 'Portas e paralamas', 45), ('right_side', 'Portas e paralamas', 46),
    ('suspension', 'Amortecedores', 50), ('suspension', 'Braços', 51), ('suspension', 'Terminais', 52),
    ('brakes', 'Discos', 60), ('brakes', 'Pastilhas', 61), ('brakes', 'Pinças', 62),
    ('tires', 'Estado', 70), ('tires', 'Medidas', 71), ('tires', 'Quantidade', 72),
    ('electrical', 'Bateria', 80), ('electrical', 'Sensores', 81), ('electrical', 'Módulos', 82),
    ('interior', 'Bancos', 90), ('interior', 'Painel', 91), ('airbags', 'Airbags', 92),
    ('structure', 'Chassi', 100), ('structure', 'Longarinas', 101), ('structure', 'Alinhamento', 102),
    ('glass', 'Vidros', 110)
  ) as x(area, item, sort_order)
  on conflict (company_id, area, item) do nothing;
end $$;

-- Primeiro acesso: cria a empresa e torna o usuário atual Super Admin
create or replace function public.create_company(p_company_name text, p_full_name text, p_email text default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_company uuid;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado.';
  end if;
  if exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Este usuário já pertence a uma empresa.';
  end if;
  insert into public.companies (name) values (p_company_name) returning id into v_company;
  perform app.seed_company_defaults(v_company);
  insert into public.profiles (id, company_id, role_id, full_name, email)
  values (auth.uid(), v_company,
          (select id from public.roles where company_id = v_company and code = 'super_admin'),
          p_full_name, p_email);
  return v_company;
end $$;

-- Adiciona um funcionário já cadastrado no Supabase Auth (convite feito pelo painel/Edge Function)
create or replace function public.add_employee(p_user_id uuid, p_full_name text, p_role_code text,
                                               p_email text default null, p_branch_id uuid default null)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_role uuid;
begin
  if not app.has_permission('employees', 'create') then
    raise exception 'Sem permissão para cadastrar funcionários.';
  end if;
  select id into v_role from public.roles where company_id = app.current_company_id() and code = p_role_code;
  if v_role is null then raise exception 'Perfil % não encontrado.', p_role_code; end if;
  if p_role_code = 'super_admin' and app.current_role_code() <> 'super_admin' then
    raise exception 'Apenas um Super Admin pode criar outro Super Admin.';
  end if;
  insert into public.profiles (id, company_id, branch_id, role_id, full_name, email)
  values (p_user_id, app.current_company_id(), p_branch_id, v_role, p_full_name, p_email);
  return p_user_id;
end $$;

-- -----------------------------------------------------------------------------
-- Compra: transforma uma oportunidade arrematada em veículo
-- -----------------------------------------------------------------------------
create or replace function app.create_required_documents(p_vehicle_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v public.vehicles;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  insert into public.documents (company_id, vehicle_id, doc_type, title, status, is_required, due_date)
  select v.company_id, v.id, x.doc_type, x.title, 'pending', true, current_date + x.days
  from (values
    ('bill_of_sale'::public.document_type, 'Bill of Sale', 7),
    (case v.title_status
       when 'salvage' then 'salvage_title'::public.document_type
       when 'rebuilt' then 'rebuilt_title'::public.document_type
       else 'title'::public.document_type end, 'Título do veículo', 30),
    ('auction_document'::public.document_type, 'Documentos do leilão', 7),
    ('payment_receipt'::public.document_type, 'Comprovante de pagamento do leilão', 3)
  ) as x(doc_type, title, days)
  where not exists (select 1 from public.documents d where d.vehicle_id = v.id and d.doc_type = x.doc_type);
end $$;

create or replace function public.register_purchase(
  p_opportunity_id    uuid,
  p_final_bid         numeric,
  p_buyer_fee         numeric default null,  -- nulo = calcula pela tabela da plataforma
  p_other_fees        numeric default 0,
  p_purchase_date     date    default current_date,
  p_payment_method    text    default null,
  p_payment_due_date  date    default null,
  p_simulation_id     uuid    default null,  -- nulo = simulação principal ou a mais recente
  p_stock_number      text    default null,
  p_branch_id         uuid    default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  o public.auction_opportunities;
  s public.auction_simulations;
  v_vehicle uuid;
  v_buyer_fee numeric;
begin
  select * into o from public.auction_opportunities where id = p_opportunity_id for update;
  if not found then raise exception 'Oportunidade não encontrada.'; end if;
  if o.status = 'won' or exists (select 1 from public.vehicles where opportunity_id = o.id) then
    raise exception 'Esta oportunidade já foi registrada como compra.';
  end if;
  if not o.title_verified then
    raise exception 'Valide o status do título (%) antes de registrar a compra.', o.title_status;
  end if;
  if o.vin is null then
    raise exception 'Informe o VIN do veículo antes de registrar a compra.';
  end if;
  if p_final_bid is null or p_final_bid <= 0 then
    raise exception 'Informe o valor final do lance.';
  end if;

  if p_simulation_id is not null then
    select * into s from public.auction_simulations where id = p_simulation_id and opportunity_id = o.id;
    if not found then raise exception 'Simulação não pertence a esta oportunidade.'; end if;
  else
    select * into s from public.auction_simulations where opportunity_id = o.id
    order by is_baseline desc, created_at desc limit 1;
  end if;

  v_buyer_fee := coalesce(p_buyer_fee, public.calculate_auction_fees(o.source_id, p_final_bid));

  insert into public.vehicles (company_id, branch_id, opportunity_id, stock_number, vin, make, model, year, trim,
    odometer, odometer_unit, color, fuel_type, transmission, title_status, title_state, run_condition, has_keys,
    status, market_value_clean, expected_sale_price, conservative_sale_price, optimistic_sale_price, purchased_at)
  values (o.company_id, p_branch_id, o.id, p_stock_number, o.vin, o.make, o.model, o.year, o.trim,
    o.odometer, o.odometer_unit, o.color, o.fuel_type, o.transmission, o.title_status, o.title_state, o.run_condition, o.has_keys,
    'purchased', o.market_value_clean,
    coalesce(s.expected_sale_price, o.expected_value_repaired), s.conservative_sale_price, s.optimistic_sale_price,
    p_purchase_date)
  returning id into v_vehicle;

  insert into public.vehicle_purchases (company_id, vehicle_id, opportunity_id, source_id, auction_name, lot_number,
    purchase_date, final_bid, buyer_fee, other_auction_fees, payment_method, payment_due_date)
  values (o.company_id, v_vehicle, o.id, o.source_id, o.auction_name, o.lot_number,
    p_purchase_date, p_final_bid, v_buyer_fee, coalesce(p_other_fees, 0), p_payment_method, p_payment_due_date);

  -- Orçamento = simulação aprovada (preservada para comparar previsto × real)
  if s.id is not null then
    insert into public.vehicle_budgets (company_id, vehicle_id, simulation_id, purchase, auction_fees, transport, parts,
      labor, documentation, inspection, other, contingency, selling_costs, planned_sale_price, planned_profit)
    values (o.company_id, v_vehicle, s.id, s.planned_bid, s.auction_fees, s.transport_cost, s.parts_cost,
      s.labor_cost, s.documentation_cost, s.inspection_cost, s.other_costs, s.contingency_total, s.selling_costs,
      s.expected_sale_price, s.projected_profit);

    update public.auction_simulations set is_baseline = false
    where opportunity_id = o.id and is_baseline and id <> s.id;
    update public.auction_simulations set is_baseline = true, locked = true where id = s.id;
  else
    insert into public.vehicle_budgets (company_id, vehicle_id, purchase, auction_fees, planned_sale_price)
    values (o.company_id, v_vehicle, p_final_bid, v_buyer_fee + coalesce(p_other_fees, 0), o.expected_value_repaired);
  end if;

  update public.auction_opportunities set status = 'won' where id = o.id;
  update public.auction_bids set result = 'won'
  where opportunity_id = o.id and result = 'pending' and amount = p_final_bid;
  update public.auction_bids set result = 'outbid'
  where opportunity_id = o.id and result = 'pending';

  update public.vehicle_damage_assessments set vehicle_id = v_vehicle where opportunity_id = o.id and vehicle_id is null;
  update public.documents   set vehicle_id = v_vehicle where opportunity_id = o.id and vehicle_id is null;
  update public.attachments set vehicle_id = v_vehicle where opportunity_id = o.id and vehicle_id is null;

  perform app.create_required_documents(v_vehicle);
  return v_vehicle;
end $$;

-- Compra fora do Auction Analyzer (ex.: compra direta). Sem simulação, o
-- orçamento fica igual ao valor pago e pode ser ajustado em vehicle_budgets.
create or replace function public.register_direct_purchase(
  p_vin                 text,
  p_make                text,
  p_model               text,
  p_year                integer,
  p_title_status        public.title_status,
  p_final_bid           numeric,
  p_auction_fees        numeric default 0,
  p_purchase_date       date    default current_date,
  p_source_id           uuid    default null,
  p_supplier_id         uuid    default null,
  p_expected_sale_price numeric default null,
  p_trim                text    default null,
  p_odometer            integer default null,
  p_color               text    default null,
  p_stock_number        text    default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare v_vehicle uuid;
begin
  if p_title_status = 'unknown' then
    raise exception 'Valide o status do título antes de registrar a compra.';
  end if;
  insert into public.vehicles (vin, make, model, year, trim, odometer, color, title_status, status,
                               expected_sale_price, purchased_at, stock_number)
  values (p_vin, p_make, p_model, p_year, p_trim, p_odometer, p_color, p_title_status, 'purchased',
          p_expected_sale_price, p_purchase_date, p_stock_number)
  returning id into v_vehicle;

  insert into public.vehicle_purchases (vehicle_id, source_id, supplier_id, purchase_date, final_bid, buyer_fee)
  values (v_vehicle, p_source_id, p_supplier_id, p_purchase_date, p_final_bid, coalesce(p_auction_fees, 0));

  insert into public.vehicle_budgets (vehicle_id, purchase, auction_fees, planned_sale_price)
  values (v_vehicle, p_final_bid, coalesce(p_auction_fees, 0), p_expected_sale_price);

  perform app.create_required_documents(v_vehicle);
  return v_vehicle;
end $$;

-- -----------------------------------------------------------------------------
-- Inspeção: cria a ficha com o checklist padrão da empresa
-- -----------------------------------------------------------------------------
create or replace function public.start_inspection(p_vehicle_id uuid, p_inspection_type text default 'arrival')
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v public.vehicles;
  v_id uuid;
begin
  select * into v from public.vehicles where id = p_vehicle_id;
  if not found then raise exception 'Veículo não encontrado.'; end if;

  insert into public.vehicle_inspections (company_id, vehicle_id, inspection_type, inspector_id, odometer_reading)
  values (v.company_id, v.id, p_inspection_type, auth.uid(), v.odometer)
  returning id into v_id;

  insert into public.inspection_items (company_id, inspection_id, vehicle_id, area, item, sort_order)
  select v.company_id, v_id, v.id, t.area, t.item, t.sort_order
  from public.inspection_checklist_templates t
  where t.company_id = v.company_id and t.is_active
  order by t.sort_order;

  if p_inspection_type = 'arrival' and v.status in ('purchased', 'awaiting_pickup', 'in_transit', 'received') then
    update public.vehicles set status = 'in_inspection' where id = v.id;
  end if;
  return v_id;
end $$;

-- -----------------------------------------------------------------------------
-- Venda
-- -----------------------------------------------------------------------------
create or replace function public.register_sale(
  p_vehicle_id               uuid,
  p_customer_id              uuid,
  p_final_price              numeric,
  p_sale_date                date    default current_date,
  p_payment_method           text    default null,
  p_discount                 numeric default 0,
  p_offer_amount             numeric default null,
  p_down_payment             numeric default 0,
  p_down_payment_account_id  uuid    default null,
  p_installments             integer default 1,
  p_first_due_date           date    default null,
  p_notes                    text    default null
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v public.vehicles;
  v_sale uuid;
begin
  select * into v from public.vehicles where id = p_vehicle_id for update;
  if not found then raise exception 'Veículo não encontrado.'; end if;
  if v.status = 'sold' or exists (select 1 from public.sales where vehicle_id = v.id and status <> 'cancelled') then
    raise exception 'Este veículo já possui uma venda registrada.';
  end if;
  if coalesce(p_down_payment, 0) > 0 and p_down_payment_account_id is null then
    raise exception 'Informe a conta financeira que recebeu a entrada.';
  end if;

  insert into public.sales (company_id, vehicle_id, customer_id, seller_id, sale_date, listed_price, offer_amount,
    discount, final_price, payment_method, down_payment, installments, first_due_date, status, notes)
  values (v.company_id, v.id, p_customer_id, auth.uid(), p_sale_date, v.listed_price, p_offer_amount,
    coalesce(p_discount, 0), p_final_price, p_payment_method, coalesce(p_down_payment, 0),
    coalesce(p_installments, 1), p_first_due_date, 'completed', p_notes)
  returning id into v_sale;

  if coalesce(p_down_payment, 0) > 0 then
    insert into public.sale_payments (company_id, sale_id, financial_account_id, paid_at, amount, method)
    values (v.company_id, v_sale, p_down_payment_account_id, p_sale_date, p_down_payment, p_payment_method);
  end if;

  update public.listings set status = 'ended', ended_at = p_sale_date
  where vehicle_id = v.id and status in ('draft', 'active', 'paused');
  return v_sale;
end $$;

-- Pagamento de uma conta a pagar
create or replace function public.pay_payable(p_payable_id uuid, p_account_id uuid, p_amount numeric default null,
                                              p_date date default current_date, p_proof_path text default null)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  ap public.accounts_payable;
  v_id uuid;
begin
  select * into ap from public.accounts_payable where id = p_payable_id;
  if not found then raise exception 'Conta a pagar não encontrada.'; end if;
  if ap.status in ('paid', 'cancelled') then raise exception 'Esta conta já está %.', ap.status; end if;
  if coalesce(p_amount, ap.balance) > ap.balance then
    raise exception 'Valor maior que o saldo em aberto (%).', ap.balance;
  end if;
  insert into public.financial_transactions (company_id, account_id, direction, amount, transaction_date, description,
    category_id, vehicle_id, supplier_id, payable_id, proof_path)
  values (ap.company_id, p_account_id, 'out', coalesce(p_amount, ap.balance), p_date, ap.description,
    ap.category_id, ap.vehicle_id, ap.supplier_id, ap.id, p_proof_path)
  returning id into v_id;
  return v_id;
end $$;

-- >>> 20261110000008_security.sql
-- =============================================================================
-- CARKING — 08 · Segurança: Row Level Security, auditoria, proteção de histórico
-- =============================================================================

-- -----------------------------------------------------------------------------
-- updated_at automático em todas as tabelas que possuem a coluna
-- -----------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'updated_at' and t.table_type = 'BASE TABLE'
  loop
    execute format('create trigger %I before update on public.%I for each row execute function app.set_updated_at()',
                   r.table_name || '_set_updated_at', r.table_name);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- RLS por empresa + permissão do módulo
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select * from (values
    ('suppliers', 'suppliers'), ('customers', 'customers'),
    ('auction_sources', 'auction'), ('auction_fee_tiers', 'auction'), ('auction_opportunities', 'auction'),
    ('vehicle_damage_assessments', 'auction'), ('auction_simulations', 'auction'), ('auction_bids', 'auction'),
    ('vehicles', 'vehicles'), ('vehicle_purchases', 'purchases'), ('vehicle_budgets', 'purchases'),
    ('expense_categories', 'finance'), ('expenses', 'finance'),
    ('inspection_checklist_templates', 'inspections'), ('vehicle_inspections', 'inspections'), ('inspection_items', 'inspections'),
    ('part_orders', 'parts'), ('parts', 'parts'),
    ('repair_orders', 'repairs'), ('repair_items', 'repairs'), ('labor_entries', 'repairs'),
    ('transport_orders', 'transport'), ('documents', 'documents'), ('attachments', 'vehicles'),
    ('listings', 'inventory'), ('vehicle_offers', 'inventory'),
    ('sales', 'sales'), ('sale_payments', 'sales'),
    ('financial_accounts', 'finance'), ('accounts_payable', 'finance'), ('accounts_receivable', 'finance'),
    ('financial_transfers', 'finance'), ('financial_transactions', 'finance'),
    ('branches', 'settings'), ('roles', 'employees'), ('permissions', 'employees')
  ) as t(table_name, module)
  loop
    execute format('alter table public.%I enable row level security', r.table_name);
    execute format($p$create policy %I on public.%I for select to authenticated
                     using (company_id = app.current_company_id() and app.has_permission(%L, 'view'))$p$,
                   r.table_name || '_select', r.table_name, r.module);
    execute format($p$create policy %I on public.%I for insert to authenticated
                     with check (company_id = app.current_company_id() and app.has_permission(%L, 'create'))$p$,
                   r.table_name || '_insert', r.table_name, r.module);
    execute format($p$create policy %I on public.%I for update to authenticated
                     using (company_id = app.current_company_id() and app.has_permission(%L, 'edit'))
                     with check (company_id = app.current_company_id())$p$,
                   r.table_name || '_update', r.table_name, r.module);
    execute format($p$create policy %I on public.%I for delete to authenticated
                     using (company_id = app.current_company_id() and app.has_permission(%L, 'delete'))$p$,
                   r.table_name || '_delete', r.table_name, r.module);
  end loop;
end $$;

-- Categorias de despesa e listas auxiliares precisam ser legíveis por quem lança custos
create policy expense_categories_select_all on public.expense_categories for select to authenticated
  using (company_id = app.current_company_id());
create policy auction_sources_select_all on public.auction_sources for select to authenticated
  using (company_id = app.current_company_id());
create policy suppliers_select_ops on public.suppliers for select to authenticated
  using (company_id = app.current_company_id()
         and (app.has_permission('parts', 'view') or app.has_permission('repairs', 'view')
              or app.has_permission('transport', 'view') or app.has_permission('finance', 'view')));
create policy customers_select_sales on public.customers for select to authenticated
  using (company_id = app.current_company_id() and (app.has_permission('sales', 'view') or app.has_permission('inventory', 'view')));
create policy branches_select_all on public.branches for select to authenticated
  using (company_id = app.current_company_id());
create policy roles_select_all on public.roles for select to authenticated
  using (company_id = app.current_company_id());

-- Empresa
alter table public.companies enable row level security;
create policy companies_select on public.companies for select to authenticated
  using (id = app.current_company_id());
create policy companies_update on public.companies for update to authenticated
  using (id = app.current_company_id() and app.has_permission('settings', 'edit'))
  with check (id = app.current_company_id());

-- Perfis
alter table public.profiles enable row level security;
create policy profiles_select on public.profiles for select to authenticated
  using (company_id = app.current_company_id());
create policy profiles_update_admin on public.profiles for update to authenticated
  using (company_id = app.current_company_id() and app.has_permission('employees', 'edit'))
  with check (company_id = app.current_company_id());
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- O próprio usuário não pode mudar seu papel, empresa ou status
create or replace function app.profile_guard()
returns trigger language plpgsql as $$
begin
  if auth.uid() = new.id and not app.has_permission('employees', 'edit')
     and (new.role_id, new.company_id, new.is_active) is distinct from (old.role_id, old.company_id, old.is_active) then
    raise exception 'Você não pode alterar seu próprio perfil de acesso.';
  end if;
  if new.company_id <> old.company_id then
    raise exception 'Não é permitido mover funcionários entre empresas.';
  end if;
  if (select code from public.roles where id = new.role_id) = 'super_admin'
     and (select code from public.roles where id = old.role_id) <> 'super_admin'
     and coalesce(app.current_role_code(), '') <> 'super_admin' then
    raise exception 'Apenas um Super Admin pode promover outro usuário a Super Admin.';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function app.profile_guard();

-- Histórico e auditoria: somente leitura
alter table public.vehicle_status_history enable row level security;
create policy vehicle_status_history_select on public.vehicle_status_history for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('vehicles', 'view'));
alter table public.vehicle_price_history enable row level security;
create policy vehicle_price_history_select on public.vehicle_price_history for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('vehicles', 'view'));
alter table public.audit_logs enable row level security;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('settings', 'view'));

-- -----------------------------------------------------------------------------
-- Preservação de histórico: registros que nunca podem ser apagados
-- -----------------------------------------------------------------------------
create trigger vehicles_no_delete           before delete on public.vehicles           for each row execute function app.prevent_delete();
create trigger vehicle_purchases_no_delete  before delete on public.vehicle_purchases  for each row execute function app.prevent_delete();
create trigger sales_no_delete              before delete on public.sales              for each row execute function app.prevent_delete();
create trigger sale_payments_no_delete      before delete on public.sale_payments      for each row execute function app.prevent_delete();
create trigger accounts_payable_no_delete   before delete on public.accounts_payable   for each row execute function app.prevent_delete();
create trigger accounts_receivable_no_delete before delete on public.accounts_receivable for each row execute function app.prevent_delete();
create trigger vehicle_status_history_no_delete before delete on public.vehicle_status_history for each row execute function app.prevent_delete();
create trigger audit_logs_no_delete         before delete on public.audit_logs         for each row execute function app.prevent_delete();

-- Custos lançados não são apagados: devem ser cancelados (status) para manter o rastro
create or replace function app.prevent_delete_costed()
returns trigger language plpgsql as $$
begin
  if (tg_table_name = 'parts' and old.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned'))
     or (tg_table_name = 'labor_entries' and old.status = 'confirmed')
     or (tg_table_name = 'expenses' and old.status = 'confirmed')
     or (tg_table_name = 'transport_orders' and old.actual_cost is not null)
     or (tg_table_name = 'part_orders' and old.status not in ('draft', 'cancelled')) then
    raise exception 'Este lançamento já gerou custo e não pode ser excluído. Altere o status para cancelado/devolvido.';
  end if;
  return old;
end $$;
create trigger parts_no_delete_costed            before delete on public.parts            for each row execute function app.prevent_delete_costed();
create trigger labor_entries_no_delete_costed    before delete on public.labor_entries    for each row execute function app.prevent_delete_costed();
create trigger expenses_no_delete_costed         before delete on public.expenses         for each row execute function app.prevent_delete_costed();
create trigger transport_orders_no_delete_costed before delete on public.transport_orders for each row execute function app.prevent_delete_costed();
create trigger part_orders_no_delete_costed      before delete on public.part_orders      for each row execute function app.prevent_delete_costed();

-- Veículo vendido: custos e orçamento ficam congelados
create or replace function app.freeze_sold_vehicle_costs()
returns trigger language plpgsql as $$
declare v_vehicle uuid := coalesce(new.vehicle_id, old.vehicle_id);
begin
  -- despesas de venda (comissão, taxas de transferência ao comprador...) podem ser lançadas após a venda
  if tg_table_name = 'expenses' then
    if (select c.cost_group from public.expense_categories c
        where c.id = (coalesce(to_jsonb(new), to_jsonb(old)) ->> 'category_id')::uuid) = 'selling' then
      return coalesce(new, old);
    end if;
  end if;
  if v_vehicle is not null and exists (
       select 1 from public.vehicles v where v.id = v_vehicle and v.status = 'sold') then
    raise exception 'O veículo já foi vendido: os custos estão encerrados. Cancele a venda para alterar.';
  end if;
  return coalesce(new, old);
end $$;
do $$
declare t text;
begin
  foreach t in array array['vehicle_purchases', 'vehicle_budgets', 'transport_orders', 'parts', 'part_orders',
                           'labor_entries', 'repair_items', 'expenses'] loop
    execute format('create trigger %I before insert or update or delete on public.%I for each row execute function app.freeze_sold_vehicle_costs()',
                   t || '_freeze_when_sold', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Auditoria das operações importantes
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'companies', 'profiles', 'roles', 'permissions',
    'auction_sources', 'auction_fee_tiers', 'auction_opportunities', 'auction_simulations', 'auction_bids',
    'vehicles', 'vehicle_purchases', 'vehicle_budgets', 'vehicle_inspections',
    'parts', 'part_orders', 'repair_orders', 'repair_items', 'labor_entries', 'transport_orders',
    'documents', 'expenses', 'sales', 'sale_payments', 'vehicle_offers',
    'financial_accounts', 'accounts_payable', 'accounts_receivable', 'financial_transactions', 'financial_transfers'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function app.audit_row()',
                   t || '_audit', t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- Privilégios
-- -----------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from anon, public;
revoke execute on all functions in schema app from anon, public;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema app to authenticated;

-- Tabelas de histórico/auditoria: somente leitura para o app
revoke insert, update, delete on public.audit_logs, public.vehicle_status_history, public.vehicle_price_history from authenticated;
-- Valores pagos/recebidos são calculados pelo sistema a partir das transações
create or replace function app.balance_guard()
returns trigger language plpgsql as $$
begin
  if current_user in ('authenticated', 'anon')
     and (to_jsonb(new) -> 'paid_amount', to_jsonb(new) -> 'received_amount')
         is distinct from (to_jsonb(old) -> 'paid_amount', to_jsonb(old) -> 'received_amount') then
    raise exception 'Valores pagos/recebidos são calculados automaticamente. Registre uma transação financeira.';
  end if;
  return new;
end $$;
create trigger accounts_payable_balance_guard before update on public.accounts_payable
  for each row execute function app.balance_guard();
create trigger accounts_receivable_balance_guard before update on public.accounts_receivable
  for each row execute function app.balance_guard();

-- >>> 20261110000009_storage.sql
-- =============================================================================
-- CARKING — 09 · Supabase Storage: fotos, vídeos, recibos e documentos
-- =============================================================================
-- Convenção de caminho (obrigatória): {company_id}/{entity_type}/{entity_id}/{arquivo}
-- Exemplo: 6f1c.../vehicle/9a2b.../frente-01.jpg
-- Após o upload, registre o arquivo em public.attachments (ou documents.storage_path).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('vehicle-media', 'vehicle-media', false, 52428800,
   array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime']),
  ('documents', 'documents', false, 26214400,
   array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy carking_storage_select on storage.objects for select to authenticated
  using (bucket_id in ('vehicle-media', 'documents')
         and (storage.foldername(name))[1] = app.current_company_id()::text);

create policy carking_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('vehicle-media', 'documents')
              and (storage.foldername(name))[1] = app.current_company_id()::text);

create policy carking_storage_update on storage.objects for update to authenticated
  using (bucket_id in ('vehicle-media', 'documents')
         and (storage.foldername(name))[1] = app.current_company_id()::text);

-- Arquivos de documentos só podem ser apagados por quem tem permissão de exclusão
create policy carking_storage_delete on storage.objects for delete to authenticated
  using (bucket_id in ('vehicle-media', 'documents')
         and (storage.foldername(name))[1] = app.current_company_id()::text
         and app.has_permission(case when bucket_id = 'documents' then 'documents' else 'vehicles' end::public.app_module, 'delete'));

-- >>> 20261111000010_default_towing.sql
-- =============================================================================
-- CARKING — 10 · Reboque (tow) padrão por leilão
-- =============================================================================
-- * auction_sources ganha o custo padrão de reboque/transporte do pátio do
--   leilão até a empresa (ex.: $200 por carro).
-- * Simulações e a calculadora usam esse valor quando o transporte não é
--   informado (informar 0 continua significando "sem transporte").
-- * Ao registrar a compra, uma ordem de transporte "quoted" é criada com o
--   valor previsto; ao confirmar o valor pago ele entra no custo do veículo e
--   em contas a pagar (regra de custo único preservada).
-- =============================================================================

alter table public.auction_sources
  add column default_transport_cost numeric(12,2) not null default 0 check (default_transport_cost >= 0),
  add column default_transport_provider text;

comment on column public.auction_sources.default_transport_cost is
  'Custo padrão de reboque/transporte por veículo comprado neste leilão (usado quando a simulação não informa o transporte).';

-- Sem default: nulo = usar o padrão do leilão
alter table public.auction_simulations alter column transport_cost drop default;

create or replace function app.compute_simulation(s public.auction_simulations, p_source_id uuid)
returns public.auction_simulations
language plpgsql stable
set search_path = public, pg_temp
as $$
declare
  v_other numeric;
  v_net   numeric;
  m       record;
begin
  if s.transport_cost is null then
    s.transport_cost := coalesce((select a.default_transport_cost from public.auction_sources a where a.id = p_source_id), 0);
  end if;

  s.contingency_total := round(coalesce(
    s.contingency_amount,
    (s.parts_cost + s.labor_cost + s.inspection_cost + s.other_costs) * coalesce(s.contingency_pct, 0) / 100,
    0), 2);

  s.auction_fees := coalesce(s.auction_fees_override, public.calculate_auction_fees(p_source_id, s.planned_bid));

  v_other := s.transport_cost + s.documentation_cost + s.parts_cost + s.labor_cost
           + s.inspection_cost + s.other_costs + s.contingency_total;
  v_net   := s.expected_sale_price - s.selling_costs;

  s.total_investment      := round(s.planned_bid + s.auction_fees + v_other, 2);
  s.projected_profit      := round(v_net - s.total_investment, 2);
  s.margin_pct            := round(s.projected_profit / s.expected_sale_price * 100, 4);
  s.roi_pct               := case when s.total_investment > 0 then round(s.projected_profit / s.total_investment * 100, 4) end;
  s.conservative_profit   := case when s.conservative_sale_price is not null
                                  then round(s.conservative_sale_price - s.selling_costs - s.total_investment, 2) end;
  s.optimistic_profit     := case when s.optimistic_sale_price is not null
                                  then round(s.optimistic_sale_price - s.selling_costs - s.total_investment, 2) end;
  s.break_even_sale_price := round(s.total_investment + s.selling_costs, 2);

  select * into m from public.calculate_max_bid(
    p_source_id, s.expected_sale_price, v_other, s.selling_costs,
    s.min_profit, s.min_margin_pct, s.min_roi_pct, s.auction_fees_override);

  s.max_bid              := m.max_bid;
  s.max_bid_fees         := m.auction_fees;
  s.max_bid_binding_rule := m.binding_rule;
  s.decision := case
    when m.max_bid <= 0 then 'not_viable'
    when s.planned_bid <= m.max_bid then 'viable'
    else 'above_limit' end;
  return s;
end $$;

-- Calculadora ao vivo: transporte nulo = padrão do leilão
create or replace function public.simulate_purchase(
  p_expected_sale_price     numeric,
  p_planned_bid             numeric default 0,
  p_source_id               uuid    default null,
  p_auction_fees_override   numeric default null,
  p_transport_cost          numeric default null,
  p_documentation_cost      numeric default 0,
  p_parts_cost              numeric default 0,
  p_labor_cost              numeric default 0,
  p_inspection_cost         numeric default 0,
  p_other_costs             numeric default 0,
  p_contingency_amount      numeric default null,
  p_contingency_pct         numeric default null,
  p_selling_costs           numeric default 0,
  p_min_profit              numeric default null,
  p_min_margin_pct          numeric default null,
  p_min_roi_pct             numeric default null,
  p_conservative_sale_price numeric default null,
  p_optimistic_sale_price   numeric default null
)
returns jsonb
language plpgsql stable
set search_path = public, pg_temp
as $$
declare s public.auction_simulations;
begin
  s.expected_sale_price     := p_expected_sale_price;
  s.conservative_sale_price := p_conservative_sale_price;
  s.optimistic_sale_price   := p_optimistic_sale_price;
  s.planned_bid             := coalesce(p_planned_bid, 0);
  s.auction_fees_override   := p_auction_fees_override;
  s.transport_cost          := p_transport_cost;
  s.documentation_cost      := coalesce(p_documentation_cost, 0);
  s.parts_cost              := coalesce(p_parts_cost, 0);
  s.labor_cost              := coalesce(p_labor_cost, 0);
  s.inspection_cost         := coalesce(p_inspection_cost, 0);
  s.other_costs             := coalesce(p_other_costs, 0);
  s.contingency_amount      := p_contingency_amount;
  s.contingency_pct         := p_contingency_pct;
  s.selling_costs           := coalesce(p_selling_costs, 0);
  s.min_profit              := p_min_profit;
  s.min_margin_pct          := p_min_margin_pct;
  s.min_roi_pct             := p_min_roi_pct;
  s := app.compute_simulation(s, p_source_id);
  return jsonb_build_object(
    'auction_fees',          s.auction_fees,
    'transport_cost',        s.transport_cost,
    'contingency_total',     s.contingency_total,
    'total_investment',      s.total_investment,
    'projected_profit',      s.projected_profit,
    'margin_pct',            s.margin_pct,
    'roi_pct',               s.roi_pct,
    'conservative_profit',   s.conservative_profit,
    'optimistic_profit',     s.optimistic_profit,
    'break_even_sale_price', s.break_even_sale_price,
    'max_bid',               s.max_bid,
    'max_bid_fees',          s.max_bid_fees,
    'max_bid_binding_rule',  s.max_bid_binding_rule,
    'decision',              s.decision
  );
end $$;

-- Compra sem simulação: orçamento de transporte = padrão do leilão
create or replace function app.budget_default_transport()
returns trigger language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.simulation_id is null and new.transport = 0 then
    new.transport := coalesce((
      select a.default_transport_cost from public.vehicle_purchases p
      join public.auction_sources a on a.id = p.source_id
      where p.vehicle_id = new.vehicle_id), 0);
  end if;
  return new;
end $$;
create trigger vehicle_budgets_default_transport before insert on public.vehicle_budgets
  for each row execute function app.budget_default_transport();

-- Ao criar o orçamento do veículo, abre a ordem de reboque prevista
create or replace function app.budget_create_transport_order()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  p public.vehicle_purchases;
  a public.auction_sources;
  o public.auction_opportunities;
begin
  if new.transport <= 0 or exists (select 1 from public.transport_orders t where t.vehicle_id = new.vehicle_id) then
    return new;
  end if;
  select * into p from public.vehicle_purchases where vehicle_id = new.vehicle_id;
  select * into a from public.auction_sources where id = p.source_id;
  select * into o from public.auction_opportunities where id = p.opportunity_id;

  insert into public.transport_orders (company_id, vehicle_id, carrier_name, pickup_address, estimated_cost, status, notes)
  values (new.company_id, new.vehicle_id, a.default_transport_provider,
          nullif(concat_ws(', ', coalesce(o.auction_name, a.name), o.location_city, o.location_state, o.location_zip), ''),
          new.transport, 'quoted', 'Reboque criado automaticamente na compra');
  return new;
end $$;
create trigger vehicle_budgets_create_transport after insert on public.vehicle_budgets
  for each row execute function app.budget_create_transport_order();

grant execute on all functions in schema public to authenticated;
grant execute on all functions in schema app to authenticated;
revoke execute on all functions in schema public from anon, public;
revoke execute on all functions in schema app from anon, public;

-- >>> 20261111000011_employee_access.sql
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
