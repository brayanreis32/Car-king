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
