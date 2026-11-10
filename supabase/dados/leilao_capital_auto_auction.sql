-- Capital Auto Auction (NH) — taxas de comprador cadastradas em produção (fonte: capitalautoauction.com)
-- Aplicado no SQL Editor após o setup_completo.sql. Faixas: min_amount <= lance < max_amount.
with c as (
  select id from public.companies where name = 'Car King Auto Sales'
),
s as (
  insert into public.auction_sources (company_id, name, website, bid_increment, flat_fees, flat_fees_description, notes)
  select c.id, x.name, 'https://capitalautoauction.com', 25, 14, 'Fuel Surcharge', x.notes
  from c, (values
    ('Capital Auto Auction NH - Presencial', 'Buy Fee + Fuel Surcharge (lance no local)'),
    ('Capital Auto Auction NH - Online',     'Buy Fee + Internet Fee + Fuel Surcharge (lance pela internet)')
  ) as x(name, notes)
  returning id, company_id, name
)
insert into public.auction_fee_tiers (company_id, source_id, fee_type, min_amount, max_amount, fixed_fee, percent_fee)
select s.company_id, s.id, 'buy_fee', t.de, t.ate, t.taxa, t.pct
from s, (values
  (0, 100, 60, 0), (100, 300, 95, 0), (300, 400, 105, 0), (400, 500, 125, 0),
  (500, 800, 160, 0), (800, 1000, 210, 0), (1000, 1300, 250, 0), (1300, 1500, 270, 0),
  (1500, 1700, 290, 0), (1700, 2000, 310, 0), (2000, 2500, 340, 0), (2500, 3000, 360, 0),
  (3000, 3500, 390, 0), (3500, 4000, 420, 0), (4000, 5000, 440, 0), (5000, 6000, 460, 0),
  (6000, 7500, 480, 0), (7500, 10000, 530, 0), (10000, 15000, 740, 0), (15000, 25000, 910, 0),
  (25000, null, 0, 7)
) as t(de, ate, taxa, pct)
union all
select s.company_id, s.id, 'internet_fee', i.de, i.ate, i.taxa, 0
from s, (values
  (0, 1000, 69), (1000, 2000, 79), (2000, 3000, 89),
  (3000, null, 99)   -- CONFIRMAR: valor de "$3,000 - greater" estava coberto no print
) as i(de, ate, taxa)
where s.name like '%Online';
