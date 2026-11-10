# CARKING — Especificação do sistema

**AUCTION • VEHICLE RECONDITIONING • INVENTORY • SALES**
Auction Management · Repair Tracking · Profit Analysis

## Objetivo

ERP profissional para uma empresa que compra veículos em leilões nos Estados Unidos, avalia as condições,
calcula investimentos, faz reparos, controla o estoque e revende com lucro. O sistema acompanha todo o ciclo
de vida do veículo, da análise antes do leilão até a conclusão da venda, e funciona com dados reais e persistentes.

O proprietário deve saber exatamente quanto custa cada veículo, quanto ainda precisa investir, qual o valor de
mercado, por quanto poderá vender e qual será a margem de lucro.

**Diferencial:** controlar a rentabilidade **antes e depois** da compra. Antes do lance, dizer se o carro tem
potencial de lucro. Depois da compra, acompanhar cada dólar investido.

### Perguntas que o CARKING responde antes da compra

Quanto posso pagar no leilão? Quanto serão as taxas? Quanto custa o transporte? Quais peças serão necessárias?
Quanto custa a mão de obra? Quanto gasto para deixar o veículo pronto? Por quanto posso vender? Qual o lucro?
Qual a margem? **Vale a pena comprar?**

## Configuração técnica

| Item | Definição |
|---|---|
| Tipo | ERP automotivo |
| Frontend | FlutterFlow (Web, iOS e Android) |
| Backend | Supabase: PostgreSQL, Supabase Auth e Supabase Storage |
| Moeda / fuso / idioma | USD · America/New_York · Português |
| Estrutura | Uma empresa, com suporte futuro para filiais |
| Usuários | Múltiplos funcionários com permissões individuais |

## Fluxo em sete etapas

1. **Pesquisa e análise do leilão**: cadastrar o carro, fotos, danos, documentação e valor de mercado.
2. **Simulação de compra**: taxas, transporte, reparos e preço máximo recomendado para o lance.
3. **Compra**: lance vencedor, taxas efetivas, pagamento e aquisição.
4. **Inspeção e diagnóstico**: peças necessárias, defeitos, serviços e reparos.
5. **Preparação**: compras de peças, oficinas, mão de obra, gastos previstos e reais.
6. **Estoque e comercialização**: anúncio, preço de venda e negociações.
7. **Venda e resultado**: investimento final, lucro, margem e ROI.

## Menu principal

Dashboard · Auction Analyzer · Veículos · Compras · Inspeção e diagnóstico · Lista de peças ·
Orçamentos e reparos · Transporte · Estoque · Vendas · Clientes · Fornecedores · Financeiro ·
Documentação · Relatórios · Funcionários · Configurações.

---

## 1. Auction Analyzer

Cadastro de veículos encontrados em leilões **antes da compra** (várias oportunidades ao mesmo tempo).

**Campos:** plataforma, nome do leilão, número do lote, VIN, marca, modelo, ano, versão, quilometragem, cor,
combustível, transmissão, localização, data do leilão, tipo de título, dano principal, dano secundário,
condição de funcionamento, chaves disponíveis, fotos, link do anúncio.

**Status:** Em análise · Aguardando inspeção · Aguardando orçamento · Aprovado para compra · Lance realizado ·
Arrematado · Não arrematado · Descartado.

**Avaliação de compra:** preço de revenda em condições normais, valor esperado após reparos, custo estimado
de preparação, despesas previstas, margem desejada, reserva para imprevistos e preço máximo recomendado para o lance.

## 2. Análise de danos

Áreas: frente, traseira, laterais esquerda e direita, motor, transmissão, suspensão, estrutura e chassi,
airbags, elétrica, interior, rodas, pneus e vidros.

Cada área tem condição (Bom · Danificado · Precisa reparar · Precisa substituir · Precisa de diagnóstico),
descrição, fotos, gravidade, reparos necessários e custo estimado.

## 3. Simulador de compra e lance máximo

**Entradas:** valor estimado de venda, lucro desejado, margem desejada, lance previsto, taxas do leilão,
transporte, documentação, peças, mão de obra, inspeções, reserva de imprevistos e outros custos.

**Saídas:** investimento estimado, lucro, margem, ROI, preço máximo recomendado para o lance e cenários
conservador, esperado e otimista.

| Indicador | Fórmula |
|---|---|
| Lucro | receita − todos os custos |
| Margem | lucro ÷ preço de venda |
| ROI | lucro ÷ investimento total |

**Regra:** o lance máximo considera as taxas que dependem do valor do lance (tabelas de taxas configuráveis
por plataforma), as despesas variáveis e a reserva para imprevistos. Não pode simplesmente subtrair um valor
fixo quando a comissão do leilão muda conforme o preço.

### Exemplo ilustrativo: Toyota Camry 2021

| Item | Valor |
|---|---|
| Lance de compra | $4,000 |
| Taxas do leilão | $650 |
| Transporte | $350 |
| Peças | $1,000 |
| Mão de obra | $500 |
| Documentação | $200 |
| Reserva de imprevistos | $300 |
| **Investimento total** | **$7,000** |
| Receita esperada | $12,000 |
| **Lucro projetado** | **$5,000** |
| Margem sobre venda | 41.67% |
| ROI | 71.43% |

Cenários: conservador $10,500 → lucro $3,500 · esperado $12,000 → $5,000 · otimista $13,000 → $6,000.

## 4. Compras

Ao arrematar: valor final do lance, data, leilão, taxas reais, pagamento, transporte, documentação e
comprovantes. O sistema gera o cadastro definitivo do veículo e o histórico financeiro, atualiza o estoque e
**preserva a simulação original** para comparar previsto e pago.

## 5. Inspeção e diagnóstico

Ficha completa na chegada: defeitos, peças danificadas e ausentes, reparos, problemas mecânicos, elétricos,
estruturais e internos, fotos, vídeos, observações, responsável e checklist de aprovação.

| Área | Itens |
|---|---|
| Motor | Vazamentos, ruídos, funcionamento |
| Transmissão | Câmbio, vazamentos, funcionamento |
| Frente | Para-choque, capô, faróis, radiador |
| Traseira | Tampa, lanternas, para-choque |
| Suspensão | Amortecedores, braços, terminais |
| Freios | Discos, pastilhas, pinças |
| Pneus | Estado, medidas e quantidade |
| Elétrica | Bateria, sensores e módulos |
| Interior | Bancos, painel, airbags |
| Estrutura | Chassi, longarinas e alinhamento |

Cada item tem condição, descrição, foto, prioridade, peça necessária, valor estimado, valor real e status do reparo.

## 6. Parts List

Por peça: nome, categoria, código OEM, part number, código interno, quantidade, condição (nova, usada,
recondicionada, aftermarket), fornecedor, link, preço estimado, preço real, data de compra, previsão de
entrega, data de recebimento, status, recibo, foto e veículo.

**Status:** Identificada · Aguardando orçamento · A comprar · Comprada · Aguardando entrega · Recebida ·
Instalada · Devolvida.

## 7. Labor & Repairs

Por serviço: veículo, área, problema, serviço, mecânico/oficina, responsável, início, prazo, conclusão,
peças relacionadas, horas, valor previsto, valor real, fotos antes e depois, recibos e status.

**Status:** Pendente · Orçamento solicitado · Aprovado · Em andamento · Aguardando peças · Concluído · Cancelado.

O custo de peças fica **separado** do custo de mão de obra.

## 8. Orçamento previsto × real

Compara compra, taxas, transporte, peças, mão de obra, documentação e outros custos, em dólares e em
porcentagem. Exemplo: orçamento de peças $1,000, gasto real $1,400, diferença +$400 (40% acima). Emite alerta
quando o limite é ultrapassado e recalcula o lucro projetado a cada nova despesa.

## 9. Profit Analysis

Investimento previsto e real, receita esperada e real, lucro previsto e real, margem prevista e real, ROI,
preço mínimo sem prejuízo, preço recomendado, cenários, dias desde a compra, em preparação e anunciado,
custo de estoque por dia e tempo total da operação.

```
CUSTO TOTAL = lance + taxas + transporte + documentação + peças + mão de obra + reparos + demais despesas
LUCRO       = venda − custo total − despesas de venda
MARGEM      = lucro ÷ venda × 100
ROI         = lucro ÷ investimento total × 100
```

## 10. Documentação

Bill of Sale, Title, Salvage Title, Rebuilt Title, documentos de leilão, recibos, notas, documentos de
transporte, inspeções, histórico de transferência e outros. Cada documento tem tipo, veículo, data,
referência, arquivo, status e observação. O sistema alerta sobre pendências e vencimentos.

**O status do título deve ser validado antes da compra.** O sistema não assume que todos os tipos de título
têm as mesmas condições legais de circulação ou revenda.

## 11. Transporte

Veículo, transportadora, contato, origem, destino, coleta, previsão, entrega efetiva, valor previsto,
valor pago, comprovante e status.

## 12. Veículos e estoque

Ficha com identificação, fotos, compra, leilão, inspeções, peças, reparos, despesas, documentação,
histórico, investimento, valor de mercado, valor anunciado e lucro estimado.

**Status:** Comprado · Aguardando retirada · Em transporte · Recebido · Em inspeção · Em preparação ·
Aguardando peças · Em reparo · Em detalhamento · Pronto para venda · Anunciado · Reservado para venda · Vendido.

**Anúncios:** fotos, descrição, preço, plataformas, data, histórico de preços, interessados e propostas.
Cada proposta mostra se atinge o lucro mínimo.

## 13. Vendas

Veículo, cliente, data, preço anunciado, proposta, desconto, valor final, forma de pagamento, entrada,
parcelas, despesas de venda, contrato e recibo. Pagamentos parciais e pendentes são controlados. A venda
atualiza o status do veículo e fecha o resultado da operação.

## 14. Clientes e fornecedores

**Clientes:** nome, telefone, e-mail, endereço, histórico de compras e pagamentos.
**Fornecedores:** nome, empresa, contato, endereço, especialidade, histórico de compras e serviços, pagamentos.

## 15. Financeiro

Contas a pagar, contas a receber, caixa, contas bancárias (cadastro manual), cartões corporativos,
transferências, fluxo de caixa e DRE gerencial. Cada lançamento tem descrição, categoria, veículo,
fornecedor/cliente, valor, data, vencimento, pagamento, conta, comprovante e status.

Não há conexão bancária obrigatória, e despesas de compras, peças ou reparos não são duplicadas.

## 16. Dashboard

**Indicadores:** total de veículos, oportunidades em análise, comprados, em preparação, prontos para venda,
vendidos, investimento total, despesas, estoque financeiro, receita, lucro, margem média, contas a pagar e a receber.

**Gráficos:** compras, vendas e lucro mensais, gastos por categoria, previsto × real, lucro por veículo,
tempo médio de preparação e de estoque.

## 17. Relatórios (PDF e Excel)

Veículos comprados, vendidos e disponíveis, análise de leilão, lista de peças, reparos, despesas, custos
individuais, lucro, margem e ROI por veículo, fluxo de caixa, contas a pagar e a receber, resultado mensal.

## 18. Usuários e permissões

Perfis: Super Admin, Administrador, Financeiro, Gerente, Comprador de leilão, Vendedor, Mecânico e Atendente.
Permissões de visualizar, criar, editar, aprovar e excluir por módulo, com auditoria das operações importantes.

## 19. Alertas automáticos

Veículo parado há muitos dias · peça atrasada · orçamento ultrapassado · documento pendente · reparo não
concluído · conta próxima do vencimento · veículo vendido com saldo pendente · lucro projetado abaixo da meta.

## 20. Regras obrigatórias

1. Não permitir duplicação de VIN.
2. Todo veículo comprado deve ter uma aquisição registrada.
3. Toda despesa deve ser vinculada corretamente.
4. Diferenciar despesas previstas e reais.
5. Não duplicar custos.
6. Toda compra gera seu histórico financeiro.
7. Toda peça comprada atualiza os custos do veículo.
8. Todo reparo concluído atualiza o custo total.
9. Toda venda atualiza o estoque.
10. Não permitir venda duplicada do mesmo veículo.
11. Não excluir silenciosamente transações financeiras confirmadas.
12. Registrar alterações e responsáveis.
13. Garantir isolamento e segurança dos dados.
14. Preservar o histórico de cada veículo após a venda, mesmo depois de anos.
15. Atualizar os cálculos de lucro e margem automaticamente.

## 21. Fora do escopo

Aluguel de veículos, reservas e contratos de locação, consignação e comissão de consignação, gestão de
veículos/frota de terceiros, motoristas, rastreamento GPS, abastecimento de frota, passageiros e transporte
de pessoas. Integrações com bancos ou leilões **não são obrigatórias** na primeira versão. Os dados são
lançados manualmente, com possibilidade de integração futura.

## 22. Funcionalidades futuras

Importação de dados de leilões, integração com fornecedores de peças, consulta de preços de mercado, OCR de
recibos, leitura de VIN, reconhecimento de danos em fotos por IA (sempre confirmado por uma pessoa), sugestão
de peças, geração automática de anúncios e notificações inteligentes.

## 23. Entregas

| Versão | Escopo |
|---|---|
| V1 — Operacional | Leilões, compras, veículos, inspeção, peças, reparos e custos |
| V2 — Comercial e financeiro | Estoque, vendas, clientes, caixa, contas e relatórios |
| V3 — Inteligente | IA para danos, análise de mercado, leitura de VIN e automações |

## 24. Critérios de aceite

O sistema só é considerado funcional quando: o banco está conectado; os formulários salvam dados reais;
fotos e documentos ficam armazenados; os veículos têm histórico completo; o orçamento inicial pode ser
comparado ao custo real; os cálculos de margem e lucro funcionam; o estoque atualiza automaticamente; as
vendas atualizam o financeiro; as permissões funcionam; os relatórios mostram dados reais; e o aplicativo
funciona em computador e celular. **Nenhum dado fictício substitui funcionalidade real.**
