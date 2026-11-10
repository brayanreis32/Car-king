# CARKING — Arquitetura técnica e guia de integração

Stack: **FlutterFlow** (Web, iOS, Android) · **Supabase** (PostgreSQL, Auth, Storage) · moeda USD · fuso America/New_York · interface em português.

Toda regra financeira fica no banco (triggers, funções e views). O app **só lê views e chama RPCs**
para os cálculos, então os números são idênticos em qualquer tela, dispositivo ou relatório.

---

## 1. Regra de ouro: cada custo existe em um único lugar

| Custo real | Onde é lançado | Tela |
|---|---|---|
| Lance vencedor e taxas do leilão | `vehicle_purchases` | Compras |
| Transporte | `transport_orders.actual_cost` | Transporte |
| Peças (+ frete/impostos do pedido) | `parts`, `part_orders` | Parts List |
| Mão de obra e serviços | `labor_entries` | Labor & Repairs |
| Documentação, inspeção, estadia, detalhamento, marketing, outros, **despesas de venda** | `expenses` | Financeiro → Despesas |

- `expenses` **recusa** categorias de compra, taxas, transporte, peças e mão de obra, apontando o módulo certo.
- A view `vehicle_cost_ledger` une as fontes acima e é a única base dos cálculos.
- **Contas a pagar são geradas automaticamente** (uma por origem) e **transações financeiras registram
  apenas pagamentos**. Pagar uma conta nunca cria custo novo, e o custo não é duplicado.

## 2. Fórmulas

```
INVESTIMENTO = lance + taxas + transporte + documentação + peças + mão de obra
               + inspeção + outros + reserva de imprevistos
LUCRO        = preço de venda − investimento − despesas de venda
MARGEM %     = lucro ÷ preço de venda × 100
ROI %        = lucro ÷ investimento × 100
PREÇO MÍNIMO SEM PREJUÍZO = investimento projetado + despesas de venda
PREÇO RECOMENDADO = maior entre: preço esperado, ponto de equilíbrio + lucro mínimo,
                    ponto de equilíbrio ÷ (1 − margem mínima)
```

### Lance máximo (`calculate_max_bid`)

1. Calcula o investimento máximo permitido: o **menor** entre
   `venda − despesas de venda − lucro mínimo`, `venda − despesas de venda − venda × margem mínima` e
   `(venda − despesas de venda) ÷ (1 + ROI mínimo)`.
2. Subtrai os custos que não dependem do lance, sobrando o valor disponível para **lance + taxas**.
3. A taxa do leilão muda conforme a faixa do lance. Para cada faixa da tabela da plataforma a taxa é
   linear (`fixo + % × lance`), então o lance é resolvido exatamente em cada faixa e o maior válido é escolhido.
4. Arredonda para baixo no incremento de lance da plataforma (ex.: $25) e confere o resultado.

Exemplo dos testes: venda $12.000, outros custos $2.350, lucro mínimo $2.000, taxas $79 fixas mais
uma faixa de $200 + 6% acima de $5.000 → **lance máximo $6.950** (taxas $696, lucro $2.004).

### Projeção de custos (orçamento × real)

Para cada linha (`purchase`, `auction_fees`, `transport`, `parts`, `labor`, `documentation`, `inspection`,
`other`, `contingency`, `selling`):

- **Previsto**: valor do orçamento (cópia preservada da simulação aprovada).
- **Real**: soma do razão de custos.
- **Projetado**: real + o que ainda falta. Peças a comprar entram pelo valor estimado, serviços não
  concluídos pelo saldo estimado e transportes sem valor final pelo valor estimado. Linhas sem itens
  usam o maior entre previsto e real.
- A **reserva de imprevistos** é consumida pelos estouros das outras linhas.
- Alerta `warning` quando o real passa do previsto e `critical` quando passa do limite (padrão 10%).
- Depois da venda, projetado = real e os custos ficam congelados. Só despesas de venda continuam
  aceitas, como uma comissão paga depois.

## 3. Tabelas

| Módulo | Tabelas |
|---|---|
| Núcleo | `companies`, `branches`, `profiles`, `roles`, `permissions`, `audit_logs` |
| Auction Analyzer | `auction_sources`, `auction_fee_tiers`, `auction_opportunities`, `vehicle_damage_assessments`, `auction_simulations`, `auction_bids` |
| Veículos e compras | `vehicles`, `vehicle_status_history`, `vehicle_price_history`, `vehicle_purchases`, `vehicle_budgets` |
| Inspeção | `inspection_checklist_templates`, `vehicle_inspections`, `inspection_items` |
| Peças | `parts`, `part_orders` |
| Reparos | `repair_orders`, `repair_items`, `labor_entries` |
| Transporte e documentos | `transport_orders`, `documents`, `attachments` |
| Estoque e vendas | `listings`, `vehicle_offers`, `customers`, `sales`, `sale_payments` |
| Fornecedores | `suppliers` |
| Financeiro | `expense_categories`, `expenses`, `financial_accounts`, `accounts_payable`, `accounts_receivable`, `financial_transactions`, `financial_transfers` |

Convenções: UUID em todas as chaves; `numeric(12,2)` para dinheiro; `company_id` preenchido
automaticamente pelo usuário logado (o app **não precisa enviar**); `created_at`/`updated_at` automáticos.

## 4. RPCs (FlutterFlow → *Supabase Query* / *API Call* `rpc/<nome>`)

| Função | Para quê |
|---|---|
| `create_company(p_company_name, p_full_name, p_email)` | Primeiro acesso: cria a empresa e torna o usuário Super Admin |
| `add_employee(p_user_id, p_full_name, p_role_code, p_email, p_branch_id)` | Vincula um usuário do Auth a um perfil |
| `my_permissions()` | Lista módulo × ações do usuário (mostrar/ocultar menus) |
| `simulate_purchase(...)` | Calculadora ao vivo do Auction Analyzer (não grava) |
| `calculate_auction_fees(p_source_id, p_bid)` | Taxas para um valor de lance |
| `calculate_max_bid(p_source_id, p_sale_price, p_other_costs, ...)` | Lance máximo e a regra que o limitou |
| `register_purchase(p_opportunity_id, p_final_bid, p_buyer_fee, ...)` | Arremate: cria veículo, aquisição, orçamento, documentos e conta a pagar |
| `register_direct_purchase(p_vin, p_make, ...)` | Compra fora do Auction Analyzer |
| `start_inspection(p_vehicle_id, p_inspection_type)` | Cria ficha de inspeção com checklist |
| `register_sale(p_vehicle_id, p_customer_id, p_final_price, ...)` | Venda com entrada opcional |
| `pay_payable(p_payable_id, p_account_id, p_amount, p_date, p_proof_path)` | Baixa (total/parcial) de conta a pagar |

> Um veículo **só** pode ser criado por `register_purchase` ou `register_direct_purchase`. O banco
> exige a aquisição na mesma transação.

## 5. Views (fonte das telas)

| Tela | View |
|---|---|
| Auction Analyzer (lista) | `auction_opportunity_overview` |
| Simulação salva | `auction_simulations` (resultados calculados automaticamente ao salvar) |
| Ficha do veículo → Custos | `vehicle_cost_ledger`, `vehicle_cost_summary` |
| Controle de orçamento | `vehicle_budget_vs_actual` |
| Profit Analysis | `vehicle_profit_analysis` |
| Parts List (cabeçalho) | `vehicle_parts_summary` |
| Labor & Repairs | `repair_items_overview` |
| Inspeção | `inspection_items_overview` |
| Propostas | `vehicle_offers_analysis` |
| Alertas | `alerts` |
| Dashboard | `dashboard_kpis`, `monthly_results`, `monthly_costs_by_group` |
| Financeiro | `financial_account_balances`, `accounts_payable`, `accounts_receivable` |

As views analíticas rodam com o dono do banco e filtram pela empresa e permissão do usuário. Assim um
vendedor vê o lucro de uma proposta calculado com **todos** os custos, mesmo sem acesso às tabelas de compra.

## 6. Status (valor no banco → rótulo na tela)

**Oportunidade:** `analyzing` Em análise · `awaiting_inspection` Aguardando inspeção · `awaiting_quote` Aguardando orçamento ·
`approved` Aprovado para compra · `bid_placed` Lance realizado · `won` Arrematado · `lost` Não arrematado · `discarded` Descartado

**Veículo:** `purchased` Comprado · `awaiting_pickup` Aguardando retirada · `in_transit` Em transporte · `received` Recebido ·
`in_inspection` Em inspeção · `in_preparation` Em preparação · `awaiting_parts` Aguardando peças · `in_repair` Em reparo ·
`in_detailing` Em detalhamento · `ready_for_sale` Pronto para venda · `listed` Anunciado · `reserved` Reservado para venda · `sold` Vendido

**Peça:** `identified` Identificada · `awaiting_quote` Aguardando orçamento · `to_buy` A comprar · `purchased` Comprada ·
`awaiting_delivery` Aguardando entrega · `received` Recebida · `installed` Instalada · `returned` Devolvida

**Reparo:** `pending` Pendente · `quote_requested` Orçamento solicitado · `approved` Aprovado · `in_progress` Em andamento ·
`awaiting_parts` Aguardando peças · `completed` Concluído · `cancelled` Cancelado

**Condição do item:** `good` Bom · `damaged` Danificado · `needs_repair` Precisa reparar · `needs_replacement` Precisa substituir · `needs_diagnosis` Precisa de diagnóstico

**Título:** `clean`, `salvage`, `rebuilt`, `flood`, `certificate_of_destruction`, `parts_only`, `bill_of_sale_only`, `lemon_buyback`, `other`, `unknown`.
O sistema **não presume** que títulos diferentes têm as mesmas regras de circulação ou revenda: a
oportunidade só pode ser aprovada ou comprada depois que alguém marca `title_verified`.

Automatismos: transporte `booked` → veículo *Aguardando retirada*; `picked_up`/`in_transit` → *Em transporte*;
`delivered` → *Recebido*; `start_inspection` → *Em inspeção*; venda concluída → *Vendido*.

## 7. Perfis e permissões padrão

| Perfil | Principais acessos |
|---|---|
| Super Admin / Administrador | Tudo (excluir inclusive) |
| Gerente | Opera e aprova todos os módulos operacionais; consulta financeiro e relatórios |
| Financeiro | Financeiro, compras, vendas, documentos, clientes e fornecedores; consulta o resto |
| Comprador de leilão | Auction Analyzer completo, compras, transporte, documentos, veículos |
| Vendedor | Estoque/anúncios, propostas, vendas, clientes |
| Mecânico | Inspeção, peças e reparos; atualiza status do veículo |
| Atendente | Clientes; consulta estoque e vendas |

A matriz fica na tabela `permissions` e é editável por empresa. Ações: ver, criar, editar, aprovar, excluir.

## 8. Proteções implementadas

1. VIN único por empresa, normalizado e validado (sem I, O e Q).
2. Todo veículo tem aquisição registrada.
3. Despesa sempre vinculada a categoria, e opcionalmente a veículo e fornecedor.
4. Previsto (orçamento/simulação) separado do real (razão de custos).
5. Custos não duplicados (seção 1).
6. Toda compra gera conta a pagar e histórico.
7. Peça comprada exige preço real e atualiza custos e contas a pagar.
8. Mão de obra lançada atualiza custos e a projeção.
9. Venda atualiza estoque, anúncios e contas a receber.
10. Uma venda ativa por veículo.
11. Transações confirmadas não podem ser apagadas nem editadas, só estornadas com motivo.
12. Auditoria (quem, quando, antes/depois) nas tabelas importantes.
13. RLS: isolamento total entre empresas e permissão por módulo.
14. Veículos, compras, vendas, pagamentos e histórico nunca são apagados. Custos lançados só podem ser cancelados.
15. Lucro e margem recalculados automaticamente a cada lançamento (views).

## 9. Storage

Buckets privados: `vehicle-media` (fotos/vídeos, até 50 MB) e `documents` (PDF/imagens, até 25 MB).
Caminho obrigatório: `{company_id}/{entity_type}/{entity_id}/{arquivo}`. Depois do upload, registre o
arquivo em `attachments`, ou em `documents.storage_path` no caso de documentos. Fotos antes/depois usam `attachments.stage`.

## 10. Conectando o FlutterFlow

1. **Settings → Integrations → Supabase**: informe a URL e a *anon key* do projeto e clique em *Get Schema*.
2. **Authentication**: habilite Supabase Auth (e-mail/senha). Na primeira entrada, se `profiles` não
   tiver o usuário, mostre a tela "Criar empresa", que chama `create_company`.
3. Use as **views** da seção 5 como fonte das listas e painéis e as **tabelas** nos formulários de cadastro.
4. Cálculos em tempo real (simulador): chame `simulate_purchase` a cada alteração de campo.
5. Ações críticas (arrematar, iniciar inspeção, vender, pagar) chamam as **RPCs** da seção 4, nunca inserts diretos.
6. Uploads: *Upload Media to Supabase* com o caminho da seção 9 e, em seguida, insert em `attachments`.
7. Menus: carregue `my_permissions()` no login e esconda módulos sem `can_view`.

## 11. Preparado para o futuro (V3)

- `auction_sources` e `auction_fee_tiers` aceitam importação automática de leilões e tabelas de taxas.
- `attachments` centraliza fotos para IA de danos. As sugestões entram como `inspection_items`/`parts` com status *Identificada* e precisam de confirmação humana.
- `parts.oem_number`/`part_number` e `suppliers` permitem integrar catálogos de peças.
- `vehicles` (ano, modelo, versão, quilometragem e título) e `sales` formam a base histórica para análise de preço de mercado.
- OCR de recibos pode preencher `expenses`/`parts.actual_unit_price` a partir de `attachments.kind = 'receipt'`.
