# CARKING

**AUCTION • VEHICLE RECONDITIONING • INVENTORY • SALES**

ERP para compra de veículos em leilões nos Estados Unidos, preparação e revenda com lucro.
O diferencial do CARKING é responder **antes do lance** se o carro vale a pena e, depois da compra,
acompanhar cada dólar investido contra o orçamento original.

> Logo: coloque o arquivo em `assets/brand/carking-logo.png` (veja [`assets/brand/README.md`](assets/brand/README.md)).

## O que já está pronto (V1 — banco de dados e regras de negócio)

A recomendação da especificação foi seguida: **primeiro a estrutura do banco e as funcionalidades
essenciais, depois as telas**. Tudo roda no Supabase (PostgreSQL) e está coberto por testes automatizados.

| Área | O que o backend já faz |
|---|---|
| **Auction Analyzer** | Cadastro de oportunidades, avaliação de danos por área, tabela de taxas por plataforma, validação obrigatória do título antes de aprovar/comprar |
| **Simulador de compra** | Investimento, lucro, margem, ROI, 3 cenários e **lance máximo** que respeita lucro mínimo, margem mínima e ROI mínimo com **taxas variáveis por faixa de lance** |
| **Compra** | `register_purchase()` cria veículo, aquisição, orçamento (cópia preservada da simulação), documentos obrigatórios e conta a pagar |
| **Inspeção** | Checklist padrão por área (motor, transmissão, frente, traseira, suspensão, freios, pneus, elétrica, interior, estrutura) |
| **Parts List** | Peças com OEM/part number, condição (nova, usada, recondicionada, aftermarket), 8 status, estimado × real, devoluções |
| **Labor & Repairs** | Ordens de reparo, serviços, lançamentos de mão de obra (horas × valor ou valor fechado) separados das peças |
| **Orçamento × real** | Por linha de custo: previsto, real, projetado, diferença em $ e %, alertas; a reserva de imprevistos é consumida pelos estouros |
| **Profit Analysis** | Lucro previsto/projetado/real, margem, ROI, preço mínimo sem prejuízo, preço recomendado, dias em preparação/anunciado, custo de estadia por dia |
| **Transporte, documentos, anúncios, propostas** | Status do veículo avança com o transporte; propostas mostram se atingem o lucro mínimo |
| **Vendas e financeiro** | Venda única por veículo, pagamentos parciais, contas a pagar geradas automaticamente pelos custos (sem duplicar), transferências, saldos, DRE mensal |
| **Segurança** | Multiempresa com RLS, 8 perfis com permissões por módulo (ver, criar, editar, aprovar, excluir), auditoria, histórico financeiro que não pode ser apagado |

Fora do escopo (por decisão de projeto): aluguel, reservas de locação, consignação, frota de terceiros,
motoristas, GPS, abastecimento e transporte de passageiros.

## App

**https://brayanreis32.github.io/Car-king/** — funciona no computador e no celular (adicione à tela de início).
Código em [`app/`](app/README.md), publicado automaticamente pelo GitHub Pages.

## Estrutura

```
app/               app web/celular (React + Vite + Supabase)
supabase/
  migrations/      9 migrações SQL (aplicar em ordem)
  tests/           testes de regras de negócio + script para rodar localmente
docs/
  ESPECIFICACAO.md especificação funcional completa do sistema
  ARQUITETURA.md   modelo de dados, fórmulas, RPCs e guia de integração com o FlutterFlow
assets/brand/      logo e identidade visual
```

## Como aplicar no Supabase

1. Crie um projeto em [supabase.com](https://supabase.com) (região US East combina com o fuso America/New_York).
2. Instale a [Supabase CLI](https://supabase.com/docs/guides/cli) e rode:
   ```bash
   supabase login
   supabase link --project-ref <seu-project-ref>
   supabase db push
   ```
   Alternativa sem CLI: cole cada arquivo de `supabase/migrations/` no **SQL Editor**, em ordem.
3. Crie o primeiro usuário em **Authentication → Users** e, logado no app com ele, chame
   `create_company('Car King Auto Sales', 'Seu Nome')` — ele vira Super Admin.

## Testes

```bash
./supabase/tests/run_local.sh
```

Sobe um PostgreSQL temporário, aplica as migrações e executa 90 verificações, incluindo o exemplo do
Toyota Camry 2021 da especificação (investimento $7.000, lucro $5.000, margem 41,67%, ROI 71,43%).
O mesmo teste roda no GitHub Actions a cada push.

## Roadmap

| Versão | Entrega |
|---|---|
| **V1 — Operacional** | Leilões, compras, veículos, inspeção, peças, reparos e custos — *backend pronto; próximo passo: telas no FlutterFlow* |
| **V2 — Comercial e financeiro** | Estoque, vendas, clientes, caixa, contas, relatórios PDF/Excel — *tabelas e regras já criadas* |
| **V3 — Inteligente** | IA para danos em fotos, análise de preço de mercado, leitura de VIN, OCR de recibos, automações |
