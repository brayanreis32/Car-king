// Leitura de extratos bancários (CSV de qualquer banco americano e OFX/QFX).
// Retorna lançamentos { date: 'YYYY-MM-DD', amount: número (negativo = saída), description, reference }.

// ---------- OFX / QFX ----------
function parseOfx(text) {
  const tag = (block, name) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(block)
    return m ? m[1].trim() : ''
  }
  const rows = []
  const re = /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi
  let m
  while ((m = re.exec(text))) {
    const b = m[1]
    const d = tag(b, 'DTPOSTED')
    const amount = Number(tag(b, 'TRNAMT').replace(',', '.'))
    if (!/^\d{8}/.test(d) || !Number.isFinite(amount) || amount === 0) continue
    const description = [tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).join(' — ') || tag(b, 'TRNTYPE') || 'Lançamento'
    rows.push({ date: `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`, amount, description, reference: `ofx:${tag(b, 'FITID') || `${d}|${amount}|${description}`}` })
  }
  return rows
}

// ---------- CSV ----------
export function splitCsvLine(line, delim) {
  const out = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c
    } else if (c === '"') q = true
    else if (c === delim) { out.push(cur.trim()); cur = '' } else cur += c
  }
  out.push(cur.trim())
  return out
}

export function parseMoney(v) {
  if (v === undefined || v === null) return null
  let s = String(v).trim()
  if (!s) return null
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\bDR\b/i.test(s)
  s = s.replace(/[()$\s]|USD|CR|DR/gi, '').replace(/-/g, '')
  if (/^\d{1,3}(\.\d{3})+,\d{2}$/.test(s) || /^\d+,\d{2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.') // 1.234,56 ou 400,00
  else s = s.replace(/,/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

export function parseDate(v) {
  const s = String(v || '').trim()
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(s)
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` }
  m = /^(\d{8})$/.exec(s)
  if (m) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return null
}

const DATE_H = /^(date|posting date|posted date|transaction date|trans\.? date|post date|effective date)$/i
const DESC_H = /^(description|payee|name|memo|details|transaction description|merchant|transaction)$/i
const AMT_H = /^(amount|transaction amount|amount \(usd\)|net amount)$/i
const DEBIT_H = /^(debit|debits|withdrawal|withdrawals|withdrawal amount|debit amount|money out|payments)$/i
const CREDIT_H = /^(credit|credits|deposit|deposits|deposit amount|credit amount|money in)$/i
const TYPE_H = /^(type|transaction type|credit\/debit|debit\/credit)$/i

// Lê CSV e tenta detectar as colunas sozinho. Se não conseguir, devolve { needsMapping, headers, sample }.
export function parseCsv(text, mapping) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim())
  if (!lines.length) return { rows: [] }
  const delim = [',', ';', '\t'].map((d) => [d, (lines.slice(0, 15).join('\n').match(new RegExp(d === '\t' ? '\\t' : d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0][0]
  const table = lines.map((l) => splitCsvLine(l, delim))

  // procura a linha de cabeçalho (bancos como o BofA põem um resumo antes)
  let hi = table.findIndex((r) => r.some((c) => DATE_H.test(c)) && r.some((c) => AMT_H.test(c) || DEBIT_H.test(c) || CREDIT_H.test(c)))
  let col = mapping
  if (!col && hi >= 0) {
    const h = table[hi]
    const find = (re) => h.findIndex((c) => re.test(c))
    // descrição: prefere "Description" antes de "Payee", "Name", "Memo" e "Details"
    const descIdx = ['description', 'transaction description', 'payee', 'name', 'merchant', 'memo', 'details', 'transaction']
      .map((n) => h.findIndex((c) => c.toLowerCase() === n)).find((i) => i >= 0) ?? -1
    col = { date: find(DATE_H), desc: descIdx, amount: find(AMT_H), debit: find(DEBIT_H), credit: find(CREDIT_H), type: find(TYPE_H) }
    if (col.desc < 0) col.desc = h.findIndex((c, i) => i !== col.date && i !== col.amount && /desc|memo|payee|detail/i.test(c))
  }
  if (!col && hi < 0) {
    // sem cabeçalho (ex.: Wells Fargo: "data","valor","*","","descrição")
    const first = table[0]
    const dateIdx = first.findIndex((c) => parseDate(c))
    const amtIdx = first.findIndex((c, i) => i !== dateIdx && /^[-(]?\$?[\d,]+\.\d{2}\)?$/.test(c))
    if (dateIdx >= 0 && amtIdx >= 0) {
      const descIdx = first.reduce((best, c, i) => (i !== dateIdx && i !== amtIdx && c.length > (first[best]?.length || 0) ? i : best), -1)
      col = { date: dateIdx, amount: amtIdx, desc: descIdx, debit: -1, credit: -1, type: -1 }
      hi = -1
    }
  }
  if (!col || col.date < 0 || (col.amount < 0 && col.debit < 0 && col.credit < 0)) {
    if (hi < 0 && !parseDate(table[0][0]) && table[0].every((c) => parseMoney(c) === null)) hi = 0 // 1ª linha é cabeçalho
    const headers = hi >= 0 ? table[hi].map((c, i) => c || `Coluna ${i + 1}`) : table[0].map((_, i) => `Coluna ${i + 1}`)
    return { needsMapping: true, headers, sample: table.slice(hi + 1, hi + 4), table, headerIndex: hi }
  }

  const rows = []
  const seen = {}
  for (const r of table.slice(hi + 1)) {
    const date = parseDate(r[col.date])
    if (!date) continue
    let amount = col.amount >= 0 ? parseMoney(r[col.amount]) : null
    if (amount === null) {
      const deb = col.debit >= 0 ? parseMoney(r[col.debit]) : null
      const cre = col.credit >= 0 ? parseMoney(r[col.credit]) : null
      amount = (cre ? Math.abs(cre) : 0) - (deb ? Math.abs(deb) : 0)
    } else if (col.type >= 0 && /debit|withdraw|^dr$/i.test(r[col.type] || '') && amount > 0) {
      amount = -amount
    }
    if (!amount) continue
    const description = (col.desc >= 0 ? r[col.desc] : '') || 'Lançamento'
    const base = `${date}|${amount.toFixed(2)}|${description.toUpperCase().replace(/\s+/g, ' ')}`
    seen[base] = (seen[base] || 0) + 1 // mesma linha repetida no mesmo dia continua única
    rows.push({ date, amount: Math.round(amount * 100) / 100, description, reference: `csv:${base}#${seen[base]}` })
  }
  return { rows }
}

// Usa o mapeamento escolhido pelo usuário (índices das colunas)
export function parseWithMapping(text, mapping) {
  return parseCsv(text, { date: mapping.date, desc: mapping.desc ?? -1, amount: mapping.amount ?? -1, debit: mapping.debit ?? -1, credit: mapping.credit ?? -1, type: -1 })
}

export function parseStatement(text, fileName = '') {
  if (/\.(ofx|qfx|qbo)$/i.test(fileName) || /<OFX>|<STMTTRN>/i.test(text)) return { rows: parseOfx(text), format: 'OFX' }
  return { ...parseCsv(text), format: 'CSV' }
}
