// Excluir veículo / análise de leilão (testes e cadastros errados)
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { rpc, supabase } from '../lib.js'
import { Field, Icon, Modal, useAction } from './ui.jsx'
import { useApp } from '../App.jsx'

// Apaga do Storage os arquivos devolvidos pela função (fotos, PDFs). Melhor esforço.
async function removeFiles(files = []) {
  const byBucket = {}
  for (const f of files) if (f.bucket && f.path) (byBucket[f.bucket] ||= []).push(f.path)
  await Promise.all(Object.entries(byBucket).map(([bucket, paths]) =>
    supabase.storage.from(bucket).remove(paths).catch(() => null)))
}

export function DeleteRecordButton({ kind, id, name, sold, withVehicle, redirectTo }) {
  const { can } = useApp()
  const nav = useNavigate()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [run, busy] = useAction()
  const module = kind === 'vehicle' ? 'vehicles' : 'auction'
  if (!can(module, 'delete')) return null

  const removesVehicle = kind === 'vehicle' || withVehicle
  const confirmed = typed.trim().toUpperCase() === 'EXCLUIR'

  const go = async () => {
    const fn = kind === 'vehicle' ? 'delete_vehicle' : 'delete_opportunity'
    const arg = kind === 'vehicle' ? { p_vehicle_id: id } : { p_opportunity_id: id }
    const res = await run(() => rpc(fn, arg), kind === 'vehicle' ? 'Veículo excluído' : 'Análise excluída')
    await removeFiles(res?.files)
    nav(redirectTo, { replace: true })
  }

  const close = () => { setOpen(false); setTyped('') }

  return (
    <>
      <button className="btn-sm btn-danger" onClick={() => setOpen(true)}><Icon name="trash" /> Excluir</button>
      {open && (
        <Modal title={kind === 'vehicle' ? 'Excluir veículo' : 'Excluir análise de leilão'} onClose={close}
          footer={<>
            <button onClick={close}>Cancelar</button>
            <button className="btn-danger" onClick={go} disabled={!confirmed || busy}>{busy ? 'Excluindo…' : 'Excluir definitivamente'}</button>
          </>}>
          <div className="stack">
            <p style={{ margin: 0 }}><b>{name}</b> será apagado do sistema{removesVehicle ? ' junto com tudo que está ligado a ele' : ''}:</p>
            {removesVehicle ? (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                <li>compra, orçamento, peças, mão de obra, despesas e reboque</li>
                <li>fotos, documentos e comprovantes anexados</li>
                <li>contas a pagar e pagamentos já registrados deste carro</li>
                {sold && <li>a venda, as parcelas e os recebimentos do cliente</li>}
                <li>{kind === 'vehicle' ? 'a análise de leilão de origem' : 'o veículo no estoque'}</li>
              </ul>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>Simulações, lances e anexos desta análise também serão apagados.</p>
            )}
            <div className="alert-box warning small">Não tem como desfazer. Use para testes ou cadastros feitos por engano. O cadastro do cliente é mantido.</div>
            <Field label={<>Para confirmar, digite <b>EXCLUIR</b></>}>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
            </Field>
          </div>
        </Modal>
      )}
    </>
  )
}
