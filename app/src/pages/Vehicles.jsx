import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { label, money, q, supabase, VEHICLE_STATUS_TONE, vehicleName } from '../lib.js'
import { Badge, Empty, ErrorBox, Spinner, Tabs, useLoad } from '../components/ui.jsx'

const GROUPS = {
  prep: ['purchased', 'awaiting_pickup', 'in_transit', 'received', 'in_inspection', 'in_preparation', 'awaiting_parts', 'in_repair', 'in_detailing'],
  sale: ['ready_for_sale', 'listed', 'reserved'],
  sold: ['sold'],
}

export default function Vehicles() {
  const nav = useNavigate()
  const [tab, setTab] = useState('prep')
  const { data, error, loading } = useLoad(async () => {
    const [vehicles, profit] = await Promise.all([
      q(supabase.from('vehicles').select('id, stock_number, vin, year, make, model, trim, status, purchased_at').order('purchased_at', { ascending: false })),
      q(supabase.from('vehicle_profit_analysis').select('vehicle_id, actual_cost, projected_cost, projected_profit, real_profit, expected_sale_price, sale_price, days_since_purchase')),
    ])
    const byId = Object.fromEntries((profit || []).map((p) => [p.vehicle_id, p]))
    return vehicles.map((v) => ({ ...v, p: byId[v.id] || {} }))
  })

  const rows = (data || []).filter((v) => GROUPS[tab].includes(v.status))
  const count = (g) => (data || []).filter((v) => GROUPS[g].includes(v.status)).length

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Veículos</h1><div className="muted small">Do arremate até a venda</div></div>
      </div>
      <Tabs tabs={[['prep', `Em preparação (${count('prep')})`], ['sale', `À venda (${count('sale')})`], ['sold', `Vendidos (${count('sold')})`]]} active={tab} onChange={setTab} />

      {loading ? <Spinner /> : error ? <ErrorBox error={error} /> : rows.length === 0 ? (
        <div className="card"><Empty title="Nenhum veículo aqui">Os carros aparecem quando você registra a compra no Auction Analyzer.</Empty></div>
      ) : (
        <div className="card pad-0">
          <div className="table-wrap hide-mobile">
            <table>
              <thead><tr>
                <th>Veículo</th><th>Estoque</th><th>Status</th><th className="num">Dias</th>
                <th className="num">Investido</th><th className="num">Custo projetado</th><th className="num">Venda</th><th className="num">Lucro</th>
              </tr></thead>
              <tbody>
                {rows.map((v) => {
                  const profit = v.status === 'sold' ? v.p.real_profit : v.p.projected_profit
                  return (
                    <tr key={v.id} className="clickable" onClick={() => nav(`/veiculos/${v.id}`)}>
                      <td><b>{vehicleName(v)}</b><div className="muted small">{v.vin}</div></td>
                      <td>{v.stock_number || '—'}</td>
                      <td><Badge tone={VEHICLE_STATUS_TONE[v.status]}>{label('vehicle_status', v.status)}</Badge></td>
                      <td className="num">{v.p.days_since_purchase ?? '—'}</td>
                      <td className="num">{money(v.p.actual_cost)}</td>
                      <td className="num">{money(v.p.projected_cost)}</td>
                      <td className="num">{money(v.status === 'sold' ? v.p.sale_price : v.p.expected_sale_price)}</td>
                      <td className={`num ${Number(profit) < 0 ? 'neg' : 'pos'}`}><b>{money(profit)}</b></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="list only-mobile">
            {rows.map((v) => {
              const profit = v.status === 'sold' ? v.p.real_profit : v.p.projected_profit
              return (
                <div key={v.id} className="list-item" onClick={() => nav(`/veiculos/${v.id}`)}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row between"><b>{vehicleName(v)}</b><Badge tone={VEHICLE_STATUS_TONE[v.status]}>{label('vehicle_status', v.status)}</Badge></div>
                    <div className="muted small">{v.stock_number ? `${v.stock_number} · ` : ''}{v.p.days_since_purchase ?? 0} dias</div>
                    <div className="row between small" style={{ marginTop: 6 }}>
                      <span>Investido <b>{money(v.p.actual_cost)}</b></span>
                      <span>Lucro <b className={Number(profit) < 0 ? 'neg' : 'pos'}>{money(profit)}</b></span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
