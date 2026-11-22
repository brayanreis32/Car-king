-- =============================================================================
-- CARKING — 27 · Valor do reboque entra no custo do carro
-- =============================================================================
-- * O reboque tem valor fixo: o valor informado já conta como gasto do carro
--   (não fica mais como "previsão" esperando o valor final).
-- * Cria a conta a pagar do reboque, para marcar como PAGO no próprio carro
--   (aba Reboque) ou no Financeiro.
-- * Reboques que já existem e estavam sem valor final são acertados
--   (menos os de carros já vendidos, que têm os custos encerrados).
-- =============================================================================

create or replace function app.transport_cost_default()
returns trigger language plpgsql as $$
begin
  if new.status <> 'cancelled' and coalesce(new.estimated_cost, 0) > 0 then
    if new.actual_cost is null then
      new.actual_cost := new.estimated_cost;
    elsif tg_op = 'UPDATE' and new.estimated_cost is distinct from old.estimated_cost
          and new.actual_cost is not distinct from old.actual_cost
          and old.actual_cost is not distinct from old.estimated_cost then
      -- valor era o mesmo do previsto: acompanha a mudança
      new.actual_cost := new.estimated_cost;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists transport_orders_cost_default on public.transport_orders;
create trigger transport_orders_cost_default before insert or update on public.transport_orders
  for each row execute function app.transport_cost_default();

-- Acerta os reboques já cadastrados (carros vendidos ficam como estão: custos encerrados)
update public.transport_orders t set actual_cost = t.estimated_cost
 where t.actual_cost is null and t.status <> 'cancelled' and t.estimated_cost > 0
   and not exists (select 1 from public.vehicles v where v.id = t.vehicle_id and v.status = 'sold');
