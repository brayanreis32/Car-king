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
