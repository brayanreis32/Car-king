// Conexão com o Supabase, formatação e rótulos em português
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js'

export const isConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)
export const supabase = isConfigured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null

// Executa uma consulta e lança erro legível
export async function q(promise) {
  const { data, error } = await promise
  if (error) throw new Error(translateError(error.message))
  return data
}
export const rpc = (fn, args) => q(supabase.rpc(fn, args))

// Chama uma Edge Function do Supabase e devolve erros legíveis
export async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body })
  if (error) {
    let msg = error.message
    try { const j = await error.context.json(); msg = j.error || msg } catch { /* sem corpo */ }
    if (/Failed to send|not found|404/i.test(msg)) msg = `O serviço "${name}" ainda não foi instalado no Supabase.`
    throw new Error(msg)
  }
  if (data?.error) throw new Error(data.error)
  return data
}

function translateError(msg = '') {
  if (msg.includes('row-level security')) return 'Você não tem permissão para esta ação.'
  if (msg.includes('vehicles_company_id_vin_key')) return 'Já existe um veículo com este VIN.'
  if (msg.includes('Invalid login credentials')) return 'E-mail ou senha incorretos.'
  if (msg.includes('duplicate key')) return 'Este registro já existe.'
  if (msg.includes('Failed to fetch')) return 'Sem conexão com o servidor. Verifique sua internet.'
  return msg
}

// ---------- Formatação ----------
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
export const money = (v, cents = false) => (v === null || v === undefined || v === '' ? '—' : (cents ? usd2 : usd).format(Number(v)))
export const signedMoney = (v) => (v === null || v === undefined ? '—' : (Number(v) > 0 ? '+' : '') + money(v))
export const pct = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(2)}%`)
export const num = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-US').format(v))
export const date = (v) => {
  if (!v) return '—'
  const d = new Date(String(v).length === 10 ? `${v}T12:00:00` : v)
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/New_York' })
}
export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
export const toNum = (v) => (v === '' || v === null || v === undefined ? null : Number(v))
export const vehicleName = (v) => [v?.year, v?.make, v?.model, v?.trim].filter(Boolean).join(' ')

// ---------- Rótulos ----------
export const LABELS = {
  opportunity_status: {
    analyzing: 'Em análise', awaiting_inspection: 'Aguardando inspeção', awaiting_quote: 'Aguardando orçamento',
    approved: 'Aprovado para compra', bid_placed: 'Lance realizado', won: 'Arrematado', lost: 'Não arrematado', discarded: 'Descartado',
  },
  vehicle_status: {
    purchased: 'Comprado', awaiting_pickup: 'Aguardando retirada', in_transit: 'Em transporte', received: 'Recebido',
    in_inspection: 'Em inspeção', in_preparation: 'Em preparação', awaiting_parts: 'Aguardando peças', in_repair: 'Em reparo',
    in_detailing: 'Em detalhamento', ready_for_sale: 'Pronto para venda', listed: 'Anunciado', reserved: 'Reservado', sold: 'Vendido',
  },
  title_status: {
    clean: 'Clean', salvage: 'Salvage', rebuilt: 'Rebuilt', flood: 'Flood', certificate_of_destruction: 'Certificate of Destruction',
    parts_only: 'Parts Only', bill_of_sale_only: 'Bill of Sale Only', lemon_buyback: 'Lemon Buyback', other: 'Outro', unknown: 'Não informado',
  },
  run_condition: { run_and_drive: 'Liga e anda', engine_starts: 'Só liga', does_not_start: 'Não liga', stationary: 'Parado', unknown: 'Não informado' },
  fuel_type: { gasoline: 'Gasolina', diesel: 'Diesel', hybrid: 'Híbrido', plug_in_hybrid: 'Híbrido plug-in', electric: 'Elétrico', flex: 'Flex', other: 'Outro' },
  transmission: { automatic: 'Automático', manual: 'Manual', cvt: 'CVT', dual_clutch: 'Dupla embreagem', other: 'Outro' },
  vehicle_area: {
    front: 'Frente', rear: 'Traseira', left_side: 'Lateral esquerda', right_side: 'Lateral direita', roof: 'Teto',
    engine: 'Motor', transmission: 'Transmissão', suspension: 'Suspensão', brakes: 'Freios', structure: 'Estrutura e chassi',
    airbags: 'Airbags', electrical: 'Elétrica', interior: 'Interior', wheels: 'Rodas', tires: 'Pneus', glass: 'Vidros',
    undercarriage: 'Parte de baixo', other: 'Outro',
  },
  item_condition: { good: 'Bom', damaged: 'Danificado', needs_repair: 'Precisa reparar', needs_replacement: 'Precisa substituir', needs_diagnosis: 'Precisa de diagnóstico' },
  severity: { none: 'Nenhuma', low: 'Baixa', medium: 'Média', high: 'Alta', critical: 'Crítica' },
  part_status: {
    identified: 'Identificada', awaiting_quote: 'Aguardando orçamento', to_buy: 'A comprar', purchased: 'Comprada',
    awaiting_delivery: 'Aguardando entrega', received: 'Recebida', installed: 'Instalada', returned: 'Devolvida',
  },
  part_condition: { new: 'Nova', used: 'Usada', refurbished: 'Recondicionada', aftermarket: 'Aftermarket' },
  part_category: {
    body: 'Lataria', lighting: 'Iluminação', mechanical: 'Mecânica', engine: 'Motor', transmission: 'Transmissão',
    electrical: 'Elétrica', suspension: 'Suspensão', brakes: 'Freios', cooling: 'Arrefecimento', tires_wheels: 'Pneus e rodas',
    glass: 'Vidros', interior: 'Interior', airbag_srs: 'Airbag / SRS', fluids: 'Fluidos', other: 'Outra',
  },
  repair_status: {
    pending: 'Pendente', quote_requested: 'Orçamento solicitado', approved: 'Aprovado', in_progress: 'Em andamento',
    awaiting_parts: 'Aguardando peças', completed: 'Concluído', cancelled: 'Cancelado',
  },
  transport_status: { quoted: 'Previsto', booked: 'Agendado', picked_up: 'Retirado', in_transit: 'Em trânsito', delivered: 'Entregue', cancelled: 'Cancelado' },
  document_type: {
    bill_of_sale: 'Bill of Sale', title: 'Title', salvage_title: 'Salvage Title', rebuilt_title: 'Rebuilt Title',
    auction_document: 'Documentos do leilão', payment_receipt: 'Comprovante de pagamento', invoice: 'Invoice / nota',
    transport_document: 'Documento de transporte', inspection_report: 'Relatório de inspeção', transfer_record: 'Transferência',
    sale_contract: 'Contrato de venda', other: 'Outro',
  },
  document_status: {
    pending: 'Pendente', requested: 'Solicitado', received: 'Recebido', submitted: 'Enviado', approved: 'Aprovado',
    rejected: 'Rejeitado', expired: 'Vencido', not_applicable: 'Não se aplica',
  },
  budget_line: {
    purchase: 'Lance de compra', auction_fees: 'Taxas do leilão', transport: 'Reboque / transporte', parts: 'Peças',
    labor: 'Mão de obra', documentation: 'Documentação', inspection: 'Inspeção', other: 'Outros custos',
    contingency: 'Reserva de imprevistos', selling: 'Despesas de venda',
  },
  decision: { viable: 'Vale a pena', above_limit: 'Lance acima do limite', not_viable: 'Não compensa' },
  binding_rule: { min_profit: 'lucro mínimo', min_margin: 'margem mínima', min_roi: 'ROI mínimo', break_even: 'ponto de equilíbrio', not_viable: 'operação inviável' },
  alert_type: {
    stale_vehicle: 'Veículo parado', part_late: 'Peça atrasada', budget_overrun: 'Orçamento estourado', profit_below_target: 'Lucro abaixo da meta',
    document_pending: 'Documento pendente', repair_overdue: 'Reparo atrasado', payable_due: 'Conta a pagar', sold_with_balance: 'Vendido com saldo',
  },
  payment_method: { cash: 'Dinheiro', check: 'Cheque', wire: 'Transferência', zelle: 'Zelle', card: 'Cartão', financing: 'Financiamento', mixed: 'Misto', other: 'Outro' },
}
export const label = (group, value) => LABELS[group]?.[value] ?? value ?? '—'
export const options = (group) => Object.entries(LABELS[group])

export const VEHICLE_STATUS_TONE = {
  purchased: 'info', awaiting_pickup: 'info', in_transit: 'info', received: 'info',
  in_inspection: 'warning', in_preparation: 'warning', awaiting_parts: 'warning', in_repair: 'warning', in_detailing: 'warning',
  ready_for_sale: 'gold', listed: 'gold', reserved: 'gold', sold: 'success',
}
export const OPP_STATUS_TONE = {
  analyzing: 'info', awaiting_inspection: 'warning', awaiting_quote: 'warning', approved: 'gold',
  bid_placed: 'gold', won: 'success', lost: '', discarded: '',
}
export const PART_STATUS_TONE = {
  identified: '', awaiting_quote: 'warning', to_buy: 'warning', purchased: 'info', awaiting_delivery: 'info',
  received: 'gold', installed: 'success', returned: 'error',
}
