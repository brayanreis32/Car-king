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
