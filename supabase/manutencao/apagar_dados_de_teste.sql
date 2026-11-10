-- =============================================================================
-- CARKING · Apagar dados de TESTE (começar do zero)
-- =============================================================================
-- APAGA: veículos, análises de leilão, simulações, lances, compras, peças,
--        mão de obra, despesas, reboques, documentos, fotos (registros),
--        vendas, parcelas, contas a pagar/receber, pagamentos, extrato
--        bancário importado, clientes e o histórico de auditoria.
--
-- MANTÉM: empresa, logins (você, administrador, vendedores), cargos e
--         permissões, metas e mensagem de cobrança (Configurações), leilões
--         e tabelas de taxas, fornecedores, categorias de despesa, contas
--         bancárias (com o saldo inicial).
--
-- ATENÇÃO: não tem como desfazer. Rode só enquanto o sistema tiver apenas testes.
-- =============================================================================

truncate table
  public.bank_statement_lines,
  public.financial_transactions,
  public.financial_transfers,
  public.sale_payments,
  public.accounts_receivable,
  public.accounts_payable,
  public.sales,
  public.vehicle_offers,
  public.listings,
  public.attachments,
  public.documents,
  public.transport_orders,
  public.labor_entries,
  public.repair_items,
  public.repair_orders,
  public.parts,
  public.part_orders,
  public.inspection_items,
  public.vehicle_inspections,
  public.expenses,
  public.vehicle_budgets,
  public.vehicle_purchases,
  public.vehicle_price_history,
  public.vehicle_status_history,
  public.vehicles,
  public.auction_bids,
  public.auction_simulations,
  public.vehicle_damage_assessments,
  public.auction_opportunities,
  public.customers,
  public.audit_logs;

-- Conferência: tudo deve mostrar 0
select 'veiculos' as tabela, count(*) from public.vehicles
union all select 'analises de leilao', count(*) from public.auction_opportunities
union all select 'vendas', count(*) from public.sales
union all select 'contas a pagar', count(*) from public.accounts_payable
union all select 'contas a receber', count(*) from public.accounts_receivable
union all select 'clientes', count(*) from public.customers;
