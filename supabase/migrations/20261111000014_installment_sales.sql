-- =============================================================================
-- CARKING — 14 · Venda parcelada (financiamento próprio)
-- =============================================================================
-- * Venda com entrada + N parcelas (mensal, quinzenal ou semanal), com juros
--   opcionais (taxa anual, tabela Price). Cada parcela vira uma conta a receber.
-- * O lucro do carro continua calculado sobre o preço de venda; os juros são
--   receita financeira extra (aparecem nas contas a receber/recebidas).
-- * Vendas à vista continuam como antes (uma conta a receber).
-- =============================================================================

alter table public.sales drop constraint if exists sales_payment_method_check;
alter table public.sales add constraint sales_payment_method_check
  check (payment_method in ('cash', 'check', 'wire', 'zelle', 'card', 'financing', 'installments', 'mixed', 'other'));

alter table public.sales
  add column installment_frequency text not null default 'monthly' check (installment_frequency in ('monthly', 'biweekly', 'weekly')),
  add column interest_rate_apr numeric(7,4) not null default 0 check (interest_rate_apr >= 0 and interest_rate_apr < 100),
  add column financed_amount numeric(12,2),
  add column installment_amount numeric(12,2),
  add column total_with_interest numeric(12,2);

alter table public.accounts_receivable add column installment_number integer check (installment_number >= 0);
drop index if exists public.accounts_receivable_sale_uq;
create unique index accounts_receivable_sale_installment_uq
  on public.accounts_receivable(sale_id, coalesce(installment_number, -1)) where sale_id is not null;

-- Calcula o plano de parcelas (tabela Price quando há juros)
create or replace function public.installment_plan(
  p_financed numeric, p_installments integer, p_apr numeric default 0, p_frequency text default 'monthly')
returns table (installment_amount numeric, total_with_interest numeric, last_installment numeric)
language plpgsql immutable
as $$
declare
  v_per_year integer := case p_frequency when 'weekly' then 52 when 'biweekly' then 26 else 12 end;
  v_rate numeric := coalesce(p_apr, 0) / 100 / v_per_year;
  v_pmt numeric;
begin
  if p_installments is null or p_installments < 1 then raise exception 'Número de parcelas inválido.'; end if;
  if v_rate = 0 then
    v_pmt := round(p_financed / p_installments, 2);
    installment_amount := v_pmt;
    total_with_interest := round(p_financed, 2);
  else
    v_pmt := round(p_financed * v_rate / (1 - power(1 + v_rate, -p_installments)), 2);
    installment_amount := v_pmt;
    total_with_interest := round(v_pmt * p_installments, 2);
  end if;
  last_installment := round(total_with_interest - v_pmt * (p_installments - 1), 2);
  return next;
end $$;

create or replace function app.sale_before_write()
returns trigger language plpgsql as $$
declare p record;
begin
  if tg_op = 'UPDATE' and old.status = 'cancelled' and new.status <> 'cancelled' then
    raise exception 'Venda cancelada não pode ser reativada; registre uma nova venda.';
  end if;
  if tg_op = 'UPDATE' and old.status = 'completed' and new.status = 'completed'
     and (new.final_price, new.vehicle_id, new.installments, new.down_payment, new.interest_rate_apr)
         is distinct from (old.final_price, old.vehicle_id, old.installments, old.down_payment, old.interest_rate_apr)
     and exists (select 1 from public.sale_payments where sale_id = new.id and status = 'confirmed') then
    raise exception 'Condições de uma venda com pagamentos não podem ser alteradas.';
  end if;
  if new.installments > 1 then
    if new.installments > 120 then raise exception 'Máximo de 120 parcelas.'; end if;
    new.financed_amount := new.final_price - new.down_payment;
    if new.financed_amount <= 0 then raise exception 'Com entrada igual ao preço não há parcelas.'; end if;
    select * into p from public.installment_plan(new.financed_amount, new.installments, new.interest_rate_apr, new.installment_frequency);
    new.installment_amount := p.installment_amount;
    new.total_with_interest := p.total_with_interest + new.down_payment;
    new.first_due_date := coalesce(new.first_due_date,
      case new.installment_frequency when 'weekly' then new.sale_date + 7 when 'biweekly' then new.sale_date + 14
           else (new.sale_date + interval '1 month')::date end);
  else
    new.financed_amount := null; new.installment_amount := null; new.total_with_interest := new.final_price;
  end if;
  return new;
end $$;

-- Venda concluída => veículo vendido + contas a receber (à vista: 1; parcelada: entrada + parcelas)
create or replace function app.sale_after_write()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_label text;
  v_recv uuid;
  p record;
  k integer;
  v_due date;
begin
  select concat_ws(' ', year, make, model) into v_label from public.vehicles where id = new.vehicle_id;

  if new.status = 'completed' then
    update public.vehicles set status = 'sold', sold_at = coalesce(sold_at, new.sale_date::timestamptz)
    where id = new.vehicle_id;

    if tg_op = 'INSERT' or old.status <> 'completed' then
      if new.installments <= 1 then
        insert into public.accounts_receivable (company_id, customer_id, vehicle_id, sale_id, description, amount, due_date)
        values (new.company_id, new.customer_id, new.vehicle_id, new.id, 'Venda — ' || coalesce(v_label, ''),
                new.final_price, coalesce(new.first_due_date, new.sale_date))
        returning id into v_recv;
        perform app.refresh_receivable(v_recv);
      else
        select * into p from public.installment_plan(new.financed_amount, new.installments, new.interest_rate_apr, new.installment_frequency);
        if new.down_payment > 0 then
          insert into public.accounts_receivable (company_id, customer_id, vehicle_id, sale_id, installment_number, description, amount, due_date)
          values (new.company_id, new.customer_id, new.vehicle_id, new.id, 0, 'Entrada — ' || coalesce(v_label, ''), new.down_payment, new.sale_date);
        end if;
        for k in 1 .. new.installments loop
          v_due := case new.installment_frequency
                     when 'weekly' then new.first_due_date + 7 * (k - 1)
                     when 'biweekly' then new.first_due_date + 14 * (k - 1)
                     else (new.first_due_date + make_interval(months => k - 1))::date end;
          insert into public.accounts_receivable (company_id, customer_id, vehicle_id, sale_id, installment_number, description, amount, due_date)
          values (new.company_id, new.customer_id, new.vehicle_id, new.id, k,
                  format('Parcela %s/%s — %s', k, new.installments, coalesce(v_label, '')),
                  case when k = new.installments then p.last_installment else p.installment_amount end, v_due);
        end loop;
      end if;
    end if;

    update public.vehicle_offers set status = 'accepted'
    where vehicle_id = new.vehicle_id and customer_id = new.customer_id and status in ('open', 'countered');

  elsif new.status = 'cancelled' and tg_op = 'UPDATE' and old.status <> 'cancelled' then
    if exists (select 1 from public.sale_payments where sale_id = new.id and status = 'confirmed')
       or exists (select 1 from public.financial_transactions t join public.accounts_receivable ar on ar.id = t.receivable_id
                  where ar.sale_id = new.id and t.status = 'confirmed') then
      raise exception 'A venda possui pagamentos confirmados. Estorne os pagamentos antes de cancelar a venda.';
    end if;
    if coalesce(trim(new.cancel_reason), '') = '' then
      raise exception 'Informe o motivo do cancelamento da venda.';
    end if;
    update public.accounts_receivable set status = 'cancelled' where sale_id = new.id;
    update public.vehicles set status = 'ready_for_sale', sold_at = null where id = new.vehicle_id;
  end if;
  return new;
end $$;

-- Pagamento de venda => quita primeiro a entrada (ou a conta única), depois as parcelas em ordem
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
  select id into v_recv from public.accounts_receivable
  where sale_id = new.sale_id and status in ('open', 'partial')
  order by coalesce(installment_number, -1), due_date limit 1;

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

-- register_sale com parcelamento
drop function if exists public.register_sale(uuid, uuid, numeric, date, text, numeric, numeric, numeric, uuid, integer, date, text);
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
  p_notes                    text    default null,
  p_installment_frequency    text    default 'monthly',
  p_interest_rate_apr        numeric default 0
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
    discount, final_price, payment_method, down_payment, installments, first_due_date, status, notes,
    installment_frequency, interest_rate_apr)
  values (v.company_id, v.id, p_customer_id, auth.uid(), p_sale_date, v.listed_price, p_offer_amount,
    coalesce(p_discount, 0), p_final_price,
    case when coalesce(p_installments, 1) > 1 then 'installments' else p_payment_method end,
    coalesce(p_down_payment, 0), coalesce(p_installments, 1), p_first_due_date, 'completed', p_notes,
    coalesce(p_installment_frequency, 'monthly'), coalesce(p_interest_rate_apr, 0))
  returning id into v_sale;

  if coalesce(p_down_payment, 0) > 0 then
    insert into public.sale_payments (company_id, sale_id, financial_account_id, paid_at, amount, method)
    values (v.company_id, v_sale, p_down_payment_account_id, p_sale_date, p_down_payment, p_payment_method);
  end if;

  update public.listings set status = 'ended', ended_at = p_sale_date
  where vehicle_id = v.id and status in ('draft', 'active', 'paused');
  return v_sale;
end $$;

grant execute on function public.register_sale(uuid, uuid, numeric, date, text, numeric, numeric, numeric, uuid, integer, date, text, text, numeric) to authenticated;
grant execute on function public.installment_plan(numeric, integer, numeric, text) to authenticated;
revoke execute on function public.register_sale(uuid, uuid, numeric, date, text, numeric, numeric, numeric, uuid, integer, date, text, text, numeric) from anon, public;

-- Alertas: parcelas só aparecem perto do vencimento
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
