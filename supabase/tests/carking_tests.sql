-- =============================================================================
-- CARKING — testes de regras de negócio (executados por run_local.sh)
-- Rodam como o papel "authenticated", com RLS ativo, como o app real.
-- =============================================================================
\set ON_ERROR_STOP 1

create or replace function pg_temp.eq(p_label text, p_got anyelement, p_expected anyelement)
returns void language plpgsql as $$
begin
  if p_got is distinct from p_expected then
    raise exception 'FALHOU: % — esperado %, obtido %', p_label, p_expected, p_got;
  end if;
  raise notice 'ok  %', p_label;
end $$;

create or replace function pg_temp.must_fail(p_label text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    set constraints all immediate; -- faz triggers adiados dispararem dentro do bloco
    execute p_sql;
  exception when others then
    raise notice 'ok  % (bloqueado: %)', p_label, sqlerrm;
    return;
  end;
  raise exception 'FALHOU: % — a operação deveria ter sido bloqueada', p_label;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000000001', 'owner@carking.test'),
  ('00000000-0000-0000-0000-000000000002', 'mechanic@carking.test'),
  ('00000000-0000-0000-0000-000000000003', 'other@another.test');

grant execute on function pg_temp.eq(text, anyelement, anyelement) to authenticated;
grant execute on function pg_temp.must_fail(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 1. Onboarding como dono
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false) \g /dev/null
set role authenticated;

select public.create_company('Car King Auto Sales', 'Owner') as ck_company \gset
select pg_temp.eq('papéis padrão criados', (select count(*) from roles), 8::bigint);
select pg_temp.eq('checklist padrão criado', (select count(*) > 30 from inspection_checklist_templates), true);
select pg_temp.eq('super admin pode tudo', (select bool_and(can_delete) from my_permissions()), true);

-- ---------------------------------------------------------------------------
-- 2. Simulador — exemplo do Toyota Camry 2021 da especificação
-- ---------------------------------------------------------------------------
do $$
declare r jsonb;
begin
  r := public.simulate_purchase(
    p_expected_sale_price => 12000, p_planned_bid => 4000, p_auction_fees_override => 650,
    p_transport_cost => 350, p_parts_cost => 1000, p_labor_cost => 500, p_documentation_cost => 200,
    p_contingency_amount => 300, p_min_profit => 2000,
    p_conservative_sale_price => 10500, p_optimistic_sale_price => 13000);
  perform pg_temp.eq('Camry: investimento total', (r->>'total_investment')::numeric, 7000.00);
  perform pg_temp.eq('Camry: lucro projetado', (r->>'projected_profit')::numeric, 5000.00);
  perform pg_temp.eq('Camry: margem 41.67%', round((r->>'margin_pct')::numeric, 2), 41.67);
  perform pg_temp.eq('Camry: ROI 71.43%', round((r->>'roi_pct')::numeric, 2), 71.43);
  perform pg_temp.eq('Camry: cenário conservador', (r->>'conservative_profit')::numeric, 3500.00);
  perform pg_temp.eq('Camry: cenário otimista', (r->>'optimistic_profit')::numeric, 6000.00);
  -- lucro mínimo $2.000: 12000 − 2000 − 2350 (outros custos) − 650 (taxas) = 7000
  perform pg_temp.eq('Camry: lance máximo p/ lucro de $2.000', (r->>'max_bid')::numeric, 7000.00);
  perform pg_temp.eq('Camry: decisão', r->>'decision', 'viable');
end $$;

-- ---------------------------------------------------------------------------
-- 3. Lance máximo com taxas variáveis por faixa
-- ---------------------------------------------------------------------------
insert into auction_sources (name, bid_increment, flat_fees, flat_fees_description)
values ('Leilão Teste', 25, 79, 'gate + environmental');

insert into auction_fee_tiers (source_id, fee_type, min_amount, max_amount, fixed_fee, percent_fee)
select id, 'buyer_fee', x.mn, x.mx, x.fx, x.pc
from auction_sources, (values (0::numeric, 1000::numeric, 100::numeric, 0::numeric),
                              (1000, 5000, 0, 10),
                              (5000, null, 200, 6)) as x(mn, mx, fx, pc)
where name = 'Leilão Teste';

select pg_temp.must_fail('faixas de taxa sobrepostas',
  $q$insert into auction_fee_tiers (source_id, min_amount, max_amount, fixed_fee)
     select id, 4000, 6000, 1 from auction_sources where name = 'Leilão Teste'$q$);

do $$
declare
  v_src uuid := (select id from auction_sources where name = 'Leilão Teste');
  m record;
begin
  perform pg_temp.eq('taxa p/ lance $500',  public.calculate_auction_fees(v_src, 500),  179.00);
  perform pg_temp.eq('taxa p/ lance $4000', public.calculate_auction_fees(v_src, 4000), 479.00);
  perform pg_temp.eq('taxa p/ lance $6000', public.calculate_auction_fees(v_src, 6000), 639.00);
  -- 12000 − 2000 − 2350 = 7650 p/ lance+taxas; faixa ≥5000: (7650 − 279) / 1.06 = 6953.77 → incremento $25 → 6950
  select * into m from public.calculate_max_bid(v_src, 12000, 2350, 0, 2000, null, null);
  perform pg_temp.eq('lance máximo com taxa variável', m.max_bid, 6950.00);
  perform pg_temp.eq('taxas no lance máximo', m.auction_fees, 696.00);
  perform pg_temp.eq('lucro no lance máximo ≥ $2.000', m.projected_profit >= 2000, true);
  perform pg_temp.eq('regra limitante', m.binding_rule, 'min_profit');
  -- margem mínima de 30% fica mais restritiva que o lucro mínimo
  select * into m from public.calculate_max_bid(v_src, 12000, 2350, 0, 2000, 30, null);
  perform pg_temp.eq('margem mínima 30% respeitada', m.margin_pct >= 30, true);
  perform pg_temp.eq('regra limitante margem', m.binding_rule, 'min_margin');
  -- operação inviável
  select * into m from public.calculate_max_bid(v_src, 3000, 2350, 0, 2000, null, null);
  perform pg_temp.eq('operação inviável', m.binding_rule, 'not_viable');
end $$;

-- Reboque padrão do leilão ($200) entra quando o transporte não é informado
update auction_sources set default_transport_cost = 200, default_transport_provider = 'Reboque Padrão'
where name = 'Leilão Teste';
do $$
declare
  v_src uuid := (select id from auction_sources where name = 'Leilão Teste');
  r jsonb;
begin
  r := public.simulate_purchase(p_expected_sale_price => 12000, p_planned_bid => 4000, p_source_id => v_src);
  perform pg_temp.eq('simulação usa reboque padrão $200', (r->>'transport_cost')::numeric, 200.00);
  r := public.simulate_purchase(p_expected_sale_price => 12000, p_planned_bid => 4000, p_source_id => v_src, p_transport_cost => 450);
  perform pg_temp.eq('reboque informado substitui o padrão', (r->>'transport_cost')::numeric, 450.00);
  r := public.simulate_purchase(p_expected_sale_price => 12000, p_planned_bid => 4000, p_source_id => v_src, p_transport_cost => 0);
  perform pg_temp.eq('transporte zero continua zero', (r->>'transport_cost')::numeric, 0.00);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Oportunidade, validação do título, simulação e compra
-- ---------------------------------------------------------------------------
insert into auction_opportunities (source_id, auction_name, lot_number, vin, make, model, year, odometer,
  title_status, primary_damage, run_condition, has_keys, current_bid, market_value_clean, expected_value_repaired)
select id, 'Orlando South', '12345678', '4t1b11hk5mu123456', 'Toyota', 'Camry', 2021, 45000,
  'salvage', 'Front end', 'run_and_drive', true, 3500, 16000, 12000
from auction_sources where name = 'Leilão Teste';

select pg_temp.eq('VIN normalizado em maiúsculas',
  (select vin from auction_opportunities where lot_number = '12345678'), '4T1B11HK5MU123456');

select pg_temp.must_fail('aprovar sem validar título',
  $q$update auction_opportunities set status = 'approved' where lot_number = '12345678'$q$);

insert into vehicle_damage_assessments (opportunity_id, area, condition, severity, description, estimated_cost)
select id, 'front', 'needs_replacement', 'high', 'Para-choque e farol esquerdo', 470
from auction_opportunities where lot_number = '12345678';

insert into auction_simulations (opportunity_id, name, expected_sale_price, conservative_sale_price, optimistic_sale_price,
  planned_bid, transport_cost, parts_cost, labor_cost, documentation_cost, contingency_amount, min_profit, min_margin_pct)
select id, 'Cenário base', 12000, 10500, 13000, 4000, 350, 1000, 500, 200, 300, 2000, 0
from auction_opportunities where lot_number = '12345678';

select pg_temp.eq('simulação: taxas pela tabela (4000 → 479)', auction_fees, 479.00),
       pg_temp.eq('simulação: investimento', total_investment, 6829.00),
       pg_temp.eq('simulação: lance máximo', max_bid, 6950.00),
       pg_temp.eq('simulação: decisão', decision, 'viable')
from auction_simulations where name = 'Cenário base';

update auction_opportunities set title_verified = true, status = 'approved' where lot_number = '12345678';
insert into auction_bids (opportunity_id, amount) select id, 3900 from auction_opportunities where lot_number = '12345678';
select pg_temp.eq('lance muda status p/ bid_placed',
  (select status::text from auction_opportunities where lot_number = '12345678'), 'bid_placed');
select pg_temp.eq('lance dentro do limite', (select exceeds_max_bid from auction_bids limit 1), false);

select public.register_purchase(
  (select id from auction_opportunities where lot_number = '12345678'),
  p_final_bid => 3900, p_buyer_fee => 469, p_other_fees => 0, p_stock_number => 'CK-0001') \g /dev/null

select pg_temp.eq('veículo criado', (select count(*) from vehicles), 1::bigint);
select pg_temp.eq('oportunidade arrematada', (select status::text from auction_opportunities where lot_number = '12345678'), 'won');
select pg_temp.eq('simulação preservada (travada)', (select locked from auction_simulations where name = 'Cenário base'), true);
select pg_temp.eq('orçamento de peças = simulação', (select parts from vehicle_budgets), 1000.00);
select pg_temp.eq('conta a pagar do leilão', (select amount from accounts_payable where source_type = 'vehicle_purchase'), 4369.00);
select pg_temp.eq('documentos obrigatórios (salvage title)',
  (select count(*) from documents where doc_type = 'salvage_title' and status = 'pending'), 1::bigint);
select pg_temp.eq('danos vinculados ao veículo', (select count(*) from vehicle_damage_assessments where vehicle_id is not null), 1::bigint);

select pg_temp.must_fail('alterar simulação travada',
  $q$update auction_simulations set planned_bid = 1 where name = 'Cenário base'$q$);
select pg_temp.must_fail('registrar a mesma compra duas vezes',
  $q$select public.register_purchase((select id from auction_opportunities where lot_number = '12345678'), 3900)$q$);
select pg_temp.must_fail('VIN duplicado',
  $q$select public.register_direct_purchase('4T1B11HK5MU123456', 'Toyota', 'Camry', 2021, 'clean', 5000)$q$);
select pg_temp.must_fail('veículo sem aquisição',
  $q$insert into vehicles (vin, make, model, year) values ('1HGCM82633A004352', 'Honda', 'Accord', 2003)$q$);
select pg_temp.must_fail('excluir veículo', $q$delete from vehicles$q$);

-- Simulação salva sem transporte informado usa o padrão do leilão
insert into auction_simulations (opportunity_id, name, expected_sale_price, planned_bid)
select id, 'Sem transporte informado', 12000, 4000 from auction_opportunities where lot_number = '12345678';
select pg_temp.eq('simulação salva usa reboque padrão',
  (select transport_cost from auction_simulations where name = 'Sem transporte informado'), 200.00);
delete from auction_simulations where name = 'Sem transporte informado';

-- ---------------------------------------------------------------------------
-- 5. Transporte, inspeção, peças, mão de obra e despesas
-- ---------------------------------------------------------------------------
insert into suppliers (name, supplier_type) values ('Auto Parts Co', 'parts'), ('Body Shop Miami', 'body_shop'), ('Fast Carrier', 'transport');

select pg_temp.eq('reboque previsto criado na compra',
  (select estimated_cost || '/' || status from transport_orders), '350.00/quoted');
select pg_temp.eq('reboque previsto não gera conta a pagar',
  (select count(*) from accounts_payable where source_type = 'transport_order'), 0::bigint);
update transport_orders set supplier_id = (select id from suppliers where name = 'Fast Carrier'),
                            carrier_name = 'Fast Carrier', status = 'booked';
select pg_temp.eq('transporte agendado → aguardando retirada', (select status::text from vehicles), 'awaiting_pickup');
update transport_orders set status = 'delivered', actual_cost = 400;
select pg_temp.eq('transporte entregue → recebido', (select status::text from vehicles), 'received');
select pg_temp.eq('conta a pagar do transporte', (select amount from accounts_payable where source_type = 'transport_order'), 400.00);

select public.start_inspection((select id from vehicles)) \g /dev/null
select pg_temp.eq('inspeção com checklist', (select count(*) > 30 from inspection_items), true);
select pg_temp.eq('veículo em inspeção', (select status::text from vehicles), 'in_inspection');

insert into parts (vehicle_id, supplier_id, name, category, quantity, estimated_unit_price, actual_unit_price, status)
select v.id, s.id, x.name, x.cat, x.qty, x.est, x.act, x.st::part_status
from vehicles v, suppliers s,
  (values ('Front bumper', 'body', 1, 280::numeric, null::numeric, 'to_buy'),
          ('Left headlight', 'lighting', 1, 190, null, 'to_buy'),
          ('Hood', 'body', 1, 350, 380, 'purchased'),
          ('Radiator support', 'body', 1, 120, 120, 'installed'),
          ('Front tires', 'tires_wheels', 2, 80, 80, 'purchased')) as x(name, cat, qty, est, act, st)
where s.name = 'Auto Parts Co';

select pg_temp.must_fail('peça comprada sem preço real',
  $q$update parts set status = 'purchased' where name = 'Front bumper'$q$);

select pg_temp.eq('Parts List: itens', items, 5::bigint),
       pg_temp.eq('Parts List: pendentes', pending_items, 4::bigint),
       pg_temp.eq('Parts List: total estimado', estimated_total, 1100.00),
       pg_temp.eq('Parts List: total real', actual_total, 660.00)
from vehicle_parts_summary;

insert into repair_orders (vehicle_id, title, supplier_id, status)
select v.id, 'Funilaria dianteira', s.id, 'in_progress' from vehicles v, suppliers s where s.name = 'Body Shop Miami';
insert into repair_items (repair_order_id, vehicle_id, area, service, estimated_cost, status)
select r.id, r.vehicle_id, 'front', x.svc, x.est, x.st::repair_status
from repair_orders r, (values ('Troca de para-choque', 150::numeric, 'pending'),
                              ('Instalação do farol', 80, 'pending'),
                              ('Pintura', 350, 'in_progress')) as x(svc, est, st);
insert into labor_entries (vehicle_id, repair_item_id, supplier_id, description, flat_amount)
select ri.vehicle_id, ri.id, r.supplier_id, 'Pintura — adiantamento', 200
from repair_items ri join repair_orders r on r.id = ri.repair_order_id where ri.service = 'Pintura';
select pg_temp.eq('conta a pagar da oficina', (select amount from accounts_payable where source_type = 'labor_entry'), 200.00);

select pg_temp.must_fail('despesa avulsa não pode duplicar transporte',
  $q$insert into expenses (vehicle_id, category_id, description, amount)
     select v.id, c.id, 'Frete', 350 from vehicles v, expense_categories c where c.cost_group = 'transport'$q$);

insert into expenses (vehicle_id, category_id, description, amount)
select v.id, c.id, 'Taxa de título', 180 from vehicles v, expense_categories c where c.cost_group = 'documentation';

-- ---------------------------------------------------------------------------
-- 6. Orçamento previsto × real e lucro projetado
-- ---------------------------------------------------------------------------
select pg_temp.eq('compra: real 3900 vs previsto 4000', (select difference from vehicle_budget_vs_actual where line = 'purchase'), -100.00);
select pg_temp.eq('transporte acima do orçamento', (select alert_level from vehicle_budget_vs_actual where line = 'transport'), 'critical');
select pg_temp.eq('peças: projetado = real + a comprar', (select projected from vehicle_budget_vs_actual where line = 'parts'), 1130.00);
-- mão de obra: 200 lançado + 150 + 80 + (350 − 200) pendentes = 580
select pg_temp.eq('mão de obra projetada', (select projected from vehicle_budget_vs_actual where line = 'labor'), 580.00);
-- estouros: transporte 50 + peças 130 + mão de obra 80 = 260 consumidos da reserva de 300
select pg_temp.eq('reserva de imprevistos restante', (select projected from vehicle_budget_vs_actual where line = 'contingency'), 40.00);
-- investimento projetado: 3900 + 469 + 400 + 1130 + 580 + 200 + 40 = 6719
select pg_temp.eq('investimento projetado', (select projected_cost from vehicle_profit_analysis), 6719.00);
select pg_temp.eq('lucro projetado', (select projected_profit from vehicle_profit_analysis), 5281.00);
select pg_temp.eq('preço mínimo sem prejuízo', (select break_even_price from vehicle_profit_analysis), 6719.00);
select pg_temp.eq('alerta de orçamento gerado', (select count(*) > 0 from alerts where alert_type = 'budget_overrun'), true);

-- ---------------------------------------------------------------------------
-- 7. Proposta, venda, pagamentos e financeiro
-- ---------------------------------------------------------------------------
insert into customers (full_name, phone) values ('John Buyer', '+1 407 555 0100');
insert into financial_accounts (name, account_type, opening_balance) values ('Operating', 'bank', 20000);
update vehicles set status = 'listed', listed_price = 12500;
insert into vehicle_offers (vehicle_id, customer_id, offer_amount)
select v.id, c.id, 7000 from vehicles v, customers c;
select pg_temp.eq('proposta baixa não atinge a meta', (select meets_targets from vehicle_offers_analysis), false);

select pay_payable((select id from accounts_payable where source_type = 'vehicle_purchase'),
                   (select id from financial_accounts where name = 'Operating')) \g /dev/null
select pg_temp.eq('conta do leilão paga', (select status from accounts_payable where source_type = 'vehicle_purchase'), 'paid');
select pg_temp.must_fail('excluir transação confirmada', $q$delete from financial_transactions$q$);
select pg_temp.must_fail('alterar valor de transação confirmada', $q$update financial_transactions set amount = 1$q$);
select pg_temp.must_fail('editar valor pago manualmente', $q$update accounts_payable set paid_amount = 0$q$);

select register_sale((select id from vehicles), (select id from customers), 11800,
                     p_payment_method => 'mixed', p_down_payment => 5000,
                     p_down_payment_account_id => (select id from financial_accounts where name = 'Operating')) \g /dev/null

select pg_temp.eq('veículo vendido', (select status::text from vehicles), 'sold');
select pg_temp.eq('conta a receber parcial', (select status from accounts_receivable), 'partial');
select pg_temp.eq('saldo a receber', (select balance from accounts_receivable), 6800.00);
select pg_temp.eq('alerta: vendido com saldo', (select count(*) from alerts where alert_type = 'sold_with_balance'), 1::bigint);
select pg_temp.must_fail('venda duplicada',
  $q$select register_sale((select id from vehicles), (select id from customers), 11800)$q$);
select pg_temp.must_fail('custos congelados após a venda',
  $q$insert into expenses (vehicle_id, category_id, description, amount)
     select v.id, c.id, 'x', 10 from vehicles v, expense_categories c where c.cost_group = 'other'$q$);

insert into expenses (vehicle_id, category_id, description, amount)
select v.id, c.id, 'Comissão do vendedor', 300 from vehicles v, expense_categories c where c.cost_group = 'selling';

-- Real: 3900 + 469 + 400 + 660 + 200 + 180 = 5809; lucro = 11800 − 5809 − 300 = 5691
select pg_temp.eq('custo real final', (select actual_cost from vehicle_profit_analysis), 5809.00);
select pg_temp.eq('lucro real', (select real_profit from vehicle_profit_analysis), 5691.00);
select pg_temp.eq('margem real', (select real_margin_pct from vehicle_profit_analysis), 48.23);
select pg_temp.eq('dashboard: vendidos', (select vehicles_sold from dashboard_kpis), 1::bigint);
select pg_temp.eq('saldo da conta: 20000 − 4369 + 5000', (select balance from financial_account_balances), 20631.00);
select pg_temp.eq('histórico de status preservado', (select count(*) >= 5 from vehicle_status_history), true);
select pg_temp.eq('auditoria registrada', (select count(*) > 0 from audit_logs where table_name = 'sales'), true);

-- ---------------------------------------------------------------------------
-- 7b. Extrato bancário: importação e conciliação
-- ---------------------------------------------------------------------------
insert into bank_statement_lines (account_id, posted_date, amount, description, reference)
select a.id, x.d::date, x.v, x.t, x.r from financial_accounts a,
  (values ('2026-11-12', -400.00, 'FAST CARRIER TOWING', 'r1'),
          ('2026-11-13', 6800.00, 'ZELLE FROM JOHN BUYER', 'r2'),
          ('2026-11-13', -35.00, 'MONTHLY SERVICE FEE', 'r3'),
          ('2026-11-14', 1000.00, 'DEPOSIT OWNER', 'r4')) as x(d, v, t, r)
where a.name = 'Operating';
insert into bank_statement_lines (account_id, posted_date, amount, description, reference)
select a.id, '2026-11-12', -400.00, 'FAST CARRIER TOWING', 'r1' from financial_accounts a where a.name = 'Operating'
on conflict (account_id, reference) do nothing;
select pg_temp.eq('importar o mesmo extrato não duplica', (select count(*) from bank_statement_lines), 4::bigint);
select pg_temp.eq('sugestão: saída de $400 = conta do reboque',
  (select match_description from bank_line_suggestions where description = 'FAST CARRIER TOWING'), 'Transporte — Fast Carrier');
select pg_temp.eq('sugestão: entrada de $6.800 = saldo da venda',
  (select match_kind from bank_line_suggestions where description = 'ZELLE FROM JOHN BUYER'), 'receivable');

select bank_match_payable((select line_id from bank_line_suggestions where description = 'FAST CARRIER TOWING'),
                          (select match_id from bank_line_suggestions where description = 'FAST CARRIER TOWING')) \g /dev/null
select pg_temp.eq('reboque pago pelo extrato', (select status from accounts_payable where source_type = 'transport_order'), 'paid');
select pg_temp.must_fail('mesmo lançamento não concilia duas vezes',
  $q$select bank_record_income((select id from bank_statement_lines where description = 'FAST CARRIER TOWING'))$q$);

select bank_match_receivable((select line_id from bank_line_suggestions where description = 'ZELLE FROM JOHN BUYER'),
                             (select match_id from bank_line_suggestions where description = 'ZELLE FROM JOHN BUYER')) \g /dev/null
select pg_temp.eq('venda quitada pelo extrato', (select status from accounts_receivable), 'received');

select bank_create_expense((select id from bank_statement_lines where description = 'MONTHLY SERVICE FEE'),
                           (select id from expense_categories where cost_group = 'other'), 'Tarifa bancária') \g /dev/null
select pg_temp.eq('tarifa vira despesa geral paga',
  (select ap.status from accounts_payable ap join expenses e on e.id = ap.source_id where e.description = 'Tarifa bancária'), 'paid');

select bank_record_income((select id from bank_statement_lines where description = 'DEPOSIT OWNER'), 'Aporte do sócio') \g /dev/null
select pg_temp.eq('nenhum lançamento pendente', (select count(*) from bank_statement_lines where status = 'pending'), 0::bigint);
-- 20631 − 400 + 6800 − 35 + 1000
select pg_temp.eq('saldo da conta bate com o banco', (select balance from financial_account_balances), 27996.00);
select pg_temp.must_fail('conciliado não pode ser alterado',
  $q$update bank_statement_lines set amount = 1 where description = 'DEPOSIT OWNER'$q$);

-- ---------------------------------------------------------------------------
-- 7c. Venda parcelada
-- ---------------------------------------------------------------------------
select register_direct_purchase('2T1BURHE5JC000101', 'Toyota', 'Corolla', 2018, 'clean', 5000, p_purchase_date => '2026-11-01') \g /dev/null
select register_sale((select id from vehicles where vin = '2T1BURHE5JC000101'), (select id from customers limit 1), 12000,
  p_sale_date => '2026-11-10', p_payment_method => 'cash', p_down_payment => 2000,
  p_down_payment_account_id => (select id from financial_accounts where name = 'Operating'),
  p_installments => 10, p_installment_frequency => 'monthly') \g /dev/null
select pg_temp.eq('parcelado sem juros: entrada + 10 parcelas',
  (select count(*) from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101'), 11::bigint);
select pg_temp.eq('parcela de $1.000', (select installment_amount from sales s join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101'), 1000.00);
select pg_temp.eq('soma das contas = preço', (select sum(ar.amount) from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101'), 12000.00);
select pg_temp.eq('entrada já recebida', (select ar.status from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101' and ar.installment_number = 0), 'received');
select pg_temp.eq('1ª parcela vence 1 mês depois', (select ar.due_date from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101' and ar.installment_number = 1), '2026-12-10'::date);
select pg_temp.eq('10ª parcela', (select ar.due_date from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101' and ar.installment_number = 10), '2027-09-10'::date);
select pg_temp.eq('lucro do carro usa o preço de venda', (select real_profit from vehicle_profit_analysis where vin = '2T1BURHE5JC000101'), 7000.00);

select register_direct_purchase('2T1BURHE5JC000102', 'Toyota', 'Corolla', 2019, 'clean', 5000) \g /dev/null
select register_sale((select id from vehicles where vin = '2T1BURHE5JC000102'), (select id from customers limit 1), 12000,
  p_sale_date => '2026-11-10', p_down_payment => 2000, p_payment_method => 'cash',
  p_down_payment_account_id => (select id from financial_accounts where name = 'Operating'),
  p_installments => 12, p_interest_rate_apr => 12) \g /dev/null
select pg_temp.eq('juros 12% a.a.: parcela (tabela Price)', (select installment_amount from sales s join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000102'), 888.49);
select pg_temp.eq('total com juros', (select total_with_interest from sales s join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000102'), 12661.88);
select pg_temp.eq('quinzenal/semanal: plano calculado', (select installment_amount from installment_plan(1000, 4, 0, 'weekly')), 250.00);

-- pagar a 1ª parcela
insert into financial_transactions (account_id, direction, amount, transaction_date, description, receivable_id)
select a.id, 'in', ar.amount, '2026-12-10', ar.description, ar.id
from financial_accounts a, accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id
where a.name = 'Operating' and v.vin = '2T1BURHE5JC000101' and ar.installment_number = 1;
select pg_temp.eq('parcela 1 recebida', (select ar.status from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101' and ar.installment_number = 1), 'received');
select pg_temp.must_fail('não cancela venda com parcelas pagas',
  $q$update sales set status = 'cancelled', cancel_reason = 'teste' where vehicle_id = (select id from vehicles where vin = '2T1BURHE5JC000101')$q$);

-- lembrete de cobrança
select log_payment_reminder((select ar.id from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101' and ar.installment_number = 2)) \g /dev/null
select pg_temp.eq('lembrete registrado', (select reminder_count from accounts_receivable ar join sales s on s.id = ar.sale_id join vehicles v on v.id = s.vehicle_id where v.vin = '2T1BURHE5JC000101' and ar.installment_number = 2), 1);
select pg_temp.eq('mensagem padrão existe', (select reminder_template like 'Hi {cliente}%' from companies where name = 'Car King Auto Sales'), true);

-- ---------------------------------------------------------------------------
-- 8. Permissões e isolamento entre empresas
-- ---------------------------------------------------------------------------
reset role;
insert into profiles (id, company_id, role_id, full_name)
select '00000000-0000-0000-0000-000000000002', c.id, r.id, 'Mike Mechanic'
from companies c join roles r on r.company_id = c.id and r.code = 'mechanic';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false) \g /dev/null
set role authenticated;
select pg_temp.eq('mecânico vê peças', (select count(*) from parts), 5::bigint);
select pg_temp.eq('mecânico não vê financeiro', (select count(*) from financial_transactions), 0::bigint);
select pg_temp.eq('mecânico não vê análise de lucro', (select count(*) from vehicle_profit_analysis), 0::bigint);
select pg_temp.must_fail('mecânico não lança venda',
  $q$insert into sales (vehicle_id, customer_id, final_price) select id, id, 1 from vehicles$q$);
select pg_temp.must_fail('mecânico não se promove',
  $q$update profiles set role_id = (select id from roles where code = 'super_admin') where id = auth.uid()$q$);

-- Administrador: gerencia funcionários, mas não mexe no acesso do desenvolvedor
reset role;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000004', 'admin@carking.test');
insert into profiles (id, company_id, role_id, full_name)
select '00000000-0000-0000-0000-000000000004', c.id, r.id, 'Ana Admin'
from companies c join roles r on r.company_id = c.id and r.code = 'admin' where c.name = 'Car King Auto Sales';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', false) \g /dev/null
set role authenticated;
select pg_temp.eq('admin não vê o login do desenvolvedor', (select count(*) from profiles where full_name = 'Owner'), 0::bigint);
select pg_temp.eq('admin não vê o perfil Desenvolvedor', (select count(*) from roles where code = 'super_admin'), 0::bigint);
select pg_temp.eq('admin vê os demais perfis', (select count(*) from roles), 7::bigint);
update profiles set role_id = (select id from roles where code = 'seller') where full_name = 'Mike Mechanic';
select pg_temp.eq('admin muda perfil do mecânico para vendedor',
  (select r.code from profiles p join roles r on r.id = p.role_id where p.full_name = 'Mike Mechanic'), 'seller');
update profiles set is_active = false where id = '00000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.eq('desenvolvedor continua ativo após tentativa do admin',
  (select is_active from profiles where id = '00000000-0000-0000-0000-000000000001'), true);
select pg_temp.eq('perfil do dono se chama Desenvolvedor',
  (select r.name from profiles p join roles r on r.id = p.role_id where p.full_name = 'Owner'), 'Desenvolvedor (acesso total)');
-- mesmo sabendo o id do perfil Desenvolvedor, o admin não consegue atribuí-lo
select set_config('test.dev_role', (select r.id::text from roles r join companies c on c.id = r.company_id where r.code = 'super_admin' and c.name = 'Car King Auto Sales'), false) \g /dev/null
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000004', false) \g /dev/null
set role authenticated;
select pg_temp.must_fail('admin não atribui o perfil Desenvolvedor (mesmo com o id)',
  $q$update profiles set role_id = current_setting('test.dev_role')::uuid where full_name = 'Mike Mechanic'$q$);
select pg_temp.must_fail('admin não se desativa',
  $q$update profiles set is_active = false where id = auth.uid()$q$);

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', false) \g /dev/null
set role authenticated;
select public.create_company('Outra Empresa', 'Other Owner') \g /dev/null
select pg_temp.eq('outra empresa não vê veículos', (select count(*) from vehicles), 0::bigint);
select pg_temp.eq('outra empresa não vê custos', (select count(*) from vehicle_cost_ledger), 0::bigint);
select pg_temp.eq('outra empresa não vê alertas alheios', (select count(*) from alerts), 0::bigint);
select pg_temp.must_fail('inserir dados em outra empresa',
  format('insert into customers (company_id, full_name) values (%L, %L)', :'ck_company', 'Intruso'));

-- outra empresa não exclui veículo alheio
reset role;
select set_config('test.sold_vehicle', (select id::text from vehicles where status = 'sold' order by created_at limit 1), false) \g /dev/null
set role authenticated;
select pg_temp.must_fail('outra empresa não exclui veículo alheio',
  $q$select public.delete_vehicle(current_setting('test.sold_vehicle')::uuid)$q$);

-- ---------------------------------------------------------------------------
-- Exclusão de testes / cadastros errados
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false) \g /dev/null
set role authenticated;
select pg_temp.must_fail('vendedor não exclui veículo',
  $q$select public.delete_vehicle(current_setting('test.sold_vehicle')::uuid)$q$);

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false) \g /dev/null
set role authenticated;
select pg_temp.must_fail('apagar veículo direto continua bloqueado',
  $q$delete from vehicles where id = current_setting('test.sold_vehicle')::uuid$q$);
select pg_temp.eq('veículo vendido tem venda, parcelas e pagamentos antes',
  (select (select count(*) from sales where vehicle_id = v) > 0
      and (select count(*) from accounts_receivable where vehicle_id = v) > 0
      and (select count(*) from accounts_payable where vehicle_id = v) > 0
      and (select count(*) from financial_transactions where vehicle_id = v
             or payable_id in (select id from accounts_payable where vehicle_id = v)
             or receivable_id in (select id from accounts_receivable where vehicle_id = v)) > 0
   from (select current_setting('test.sold_vehicle')::uuid v) x), true);
select set_config('test.sold_opp', (select coalesce(opportunity_id::text, '') from vehicles where id = current_setting('test.sold_vehicle')::uuid), false) \g /dev/null
select set_config('test.vehicles_before', (select count(*)::text from vehicles), false) \g /dev/null
select set_config('test.customers_before', (select count(*)::text from customers), false) \g /dev/null
select pg_temp.eq('exclusão retorna lista de arquivos',
  jsonb_typeof(public.delete_vehicle(current_setting('test.sold_vehicle')::uuid) -> 'files'), 'array');
select pg_temp.eq('veículo excluído', (select count(*) from vehicles), current_setting('test.vehicles_before')::bigint - 1);
select pg_temp.eq('sem venda/parcelas/contas órfãs',
  (select count(*) from sales where vehicle_id = current_setting('test.sold_vehicle')::uuid)
  + (select count(*) from accounts_receivable where vehicle_id = current_setting('test.sold_vehicle')::uuid)
  + (select count(*) from accounts_payable where vehicle_id = current_setting('test.sold_vehicle')::uuid)
  + (select count(*) from financial_transactions where vehicle_id = current_setting('test.sold_vehicle')::uuid)
  + (select count(*) from vehicle_purchases where vehicle_id = current_setting('test.sold_vehicle')::uuid), 0::bigint);
select pg_temp.eq('análise de origem excluída junto',
  (select count(*) from auction_opportunities where id::text = current_setting('test.sold_opp')), 0::bigint);
select pg_temp.eq('clientes mantidos', (select count(*) from customers), current_setting('test.customers_before')::bigint);
select pg_temp.must_fail('travas voltam a valer depois da exclusão',
  $q$delete from vehicles where id = (select id from vehicles limit 1)$q$);

-- análise sem veículo
insert into auction_opportunities (make, model, year, lot_number) values ('Honda', 'Civic', 2019, 'TESTE-1');
select set_config('test.opp_only', (select id::text from auction_opportunities where lot_number = 'TESTE-1'), false) \g /dev/null
select public.delete_opportunity(current_setting('test.opp_only')::uuid) \g /dev/null
select pg_temp.eq('análise de leilão excluída',
  (select count(*) from auction_opportunities where id = current_setting('test.opp_only')::uuid), 0::bigint);

-- todos os veículos restantes podem ser excluídos
do $$ declare r record; begin
  for r in select id from vehicles loop perform public.delete_vehicle(r.id); end loop;
end $$;
select pg_temp.eq('todos os veículos de teste excluídos', (select count(*) from vehicles), 0::bigint);
select pg_temp.eq('nenhuma conta a pagar de veículo sobrando', (select count(*) from accounts_payable where vehicle_id is not null), 0::bigint);

-- ---------------------------------------------------------------------------
-- Clientes: cadastro completo, documentos e exclusão
-- ---------------------------------------------------------------------------
insert into customers (full_name, phone, email, address, address2, city, state, zip, document_id, license_state, license_expires, birth_date)
values ('Maria Teste', '4075550111', 'maria@test.com', '100 Main St', 'Apt 2', 'Orlando', 'FL', '32801', 'S123-456', 'FL', '2030-01-01', '1990-05-05');
reset role;
select set_config('test.cust', (select id::text from customers where full_name = 'Maria Teste'), false) \g /dev/null
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false) \g /dev/null
set role authenticated;
insert into attachments (entity_type, entity_id, kind, bucket, path, file_name)
values ('customer', current_setting('test.cust')::uuid, 'document', 'documents', 'x/customer/' || current_setting('test.cust') || '/cnh.jpg', 'cnh.jpg');
select pg_temp.eq('vendedor anexa e vê documento do cliente',
  (select count(*) from attachments where entity_type = 'customer'), 1::bigint);
select pg_temp.must_fail('vendedor não exclui cliente',
  $q$select public.delete_customer(current_setting('test.cust')::uuid)$q$);
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false) \g /dev/null
set role authenticated;
insert into accounts_receivable (customer_id, description, amount, due_date) values (current_setting('test.cust')::uuid, 'Teste', 100, current_date);
select pg_temp.must_fail('cliente com fatura não é excluído',
  $q$select public.delete_customer(current_setting('test.cust')::uuid)$q$);
reset role;
begin; select set_config('app.allow_purge', 'on', true) \g /dev/null
delete from accounts_receivable where description = 'Teste' and customer_id = current_setting('test.cust')::uuid;
commit;
set role authenticated;
select pg_temp.eq('cliente excluído devolve o arquivo',
  jsonb_array_length(public.delete_customer(current_setting('test.cust')::uuid) -> 'files'), 1);
select pg_temp.eq('cliente e documentos apagados',
  (select count(*) from customers where id = current_setting('test.cust')::uuid)
  + (select count(*) from attachments where entity_type = 'customer'), 0::bigint);

reset role;
\echo 'CARKING: todos os testes de regras de negócio passaram.'
