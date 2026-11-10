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
