// Botão "WhatsApp": abre a conversa com o cliente e a mensagem de cobrança pronta
import { useState } from 'react'
import { date, reminderMessage, rpc, whatsappNumber } from '../lib.js'
import { useApp } from '../App.jsx'
import { useToast } from './ui.jsx'

export function ReminderButton({ receivable, customer, phone, vehicle, onSent }) {
  const { company } = useApp()
  const toast = useToast()
  const [last, setLast] = useState(receivable.last_reminder_at)
  const number = whatsappNumber(phone)
  if (!['open', 'partial'].includes(receivable.status)) return null
  const send = async (e) => {
    e?.stopPropagation()
    if (!number) { toast('Este cliente não tem telefone cadastrado.', 'error'); return }
    const text = reminderMessage(company.reminder_template, { customer, vehicle, receivable, company: company.name })
    window.open(`https://wa.me/${number}?text=${encodeURIComponent(text)}`, '_blank')
    try { await rpc('log_payment_reminder', { p_receivable_id: receivable.id }); setLast(new Date().toISOString()); onSent?.() } catch { /* registro é opcional */ }
  }
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <button type="button" className="btn-sm btn-whatsapp" onClick={send} title={number ? `Enviar lembrete para ${phone}` : 'Cliente sem telefone'} disabled={!number}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.9-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>
        WhatsApp
      </button>
      {last && <span className="muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>lembrado {date(last)}</span>}
    </span>
  )
}
