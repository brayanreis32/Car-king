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
