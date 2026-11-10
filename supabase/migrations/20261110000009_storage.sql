-- =============================================================================
-- CARKING — 09 · Supabase Storage: fotos, vídeos, recibos e documentos
-- =============================================================================
-- Convenção de caminho (obrigatória): {company_id}/{entity_type}/{entity_id}/{arquivo}
-- Exemplo: 6f1c.../vehicle/9a2b.../frente-01.jpg
-- Após o upload, registre o arquivo em public.attachments (ou documents.storage_path).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('vehicle-media', 'vehicle-media', false, 52428800,
   array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'video/mp4', 'video/quicktime']),
  ('documents', 'documents', false, 26214400,
   array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy carking_storage_select on storage.objects for select to authenticated
  using (bucket_id in ('vehicle-media', 'documents')
         and (storage.foldername(name))[1] = app.current_company_id()::text);

create policy carking_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id in ('vehicle-media', 'documents')
              and (storage.foldername(name))[1] = app.current_company_id()::text);

create policy carking_storage_update on storage.objects for update to authenticated
  using (bucket_id in ('vehicle-media', 'documents')
         and (storage.foldername(name))[1] = app.current_company_id()::text);

-- Arquivos de documentos só podem ser apagados por quem tem permissão de exclusão
create policy carking_storage_delete on storage.objects for delete to authenticated
  using (bucket_id in ('vehicle-media', 'documents')
         and (storage.foldername(name))[1] = app.current_company_id()::text
         and app.has_permission(case when bucket_id = 'documents' then 'documents' else 'vehicles' end::public.app_module, 'delete'));
