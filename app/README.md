# Car King — app (web + celular)

App responsivo em React + Vite que usa o banco do Supabase (`../supabase`).

- **Endereço:** https://brayanreis32.github.io/Car-king/
- **No celular:** abra o endereço → Compartilhar → **Adicionar à Tela de Início** (iPhone) ou menu ⋮ → **Instalar app** (Android).
- **Publicação:** automática pelo GitHub Actions (`.github/workflows/deploy-app.yml`) a cada alteração em `app/`.

## Rodar localmente

```bash
cd app
npm install
npm run dev
```

A URL e a chave pública (publishable) do Supabase ficam em `src/config.js`. A chave é pública por natureza;
os dados são protegidos pelo Row Level Security do banco. Nunca coloque a chave secreta nem a senha do banco no app.

## Telas

| Tela | O que faz |
|---|---|
| Dashboard | Indicadores e alertas |
| Auction Analyzer | Cadastro do carro do leilão, danos, validação do título, **simulador ao vivo com lance máximo**, lances e registro da compra |
| Veículos | Resumo de lucro, orçamento × real, reboque, peças, mão de obra, despesas, documentos (com upload), propostas e venda |
| Financeiro | Contas a pagar e a receber, pagamentos e saldos |
| Configurações | Metas de lucro/margem/alertas e cadastro de leilões (reboque padrão, taxas fixas, incremento) |
