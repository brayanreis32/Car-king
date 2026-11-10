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
