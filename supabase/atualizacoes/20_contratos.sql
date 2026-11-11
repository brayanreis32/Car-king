-- =============================================================================
-- CARKING — Atualização 20: contratos de venda (à vista e parcelada)
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 20 · Contratos de venda (à vista e parcelada)
-- =============================================================================
-- * companies: dados usados no contrato (licença de financiamento, multa por
--   atraso e dias de carência, cláusulas extras). Editáveis em Configurações.
-- * Multa por atraso padrão: 5% da parcela, após 15 dias de atraso
--   (MA G.L. c.255B §11 limita a cobrança a parcelas em atraso há 15+ dias).
-- * O contrato assinado é anexado à venda (attachments, entity_type 'sale').
-- =============================================================================

alter table public.companies
  add column if not exists finance_license      text,
  add column if not exists late_fee_pct         numeric(5,2) not null default 5 check (late_fee_pct >= 0 and late_fee_pct <= 25),
  add column if not exists late_fee_grace_days  integer      not null default 15 check (late_fee_grace_days between 0 and 60),
  add column if not exists contract_terms       text;

-- Momento em que o contrato assinado foi anexado (para saber o que falta assinar)
alter table public.sales
  add column if not exists contract_signed_at timestamptz;

create or replace function app.sale_contract_signed()
returns trigger language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if new.entity_type = 'sale' and new.kind = 'document' then
    update public.sales set contract_signed_at = coalesce(contract_signed_at, now())
     where id = new.entity_id and company_id = new.company_id;
  end if;
  return new;
end $$;

drop trigger if exists attachments_sale_contract_signed on public.attachments;
create trigger attachments_sale_contract_signed after insert on public.attachments
  for each row execute function app.sale_contract_signed();
