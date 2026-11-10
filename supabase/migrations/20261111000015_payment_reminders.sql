-- =============================================================================
-- CARKING — 15 · Lembretes de cobrança pelo WhatsApp (envio em 1 clique)
-- =============================================================================
-- * companies.reminder_template: mensagem editável em Configurações.
--   Variáveis: {cliente} {carro} {parcela} {valor} {vencimento} {dias_atraso} {empresa}
-- * accounts_receivable.last_reminder_at / reminder_count: quem já foi lembrado.
-- * Nenhuma integração paga: o app abre o WhatsApp com a mensagem pronta.
-- =============================================================================

alter table public.companies
  add column reminder_template text not null default
    'Hi {cliente}, this is {empresa}. Friendly reminder: payment {parcela} for your {carro}, amount {valor}, was due on {vencimento}. Please let us know when you can make the payment. Thank you!';

alter table public.accounts_receivable
  add column last_reminder_at timestamptz,
  add column reminder_count integer not null default 0;

-- Registra o lembrete (quem tem acesso a vendas ou ao financeiro)
create or replace function public.log_payment_reminder(p_receivable_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not (app.has_permission('finance', 'view') or app.has_permission('sales', 'view')) then
    raise exception 'Sem permissão.';
  end if;
  update public.accounts_receivable
     set last_reminder_at = now(), reminder_count = reminder_count + 1
   where id = p_receivable_id and company_id = app.current_company_id();
end $$;

grant execute on function public.log_payment_reminder(uuid) to authenticated;
revoke execute on function public.log_payment_reminder(uuid) from anon, public;
