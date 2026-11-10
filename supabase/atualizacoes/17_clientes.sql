-- =============================================================================
-- CARKING — Atualização 17: aba Clientes (cadastro completo e documentos)
-- Para bancos já instalados: cole no SQL Editor (aba nova) e clique em Run (uma vez).
-- =============================================================================
-- =============================================================================
-- CARKING — 17 · Clientes: cadastro completo, fotos dos documentos, exclusão
-- =============================================================================
-- * customers: endereço completo (linha 2), telefone alternativo, nascimento,
--   estado e validade da driver license (o número fica em document_id).
-- * attachments: entity_type 'customer' para fotos/PDF dos documentos do cliente
--   (driver license, comprovante de endereço, seguro...). Acesso pelo módulo
--   "customers" (vendedor também envia e vê).
-- * delete_customer(id): exclui cliente sem compras (cadastro errado/teste).
-- =============================================================================

alter table public.customers
  add column if not exists address2        text,
  add column if not exists phone_alt       text,
  add column if not exists birth_date      date,
  add column if not exists license_state   text,
  add column if not exists license_expires date;

alter table public.attachments drop constraint if exists attachments_entity_type_check;
alter table public.attachments add constraint attachments_entity_type_check check (entity_type in (
  'auction_opportunity', 'damage_assessment', 'vehicle', 'vehicle_purchase',
  'inspection', 'inspection_item', 'part', 'part_order', 'repair_order',
  'repair_item', 'labor_entry', 'transport_order', 'document', 'expense',
  'listing', 'sale', 'sale_payment', 'financial_transaction', 'customer'));

-- Documentos do cliente: liberados por quem cuida de clientes
create policy attachments_customer_select on public.attachments for select to authenticated
  using (company_id = app.current_company_id() and entity_type = 'customer' and app.has_permission('customers', 'view'));
create policy attachments_customer_insert on public.attachments for insert to authenticated
  with check (company_id = app.current_company_id() and entity_type = 'customer' and app.has_permission('customers', 'create'));
create policy attachments_customer_delete on public.attachments for delete to authenticated
  using (company_id = app.current_company_id() and entity_type = 'customer' and app.has_permission('customers', 'edit'));

create policy carking_storage_delete_customer on storage.objects for delete to authenticated
  using (bucket_id = 'documents'
         and (storage.foldername(name))[1] = app.current_company_id()::text
         and (storage.foldername(name))[2] = 'customer'
         and app.has_permission('customers', 'edit'));

-- -----------------------------------------------------------------------------
-- Excluir cliente (só se não tiver compras nem faturas)
-- -----------------------------------------------------------------------------
create or replace function public.delete_customer(p_customer_id uuid)
returns jsonb
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare files jsonb;
begin
  if not app.has_permission('customers', 'delete') then
    raise exception 'Sem permissão para excluir clientes.';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and company_id = app.current_company_id()) then
    raise exception 'Cliente não encontrado.';
  end if;
  if exists (select 1 from public.sales where customer_id = p_customer_id)
     or exists (select 1 from public.accounts_receivable where customer_id = p_customer_id)
     or exists (select 1 from public.financial_transactions where customer_id = p_customer_id) then
    raise exception 'Este cliente tem compra ou fatura registrada. Para apagar um teste, exclua primeiro o veículo vendido a ele.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'path', path)), '[]'::jsonb) into files
    from public.attachments where entity_type = 'customer' and entity_id = p_customer_id;
  delete from public.attachments where entity_type = 'customer' and entity_id = p_customer_id;
  delete from public.customers where id = p_customer_id;
  return jsonb_build_object('files', files);
end $$;

grant execute on function public.delete_customer(uuid) to authenticated;
revoke execute on function public.delete_customer(uuid) from anon, public;
