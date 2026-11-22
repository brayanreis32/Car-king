-- =============================================================================
-- CARKING — 26 · Dashboard com o resultado completo (gastos e lucro líquido)
-- =============================================================================
-- * Total gasto em todos os carros (vendidos e em estoque).
-- * Gastos deste mês (carros + despesas gerais da empresa).
-- * Despesas gerais (aluguel, gasolina, etc. — despesas sem carro).
-- * Lucro líquido = lucro dos carros vendidos − despesas gerais.
-- * Peças ainda "a comprar" (estimativa; só entram no custo quando compradas).
-- =============================================================================

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
  ,
  -- Resultado (adicionado na atualização 26)
  (select coalesce(sum(actual_cost), 0) from pa) as costs_all_vehicles,
  (select coalesce(sum(l.amount), 0) from public.vehicle_cost_ledger l
     where l.company_id = c.id and l.cost_date >= date_trunc('month', current_date)) as vehicle_costs_month,
  (select coalesce(sum(e.amount), 0) from public.expenses e where e.company_id = c.id and e.vehicle_id is null
     and e.status <> 'cancelled') as overhead_expenses,
  (select coalesce(sum(e.amount), 0) from public.expenses e where e.company_id = c.id and e.vehicle_id is null
     and e.status <> 'cancelled' and e.expense_date >= date_trunc('month', current_date)) as overhead_month,
  (select coalesce(sum(real_profit), 0) from pa where status = 'sold')
    - (select coalesce(sum(e.amount), 0) from public.expenses e where e.company_id = c.id and e.vehicle_id is null
         and e.status <> 'cancelled') as net_profit,
  (select coalesce(sum(p.quantity * p.estimated_unit_price), 0) from public.parts p join public.vehicles v on v.id = p.vehicle_id
     where p.company_id = c.id and v.status <> 'sold' and p.status in ('identified', 'awaiting_quote', 'to_buy')) as pending_parts_estimate
from c
where c.id is not null and app.has_permission('dashboard', 'view');
