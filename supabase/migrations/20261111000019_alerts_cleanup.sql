-- =============================================================================
-- CARKING — 19 · Alertas mais úteis
-- =============================================================================
-- * "Orçamento estourado" não alerta mais o lance e as taxas do leilão depois da
--   compra (já foram pagos; o impacto aparece no alerta de lucro abaixo da meta).
-- * Valores dos alertas formatados em dólar ($5,000 em vez de 5000.00).
-- =============================================================================

create or replace function app.usd(p numeric)
returns text language sql immutable as $$
  select case when p is null then '—'
              when p < 0 then '-$' || trim(to_char(abs(p), 'FM999,999,990'))
              else '$' || trim(to_char(p, 'FM999,999,990')) end
$$;

drop view if exists public.alerts;
create view public.alerts as
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
         'Gasto ' || app.usd(b.actual) || ' vs orçamento ' || app.usd(b.budget)
           || coalesce(' (' || case when b.difference_pct > 0 then '+' else '' end || round(b.difference_pct) || '%)', ''),
         null::date, b.difference
  from public.vehicle_budget_vs_actual b, c
  where b.company_id = c.id and b.alert_level <> 'ok'
    -- lance e taxas do leilão já estão pagos: o efeito aparece no alerta de lucro
    and b.line not in ('purchase', 'auction_fees')
    and exists (select 1 from public.vehicles v where v.id = b.vehicle_id and v.status <> 'sold')
  union all
  -- Lucro projetado abaixo da meta
  select pa.company_id, 'profit_below_target',
         case when pa.projected_profit < 0 then 'critical' else 'warning' end,
         pa.vehicle_id, 'vehicle', pa.vehicle_id, concat_ws(' ', pa.year, pa.make, pa.model),
         'Lucro projetado ' || app.usd(pa.projected_profit) || ' abaixo do mínimo de ' || app.usd(c.default_min_profit),
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
         case when ar.installment_number is not null and ar.installment_number > 0
              then case when ar.due_date < current_date then 'Parcela vencida' else 'Parcela vence em breve' end
              else 'Saldo a receber da venda' end, ar.due_date, ar.balance
  from public.accounts_receivable ar, c
  where ar.company_id = c.id and ar.sale_id is not null and ar.status in ('open', 'partial')
    -- parcelas futuras não geram alerta; só as próximas do vencimento ou vencidas
    and (ar.installment_number is null or ar.due_date <= current_date + c.payable_alert_days)
) a
where app.has_permission('dashboard', 'view');
grant select on public.alerts to authenticated;
