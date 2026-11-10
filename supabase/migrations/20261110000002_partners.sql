-- =============================================================================
-- CARKING — 02 · Clientes e fornecedores
-- =============================================================================

create type public.supplier_type as enum (
  'parts', 'mechanic', 'body_shop', 'paint_shop', 'detailing', 'transport',
  'auction', 'documentation', 'inspection', 'other'
);

create table public.suppliers (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  name         text not null,
  company_name text,
  supplier_type public.supplier_type not null default 'other',
  specialty    text,
  contact_name text,
  phone        text,
  email        text,
  website      text,
  address      text,
  city         text,
  state        text,
  zip          text,
  notes        text,
  is_active    boolean not null default true,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index suppliers_company_idx on public.suppliers(company_id, supplier_type);

create table public.customers (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null default app.current_company_id() references public.companies(id) on delete restrict,
  full_name     text not null,
  customer_type text not null default 'individual' check (customer_type in ('individual', 'business', 'dealer')),
  phone         text,
  email         text,
  document_id   text, -- driver license / EIN
  address       text,
  city          text,
  state         text,
  zip           text,
  notes         text,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index customers_company_idx on public.customers(company_id, full_name);
