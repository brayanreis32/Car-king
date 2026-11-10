-- =============================================================================
-- CARKING — Atualização 13: extrato bancário (importação CSV/OFX e conciliação)
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 13 · Extrato bancário: importação (CSV/OFX) e conciliação
-- =============================================================================
-- Fluxo: o extrato baixado do banco é importado para bank_statement_lines
-- (sem duplicar). Cada lançamento pendente pode ser:
--   * conciliado com uma conta a pagar ou a receber em aberto (dá baixa);
--   * lançado como nova despesa (com ou sem veículo) e já pago;
--   * registrado como entrada avulsa;
--   * ignorado (ex.: transferência entre contas próprias).
-- Nenhuma integração bancária: os dados vêm do arquivo enviado pelo usuário.
-- =============================================================================

create table public.bank_statement_lines (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  account_id                uuid not null references public.financial_accounts(id) on delete restrict,
  posted_date               date not null,
  amount                    numeric(12,2) not null check (amount <> 0), -- negativo = saída, positivo = entrada
  description               text not null,
  reference                 text not null, -- FITID do OFX ou assinatura da linha do CSV
  status                    text not null default 'pending' check (status in ('pending', 'matched', 'ignored')),
  financial_transaction_id  uuid unique references public.financial_transactions(id) on delete restrict,
  import_file               text,
  imported_by               uuid default auth.uid(),
  resolved_by               uuid,
  resolved_at               timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (account_id, reference)
);
create index bank_statement_lines_pending_idx on public.bank_statement_lines(company_id, status, posted_date);

create trigger bank_statement_lines_set_updated_at before update on public.bank_statement_lines
  for each row execute function app.set_updated_at();
create trigger bank_statement_lines_audit after insert or update or delete on public.bank_statement_lines
  for each row execute function app.audit_row();

alter table public.bank_statement_lines enable row level security;
create policy bank_statement_lines_select on public.bank_statement_lines for select to authenticated
  using (company_id = app.current_company_id() and app.has_permission('finance', 'view'));
create policy bank_statement_lines_insert on public.bank_statement_lines for insert to authenticated
  with check (company_id = app.current_company_id() and app.has_permission('finance', 'create'));
create policy bank_statement_lines_update on public.bank_statement_lines for update to authenticated
  using (company_id = app.current_company_id() and app.has_permission('finance', 'edit'))
  with check (company_id = app.current_company_id());
create policy bank_statement_lines_delete on public.bank_statement_lines for delete to authenticated
  using (company_id = app.current_company_id() and app.has_permission('finance', 'delete') and status = 'pending');
grant select, insert, update, delete on public.bank_statement_lines to authenticated;

-- Lançamento conciliado não volta a ser alterado (só pendente <-> ignorado)
create or replace function app.bank_line_guard()
returns trigger language plpgsql as $$
begin
  if old.status = 'matched' and (new.status, new.amount, new.posted_date, new.financial_transaction_id)
       is distinct from (old.status, old.amount, old.posted_date, old.financial_transaction_id) then
    raise exception 'Lançamento já conciliado não pode ser alterado.';
  end if;
  if new.status <> old.status then
    new.resolved_by := auth.uid();
    new.resolved_at := case when new.status = 'pending' then null else now() end;
  end if;
  return new;
end $$;
create trigger bank_statement_lines_guard before update on public.bank_statement_lines
  for each row execute function app.bank_line_guard();

-- Lê um lançamento pendente da empresa (com bloqueio para evitar dupla conciliação)
create or replace function app.bank_pending_line(p_line_id uuid)
returns public.bank_statement_lines
language plpgsql
set search_path = public, pg_temp
as $$
declare l public.bank_statement_lines;
begin
  select * into l from public.bank_statement_lines where id = p_line_id for update;
  if not found then raise exception 'Lançamento do extrato não encontrado.'; end if;
  if l.status <> 'pending' then raise exception 'Este lançamento já foi resolvido.'; end if;
  return l;
end $$;

-- Saída do banco = pagamento de uma conta a pagar
create or replace function public.bank_match_payable(p_line_id uuid, p_payable_id uuid)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  l public.bank_statement_lines := app.bank_pending_line(p_line_id);
  v_tx uuid;
begin
  if l.amount >= 0 then raise exception 'Só saídas do banco podem pagar uma conta a pagar.'; end if;
  v_tx := public.pay_payable(p_payable_id, l.account_id, -l.amount, l.posted_date);
  update public.bank_statement_lines set status = 'matched', financial_transaction_id = v_tx where id = l.id;
  return v_tx;
end $$;

-- Entrada no banco = recebimento de uma conta a receber
create or replace function public.bank_match_receivable(p_line_id uuid, p_receivable_id uuid)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  l public.bank_statement_lines := app.bank_pending_line(p_line_id);
  ar public.accounts_receivable;
  v_tx uuid;
begin
  if l.amount <= 0 then raise exception 'Só entradas no banco podem quitar uma conta a receber.'; end if;
  select * into ar from public.accounts_receivable where id = p_receivable_id;
  if not found or ar.status not in ('open', 'partial') then raise exception 'Conta a receber não está em aberto.'; end if;
  if l.amount > ar.balance then raise exception 'O valor do extrato (%) passa do saldo em aberto (%).', l.amount, ar.balance; end if;
  insert into public.financial_transactions (company_id, account_id, direction, amount, transaction_date, description,
    vehicle_id, customer_id, receivable_id)
  values (l.company_id, l.account_id, 'in', l.amount, l.posted_date, ar.description, ar.vehicle_id, ar.customer_id, ar.id)
  returning id into v_tx;
  update public.bank_statement_lines set status = 'matched', financial_transaction_id = v_tx where id = l.id;
  return v_tx;
end $$;

-- Saída sem conta cadastrada = nova despesa (com ou sem veículo), já paga
create or replace function public.bank_create_expense(p_line_id uuid, p_category_id uuid, p_description text default null,
                                                      p_vehicle_id uuid default null, p_supplier_id uuid default null)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  l public.bank_statement_lines := app.bank_pending_line(p_line_id);
  v_expense uuid;
  v_payable uuid;
  v_tx uuid;
begin
  if l.amount >= 0 then raise exception 'Use "Registrar entrada" para entradas no banco.'; end if;
  insert into public.expenses (company_id, vehicle_id, category_id, supplier_id, description, expense_date, amount, status)
  values (l.company_id, p_vehicle_id, p_category_id, p_supplier_id, coalesce(nullif(trim(p_description), ''), l.description),
          l.posted_date, -l.amount, 'confirmed')
  returning id into v_expense;
  select id into v_payable from public.accounts_payable where source_type = 'expense' and source_id = v_expense;
  v_tx := public.pay_payable(v_payable, l.account_id, -l.amount, l.posted_date);
  update public.bank_statement_lines set status = 'matched', financial_transaction_id = v_tx where id = l.id;
  return v_tx;
end $$;

-- Entrada sem conta a receber (ex.: aporte, reembolso) = entrada avulsa
create or replace function public.bank_record_income(p_line_id uuid, p_description text default null)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  l public.bank_statement_lines := app.bank_pending_line(p_line_id);
  v_tx uuid;
begin
  if l.amount <= 0 then raise exception 'Use "Lançar despesa" para saídas do banco.'; end if;
  insert into public.financial_transactions (company_id, account_id, direction, amount, transaction_date, description)
  values (l.company_id, l.account_id, 'in', l.amount, l.posted_date, coalesce(nullif(trim(p_description), ''), l.description))
  returning id into v_tx;
  update public.bank_statement_lines set status = 'matched', financial_transaction_id = v_tx where id = l.id;
  return v_tx;
end $$;

-- Sugestões: contas em aberto com o mesmo valor, a mais próxima da data do extrato
create or replace view public.bank_line_suggestions as
select l.id as line_id, l.company_id, l.account_id, l.posted_date, l.amount, l.description, l.status,
       s.kind as match_kind, s.match_id, s.match_description, s.match_due_date, s.match_vehicle_id
from public.bank_statement_lines l
left join lateral (
  select * from (
    select 'payable'::text as kind, ap.id as match_id, ap.description as match_description,
           ap.due_date as match_due_date, ap.vehicle_id as match_vehicle_id
    from public.accounts_payable ap
    where l.amount < 0 and ap.company_id = l.company_id and ap.status in ('open', 'partial') and ap.balance = -l.amount
    union all
    select 'receivable', ar.id, ar.description, ar.due_date, ar.vehicle_id
    from public.accounts_receivable ar
    where l.amount > 0 and ar.company_id = l.company_id and ar.status in ('open', 'partial') and ar.balance = l.amount
  ) c
  order by abs(coalesce(c.match_due_date, l.posted_date) - l.posted_date)
  limit 1
) s on l.status = 'pending'
where l.company_id = app.current_company_id()
  and app.has_permission('finance', 'view');

grant select on public.bank_line_suggestions to authenticated;
grant execute on function public.bank_match_payable(uuid, uuid), public.bank_match_receivable(uuid, uuid),
  public.bank_create_expense(uuid, uuid, text, uuid, uuid), public.bank_record_income(uuid, text) to authenticated;
grant execute on function app.bank_pending_line(uuid), app.bank_line_guard() to authenticated;
revoke execute on function public.bank_match_payable(uuid, uuid), public.bank_match_receivable(uuid, uuid),
  public.bank_create_expense(uuid, uuid, text, uuid, uuid), public.bank_record_income(uuid, text) from anon, public;
