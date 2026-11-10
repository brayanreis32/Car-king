-- =============================================================================
-- CARKING — Atualização 16: excluir veículo / análise de leilão
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 16 · Excluir veículo / análise de leilão (testes e cadastros errados)
-- =============================================================================
-- * delete_vehicle(id): apaga o veículo e TUDO ligado a ele (compra, orçamento,
--   peças, mão de obra, despesas, reboque, documentos, fotos, venda, parcelas,
--   contas a pagar/receber e pagamentos) e a análise de leilão de origem.
-- * delete_opportunity(id): apaga uma análise de leilão (e o veículo, se houver).
-- * Só quem tem permissão de EXCLUIR (Desenvolvedor e Administrador).
-- * As travas de histórico continuam valendo para todo o resto: elas só são
--   liberadas dentro destas duas funções (app.allow_purge, válido na transação).
-- * Retorna os arquivos (bucket/path) para o app apagar do Storage.
-- * Clientes e fornecedores são mantidos. O registro da exclusão fica na auditoria.
-- =============================================================================

create or replace function app.purging()
returns boolean language sql stable as $$
  select coalesce(current_setting('app.allow_purge', true), '') = 'on'
$$;

create or replace function app.prevent_delete()
returns trigger language plpgsql as $$
begin
  if app.purging() and tg_table_name <> 'audit_logs' then return old; end if;
  raise exception 'Registros de % não podem ser excluídos; use o status de cancelamento para preservar o histórico.', tg_table_name
    using errcode = 'P0001';
end $$;

create or replace function app.prevent_delete_costed()
returns trigger language plpgsql as $$
begin
  if app.purging() then return old; end if;
  if (tg_table_name = 'parts' and old.status in ('purchased', 'awaiting_delivery', 'received', 'installed', 'returned'))
     or (tg_table_name = 'labor_entries' and old.status = 'confirmed')
     or (tg_table_name = 'expenses' and old.status = 'confirmed')
     or (tg_table_name = 'transport_orders' and old.actual_cost is not null)
     or (tg_table_name = 'part_orders' and old.status not in ('draft', 'cancelled')) then
    raise exception 'Este lançamento já gerou custo e não pode ser excluído. Altere o status para cancelado/devolvido.';
  end if;
  return old;
end $$;

create or replace function app.freeze_sold_vehicle_costs()
returns trigger language plpgsql as $$
declare v_vehicle uuid := coalesce(new.vehicle_id, old.vehicle_id);
begin
  if tg_op = 'DELETE' and app.purging() then return old; end if;
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

create or replace function app.transaction_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if app.purging() then return old; end if;
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

create or replace function app.simulation_before_delete()
returns trigger language plpgsql as $$
begin
  if old.locked and not app.purging() then
    raise exception 'Esta simulação foi usada na compra e não pode ser excluída.';
  end if;
  return old;
end $$;

create or replace function app.bank_line_guard()
returns trigger language plpgsql as $$
begin
  if old.status = 'matched' and not app.purging() and (new.status, new.amount, new.posted_date, new.financial_transaction_id)
       is distinct from (old.status, old.amount, old.posted_date, old.financial_transaction_id) then
    raise exception 'Lançamento já conciliado não pode ser alterado.';
  end if;
  if new.status <> old.status then
    new.resolved_by := auth.uid();
    new.resolved_at := case when new.status = 'pending' then null else now() end;
  end if;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Exclusão completa de um veículo
-- -----------------------------------------------------------------------------
create or replace function public.delete_vehicle(p_vehicle_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v      public.vehicles%rowtype;
  files  jsonb;
  sales_ids uuid[];
  pay_ids   uuid[];
  rec_ids   uuid[];
  tx_ids    uuid[];
begin
  if not app.has_permission('vehicles', 'delete') then
    raise exception 'Sem permissão para excluir veículos.';
  end if;
  select * into v from public.vehicles where id = p_vehicle_id and company_id = app.current_company_id();
  if not found then raise exception 'Veículo não encontrado.'; end if;

  perform set_config('app.allow_purge', 'on', true);

  -- arquivos para o app apagar do Storage
  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', f.bucket, 'path', f.path)), '[]'::jsonb) into files
  from (
    select a.bucket, a.path from public.attachments a
     where a.vehicle_id = v.id or (v.opportunity_id is not null and a.opportunity_id = v.opportunity_id)
    union all
    select d.storage_bucket, d.storage_path from public.documents d
     where (d.vehicle_id = v.id or (v.opportunity_id is not null and d.opportunity_id = v.opportunity_id))
       and d.storage_bucket is not null and d.storage_path is not null
  ) f;

  select array_agg(id) into sales_ids from public.sales where vehicle_id = v.id;
  select array_agg(id) into pay_ids from public.accounts_payable p
   where p.vehicle_id = v.id
      or p.source_id in (select id from public.vehicle_purchases where vehicle_id = v.id
                         union all select id from public.transport_orders where vehicle_id = v.id
                         union all select id from public.parts where vehicle_id = v.id
                         union all select id from public.part_orders where vehicle_id = v.id
                         union all select id from public.labor_entries where vehicle_id = v.id
                         union all select id from public.expenses where vehicle_id = v.id);
  select array_agg(id) into rec_ids from public.accounts_receivable r
   where r.vehicle_id = v.id or r.sale_id = any(coalesce(sales_ids, '{}'));
  select array_agg(id) into tx_ids from public.financial_transactions t
   where t.vehicle_id = v.id
      or t.payable_id = any(coalesce(pay_ids, '{}'))
      or t.receivable_id = any(coalesce(rec_ids, '{}'))
      or t.sale_payment_id in (select id from public.sale_payments where sale_id = any(coalesce(sales_ids, '{}')));

  -- dinheiro: linhas do extrato voltam a ficar pendentes
  update public.bank_statement_lines set financial_transaction_id = null, status = 'pending'
   where financial_transaction_id = any(coalesce(tx_ids, '{}'));
  delete from public.financial_transactions where id = any(coalesce(tx_ids, '{}'));
  delete from public.sale_payments where sale_id = any(coalesce(sales_ids, '{}'));
  delete from public.accounts_receivable where id = any(coalesce(rec_ids, '{}'));
  delete from public.accounts_payable where id = any(coalesce(pay_ids, '{}'));

  -- venda e anúncios
  delete from public.vehicle_offers where vehicle_id = v.id;
  delete from public.sales where vehicle_id = v.id;
  delete from public.listings where vehicle_id = v.id;

  -- arquivos e documentos
  delete from public.attachments where vehicle_id = v.id or (v.opportunity_id is not null and opportunity_id = v.opportunity_id);
  delete from public.documents where vehicle_id = v.id or (v.opportunity_id is not null and opportunity_id = v.opportunity_id);

  -- operação
  delete from public.transport_orders where vehicle_id = v.id;
  delete from public.labor_entries where vehicle_id = v.id;
  delete from public.parts where vehicle_id = v.id;
  delete from public.repair_items where vehicle_id = v.id;
  delete from public.repair_orders where vehicle_id = v.id;
  delete from public.part_orders where vehicle_id = v.id;
  delete from public.inspection_items where vehicle_id = v.id;
  delete from public.vehicle_inspections where vehicle_id = v.id;
  delete from public.expenses where vehicle_id = v.id;
  delete from public.vehicle_budgets where vehicle_id = v.id;
  delete from public.vehicle_purchases where vehicle_id = v.id;

  delete from public.vehicles where id = v.id;
  if v.opportunity_id is not null then
    delete from public.auction_opportunities where id = v.opportunity_id;
  end if;

  return jsonb_build_object('files', files);
end $$;

-- -----------------------------------------------------------------------------
-- Exclusão de uma análise de leilão (com o veículo, se já foi comprado)
-- -----------------------------------------------------------------------------
create or replace function public.delete_opportunity(p_opportunity_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_vehicle uuid;
  files jsonb;
begin
  if not app.has_permission('auction', 'delete') then
    raise exception 'Sem permissão para excluir análises de leilão.';
  end if;
  if not exists (select 1 from public.auction_opportunities
                  where id = p_opportunity_id and company_id = app.current_company_id()) then
    raise exception 'Análise não encontrada.';
  end if;

  select id into v_vehicle from public.vehicles where opportunity_id = p_opportunity_id;
  if v_vehicle is not null then
    return public.delete_vehicle(v_vehicle);
  end if;

  perform set_config('app.allow_purge', 'on', true);
  select coalesce(jsonb_agg(distinct jsonb_build_object('bucket', f.bucket, 'path', f.path)), '[]'::jsonb) into files
  from (
    select bucket, path from public.attachments where opportunity_id = p_opportunity_id
    union all
    select storage_bucket, storage_path from public.documents
     where opportunity_id = p_opportunity_id and storage_bucket is not null and storage_path is not null
  ) f;
  delete from public.attachments where opportunity_id = p_opportunity_id;
  delete from public.documents where opportunity_id = p_opportunity_id;
  delete from public.auction_opportunities where id = p_opportunity_id;
  return jsonb_build_object('files', files);
end $$;

grant execute on function public.delete_vehicle(uuid), public.delete_opportunity(uuid) to authenticated;
revoke execute on function public.delete_vehicle(uuid), public.delete_opportunity(uuid) from anon, public;
