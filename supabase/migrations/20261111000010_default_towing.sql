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
