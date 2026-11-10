-- =============================================================================
-- CARKING — 01 · Núcleo: empresa, filiais, perfis, papéis, permissões, auditoria
-- =============================================================================
-- Convenções do projeto:
--   * Todas as chaves primárias são UUID.
--   * Valores monetários usam numeric(12,2). Percentuais usam numeric(7,4).
--   * Toda tabela de negócio possui company_id (isolamento multiempresa via RLS).
--   * company_id tem default app.current_company_id(): o app não precisa enviá-lo.
--   * Funções auxiliares ficam no schema "app" (não exposto pela API REST).
-- =============================================================================

create extension if not exists pgcrypto;

create schema if not exists app;
grant usage on schema app to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.app_module as enum (
  'dashboard', 'auction', 'vehicles', 'purchases', 'inspections', 'parts',
  'repairs', 'transport', 'inventory', 'sales', 'customers', 'suppliers',
  'finance', 'documents', 'reports', 'employees', 'settings'
);

create type public.permission_action as enum ('view', 'create', 'edit', 'approve', 'delete');

-- -----------------------------------------------------------------------------
-- Empresa e filiais
-- -----------------------------------------------------------------------------
create table public.companies (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null check (length(trim(name)) > 0),
  legal_name               text,
  ein                      text,
  dealer_license           text,
  phone                    text,
  email                    text,
  address                  text,
  city                     text,
  state                    text,
  zip                      text,
  currency                 char(3) not null default 'USD',
  timezone                 text not null default 'America/New_York',
  locale                   text not null default 'pt-BR',
  -- Parâmetros de negócio usados nos cálculos e alertas
  default_min_profit       numeric(12,2) not null default 2000 check (default_min_profit >= 0),
  default_min_margin_pct   numeric(7,4)  not null default 15   check (default_min_margin_pct >= 0 and default_min_margin_pct < 100),
  default_min_roi_pct      numeric(7,4)  not null default 0    check (default_min_roi_pct >= 0),
  default_contingency_pct  numeric(7,4)  not null default 10   check (default_contingency_pct >= 0),
  budget_alert_pct         numeric(7,4)  not null default 10   check (budget_alert_pct >= 0),
  stale_vehicle_days       integer       not null default 45   check (stale_vehicle_days > 0),
  payable_alert_days       integer       not null default 7    check (payable_alert_days >= 0),
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create table public.branches (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete restrict,
  name        text not null,
  address     text,
  city        text,
  state       text,
  zip         text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (company_id, name)
);

-- -----------------------------------------------------------------------------
-- Papéis e permissões (matriz módulo × ação)
-- -----------------------------------------------------------------------------
create table public.roles (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  code         text not null check (code ~ '^[a-z_]+$'),
  name         text not null,
  description  text,
  is_system    boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (company_id, code)
);

create table public.permissions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  role_id      uuid not null references public.roles(id) on delete cascade,
  module       public.app_module not null,
  can_view     boolean not null default false,
  can_create   boolean not null default false,
  can_edit     boolean not null default false,
  can_approve  boolean not null default false,
  can_delete   boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (role_id, module)
);

-- -----------------------------------------------------------------------------
-- Perfis (funcionários). id = auth.users.id
-- -----------------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  company_id  uuid not null references public.companies(id) on delete restrict,
  branch_id   uuid references public.branches(id) on delete set null,
  role_id     uuid not null references public.roles(id) on delete restrict,
  full_name   text not null,
  email       text,
  phone       text,
  job_title   text,
  avatar_path text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index profiles_company_idx on public.profiles(company_id);

-- -----------------------------------------------------------------------------
-- Auditoria
-- -----------------------------------------------------------------------------
create table public.audit_logs (
  id          bigint generated always as identity primary key,
  company_id  uuid,
  table_name  text not null,
  record_id   uuid,
  action      text not null check (action in ('INSERT', 'UPDATE', 'DELETE')),
  old_data    jsonb,
  new_data    jsonb,
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index audit_logs_record_idx  on public.audit_logs(table_name, record_id);
create index audit_logs_company_idx on public.audit_logs(company_id, changed_at desc);

-- -----------------------------------------------------------------------------
-- Funções auxiliares
-- -----------------------------------------------------------------------------
create or replace function app.current_company_id()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.company_id from public.profiles p
  where p.id = auth.uid() and p.is_active
$$;

create or replace function app.current_role_code()
returns text
language sql stable security definer
set search_path = public, pg_temp
as $$
  select r.code from public.profiles p
  join public.roles r on r.id = p.role_id
  where p.id = auth.uid() and p.is_active
$$;

create or replace function app.has_permission(p_module public.app_module, p_action public.permission_action)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when r.code = 'super_admin' then true
      else case p_action
        when 'view'    then pm.can_view
        when 'create'  then pm.can_create
        when 'edit'    then pm.can_edit
        when 'approve' then pm.can_approve
        when 'delete'  then pm.can_delete
      end
    end
    from public.profiles pr
    join public.roles r on r.id = pr.role_id
    left join public.permissions pm on pm.role_id = r.id and pm.module = p_module
    where pr.id = auth.uid() and pr.is_active
  ), false)
$$;

-- Exposta ao app para mostrar/ocultar menus no FlutterFlow
create or replace function public.my_permissions()
returns table (module public.app_module, can_view boolean, can_create boolean,
               can_edit boolean, can_approve boolean, can_delete boolean)
language sql stable security definer
set search_path = public, pg_temp
as $$
  select m.module,
         app.has_permission(m.module, 'view'),
         app.has_permission(m.module, 'create'),
         app.has_permission(m.module, 'edit'),
         app.has_permission(m.module, 'approve'),
         app.has_permission(m.module, 'delete')
  from unnest(enum_range(null::public.app_module)) as m(module)
  where auth.uid() is not null
$$;

create or replace function app.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function app.audit_row()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
begin
  if tg_op = 'UPDATE' and (v_old - 'updated_at') = (v_new - 'updated_at') then
    return new; -- nada mudou de fato
  end if;
  insert into public.audit_logs (company_id, table_name, record_id, action, old_data, new_data, changed_by)
  values (
    coalesce((v_new ->> 'company_id')::uuid, (v_old ->> 'company_id')::uuid),
    tg_table_name,
    coalesce((v_new ->> 'id')::uuid, (v_old ->> 'id')::uuid),
    tg_op, v_old, v_new, auth.uid()
  );
  return coalesce(new, old);
end $$;

-- Impede exclusão física (usado em tabelas cujo histórico deve ser preservado)
create or replace function app.prevent_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Registros de % não podem ser excluídos; use o status de cancelamento para preservar o histórico.', tg_table_name
    using errcode = 'P0001';
end $$;
