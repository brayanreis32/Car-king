// Contrato de venda para imprimir e o cliente assinar.
// Parcelada: "Retail Installment Sale Contract" com o quadro de divulgação
// (APR, finance charge, amount financed, total of payments, total sale price),
// tabela de parcelas e multa por atraso. À vista: "Vehicle Purchase Agreement
// and Bill of Sale". Textos em inglês (documento legal nos EUA).
import { Link, useParams } from 'react-router-dom'
import { q, supabase, vehicleName } from '../lib.js'
import { ErrorBox, Icon, Spinner, useLoad } from '../components/ui.jsx'
import { Attachments } from '../components/attachments.jsx'
import { useApp } from '../App.jsx'

const usd = (v) => (v === null || v === undefined ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(v)))
const usDate = (v) => { if (!v) return '____/____/______'; const [y, m, d] = String(v).slice(0, 10).split('-'); return `${m}/${d}/${y}` }
const FREQ = { weekly: 'weekly', biweekly: 'every two weeks', monthly: 'monthly' }
const TITLE = { clean: 'Clean', rebuilt: 'Rebuilt', salvage: 'Salvage', flood: 'Flood', lemon_buyback: 'Lemon buyback', other: 'Other', unknown: '____________' }
const PAY = { cash: 'Cash', check: 'Check', wire: 'Wire transfer', zelle: 'Zelle', card: 'Card', financing: 'Bank financing', mixed: 'Mixed', other: 'Other' }
const blank = (v, w = 180) => (v ? <span>{v}</span> : <span className="ct-blank" style={{ width: w }} />)

export default function Contract() {
  const { saleId } = useParams()
  const { company, can } = useApp()
  const { data, error, loading, reload } = useLoad(async () => {
    const sale = await q(supabase.from('sales').select('*, customers(*), vehicles(*)').eq('id', saleId).single())
    const schedule = await q(supabase.from('accounts_receivable').select('installment_number, due_date, amount')
      .eq('sale_id', saleId).neq('status', 'cancelled').order('installment_number', { nullsFirst: true }).order('due_date'))
    return { sale, schedule }
  }, [saleId])

  if (loading && !data) return <Spinner />
  if (error) return <ErrorBox error={error} />
  const { sale, schedule } = data
  const c = sale.customers || {}
  const v = sale.vehicles || {}
  const parcelado = sale.installments > 1
  const installments = schedule.filter((r) => (r.installment_number || 0) > 0)
  const financed = Number(sale.financed_amount ?? (Number(sale.final_price) - Number(sale.down_payment)))
  const totalPayments = Number(sale.total_with_interest ?? financed)
  const financeCharge = Math.max(0, totalPayments - financed)
  const dealerAddress = [company.address, [company.city, [company.state, company.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ')
  const buyerAddress = [c.address, c.address2, [c.city, [c.state, c.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].filter(Boolean).join(', ')
  const contractNo = `${v.stock_number || 'CK'}-${String(sale.sale_date).replace(/-/g, '')}`
  const dealerName = company.legal_name || company.name
  const fee = Number(company.late_fee_pct ?? 5)
  const grace = Number(company.late_fee_grace_days ?? 15)
  const missing = [
    !company.address && 'endereço da empresa', !company.dealer_license && 'número da licença de dealer',
    !c.address && 'endereço do cliente', !c.document_id && 'driver license do cliente', !v.odometer && 'milhas do carro',
  ].filter(Boolean)

  return (
    <div className="stack">
      <div className="no-print stack">
        <Link to={`/veiculos/${v.id}?tab=sale`} className="back"><Icon name="back" size={16} /> {vehicleName(v)}</Link>
        <div className="page-head" style={{ marginBottom: 0 }}>
          <div>
            <h1>Contrato de venda</h1>
            <div className="muted small">{parcelado ? 'Venda parcelada · Retail Installment Sale Contract' : 'Venda à vista · Vehicle Purchase Agreement'} · {c.full_name}</div>
          </div>
          <button className="btn-primary" onClick={() => window.print()}>Imprimir / salvar PDF</button>
        </div>
        {missing.length > 0 && (
          <div className="alert-box warning small">
            Faltam dados no contrato: <b>{missing.join(', ')}</b>. Os campos ficam em branco para preencher à mão,
            ou complete em {can('settings', 'edit') ? <Link to="/configuracoes">Configurações</Link> : 'Configurações'} e na ficha do <Link to={`/clientes/${c.id}`}>cliente</Link>.
          </div>
        )}
        <div className="alert-box info small">
          Modelo de contrato preparado para Massachusetts. Antes de usar com clientes, peça para um advogado revisar uma vez.
          Para vender parcelado e ficar com o contrato (buy here, pay here), a lei de MA exige a licença de Motor Vehicle Sales Finance Company (Division of Banks).
        </div>
      </div>

      <article className="contract">
        <header className="ct-head">
          <img src="./logo.jpg" alt="Car King Auto Sales" />
          <div className="ct-dealer">
            <b>{dealerName}</b>
            {dealerAddress && <div>{dealerAddress}</div>}
            <div>{[company.phone, company.email].filter(Boolean).join(' · ')}</div>
            <div>Dealer License #: {blank(company.dealer_license, 120)}{company.finance_license ? ` · Sales Finance License #: ${company.finance_license}` : ''}</div>
          </div>
        </header>

        <h1 className="ct-title">{parcelado ? 'Retail Installment Sale Contract' : 'Vehicle Purchase Agreement and Bill of Sale'}</h1>
        <div className="ct-meta"><span>Contract No. {contractNo}</span><span>Date: {usDate(sale.sale_date)}</span></div>

        <section className="ct-grid2">
          <div className="ct-box">
            <h3>Buyer</h3>
            <div className="ct-line"><span>Name</span>{blank(c.full_name)}</div>
            <div className="ct-line"><span>Address</span>{blank(buyerAddress, 260)}</div>
            <div className="ct-line"><span>Phone</span>{blank(c.phone)}</div>
            <div className="ct-line"><span>E-mail</span>{blank(c.email)}</div>
            <div className="ct-line"><span>Driver License</span>{blank([c.document_id, c.license_state].filter(Boolean).join(' · '))}</div>
            <div className="ct-line"><span>Co-Buyer</span>{blank(null, 220)}</div>
          </div>
          <div className="ct-box">
            <h3>Vehicle (Used)</h3>
            <div className="ct-line"><span>Year / Make / Model</span>{blank([v.year, v.make, v.model, v.trim].filter(Boolean).join(' '))}</div>
            <div className="ct-line"><span>VIN</span>{blank(v.vin)}</div>
            <div className="ct-line"><span>Color</span>{blank(v.color)}</div>
            <div className="ct-line"><span>Odometer</span>{blank(v.odometer ? `${new Intl.NumberFormat('en-US').format(v.odometer)} ${v.odometer_unit === 'km' ? 'km' : 'miles'}` : null)}</div>
            <div className="ct-line"><span>Title</span><span>{TITLE[v.title_status] || '____________'}{v.title_state ? ` (${v.title_state})` : ''}</span></div>
            <div className="ct-line"><span>Stock #</span>{blank(v.stock_number)}</div>
          </div>
        </section>

        {parcelado ? (
          <>
            <section className="ct-tila">
              <div><b>Annual Percentage Rate</b><small>The cost of your credit as a yearly rate.</small><strong>{Number(sale.interest_rate_apr || 0).toFixed(2)}%</strong></div>
              <div><b>Finance Charge</b><small>The dollar amount the credit will cost you.</small><strong>{usd(financeCharge)}</strong></div>
              <div><b>Amount Financed</b><small>The amount of credit provided to you or on your behalf.</small><strong>{usd(financed)}</strong></div>
              <div><b>Total of Payments</b><small>The amount you will have paid after all payments as scheduled.</small><strong>{usd(totalPayments)}</strong></div>
              <div><b>Total Sale Price</b><small>The total cost of your purchase on credit, including your down payment of {usd(sale.down_payment)}.</small><strong>{usd(Number(sale.down_payment) + totalPayments)}</strong></div>
            </section>

            <section className="ct-grid2">
              <div className="ct-box">
                <h3>Payment Schedule</h3>
                <p>Your payment schedule will be: <b>{installments.length || sale.installments}</b> payments of <b>{usd(sale.installment_amount)}</b>, due <b>{FREQ[sale.installment_frequency] || 'monthly'}</b>, beginning on <b>{usDate(installments[0]?.due_date || sale.first_due_date)}</b>.</p>
                <p><b>Late Charge:</b> if any payment is not paid in full within <b>{grace} days</b> after it is due, you will pay a late charge of <b>{fee}% of the unpaid amount of that payment</b>.</p>
                <p><b>Prepayment:</b> you may pay off all or part of this contract at any time without penalty.</p>
                <p><b>Security:</b> you are giving the Seller a security interest in the vehicle being purchased.</p>
              </div>
              <div className="ct-box">
                <h3>Itemization of Amount Financed</h3>
                <div className="ct-row"><span>1. Cash Price of Vehicle</span><span>{usd(sale.final_price)}</span></div>
                <div className="ct-row"><span>2. Down Payment</span><span>− {usd(sale.down_payment)}</span></div>
                <div className="ct-row"><span>3. Unpaid Balance of Cash Price (1 − 2)</span><span>{usd(Number(sale.final_price) - Number(sale.down_payment))}</span></div>
                <div className="ct-row"><span>4. Other Charges</span><span>{usd(financed - (Number(sale.final_price) - Number(sale.down_payment)))}</span></div>
                <div className="ct-row total"><span>5. Amount Financed (3 + 4)</span><span>{usd(financed)}</span></div>
                <p className="ct-small">Sales tax, title and registration fees are not included above unless itemized and are the Buyer's responsibility.</p>
              </div>
            </section>

            {installments.length > 0 && (
              <section className="ct-box">
                <h3>Installment Schedule</h3>
                <div className="ct-sched">
                  {installments.map((r) => (
                    <div key={r.installment_number}><span>#{r.installment_number}</span><span>{usDate(r.due_date)}</span><span>{usd(r.amount)}</span></div>
                  ))}
                </div>
              </section>
            )}

            <section className="ct-terms">
              <h3>Terms and Conditions</h3>
              <ol>
                <li><b>Promise to Pay.</b> Buyer buys the vehicle described above on credit and promises to pay the Seller the Amount Financed plus the Finance Charge according to the Payment Schedule. Payments are applied first to late charges, then to the Finance Charge, then to the Amount Financed.</li>
                <li><b>Late Charge.</b> If any payment is not received in full within {grace} days after its due date, Buyer agrees to pay a late charge of {fee}% of the unpaid amount of that payment, as permitted by Massachusetts law. Only one late charge may be collected on any single payment.</li>
                <li><b>Security Interest.</b> Buyer grants Seller a security interest in the vehicle, its accessories and any insurance proceeds until all amounts under this contract are paid. Seller will be listed as lienholder on the certificate of title.</li>
                <li><b>Insurance.</b> Until this contract is paid in full, Buyer must keep the vehicle insured with liability, collision and comprehensive coverage, naming Seller as loss payee, and give Seller proof of insurance on request.</li>
                <li><b>Use and Transfer.</b> Buyer will keep the vehicle in good condition, will not use it illegally, and will not sell, rent or transfer it, or remove it from the United States, without Seller's written consent until paid in full.</li>
                <li><b>Default.</b> Buyer is in default if Buyer fails to make a payment when due, gives false information in connection with this contract, or fails to keep the vehicle insured. In case of default, Seller may exercise the rights allowed by Massachusetts law (G.L. c. 255B), including, after any notice of default and right to cure required by law, declaring the unpaid balance due and repossessing the vehicle.</li>
                <li><b>Prepayment.</b> Buyer may prepay this contract in full or in part at any time without penalty. Buyer will not pay finance charges for the time after the balance is paid.</li>
                <li><b>Warranty.</b> The Massachusetts Used Vehicle Warranty Law (G.L. c. 90, § 7N¼) may apply to this sale. The FTC Buyers Guide displayed on the vehicle is part of this contract and overrides any contrary provision.</li>
                <li><b>Odometer.</b> Seller states that, to the best of Seller's knowledge, the odometer reading above reflects the actual mileage unless otherwise noted: ______________________.</li>
                <li><b>Entire Agreement.</b> This contract, the Buyers Guide and the documents signed with it are the entire agreement between Buyer and Seller. Any change must be in writing and signed by both. This contract is governed by the laws of the Commonwealth of Massachusetts.</li>
                {company.contract_terms && <li><b>Additional Terms.</b> <span style={{ whiteSpace: 'pre-wrap' }}>{company.contract_terms}</span></li>}
              </ol>
            </section>

            <section className="ct-notice">
              <b>NOTICE TO THE BUYER:</b> (1) Do not sign this contract before you read it or if it contains any blank spaces. (2) You are entitled to an exact copy of the contract you sign. Keep it to protect your legal rights. (3) You may prepay the full amount at any time.
            </section>
          </>
        ) : (
          <>
            <section className="ct-grid2">
              <div className="ct-box">
                <h3>Purchase Price</h3>
                <div className="ct-row"><span>Cash Price of Vehicle</span><span>{usd(sale.final_price)}</span></div>
                <div className="ct-row"><span>Amount Paid</span><span>{usd(sale.down_payment)}</span></div>
                <div className="ct-row total"><span>Balance Due</span><span>{usd(Math.max(0, Number(sale.final_price) - Number(sale.down_payment)))}</span></div>
                <div className="ct-row"><span>Payment Method</span><span>{PAY[sale.payment_method] || '____________'}</span></div>
                <p className="ct-small">Sales tax, title and registration fees are not included above unless itemized and are the Buyer's responsibility.</p>
              </div>
              <div className="ct-box">
                <h3>Bill of Sale</h3>
                <p>For the price above, receipt of which is acknowledged {Number(sale.down_payment) >= Number(sale.final_price) ? 'in full' : 'as stated'}, Seller sells and transfers to Buyer the vehicle described above. Seller states that it is the lawful owner of the vehicle, that it has the right to sell it, and that the vehicle is free of liens and encumbrances, and agrees to deliver a properly assigned certificate of title.</p>
              </div>
            </section>
            <section className="ct-terms">
              <h3>Terms and Conditions</h3>
              <ol>
                <li><b>Payment.</b> Title and possession pass to Buyer when the full price is paid. Any balance due must be paid before delivery unless agreed in writing.</li>
                <li><b>Warranty.</b> The Massachusetts Used Vehicle Warranty Law (G.L. c. 90, § 7N¼) may apply to this sale. The FTC Buyers Guide displayed on the vehicle is part of this agreement and overrides any contrary provision.</li>
                <li><b>Odometer.</b> Seller states that, to the best of Seller's knowledge, the odometer reading above reflects the actual mileage unless otherwise noted: ______________________.</li>
                <li><b>Title Status.</b> Buyer acknowledges having been informed of the title status shown above{['rebuilt', 'salvage', 'flood'].includes(v.title_status) ? ', including that the vehicle has a branded title' : ''}.</li>
                <li><b>Registration.</b> Buyer is responsible for registering the vehicle and for any sales tax and fees due at registration, unless itemized above.</li>
                <li><b>Entire Agreement.</b> This agreement, the Buyers Guide and the documents signed with it are the entire agreement between Buyer and Seller, governed by the laws of the Commonwealth of Massachusetts.</li>
                {company.contract_terms && <li><b>Additional Terms.</b> <span style={{ whiteSpace: 'pre-wrap' }}>{company.contract_terms}</span></li>}
              </ol>
            </section>
          </>
        )}

        <section className="ct-sign">
          <div><div className="ct-sigline" /><span>Buyer signature · Date</span><small>{c.full_name}</small></div>
          <div><div className="ct-sigline" /><span>Co-Buyer signature · Date</span></div>
          <div><div className="ct-sigline" /><span>Seller (authorized representative) · Date</span><small>{dealerName}</small></div>
        </section>
        <p className="ct-small center">Buyer acknowledges receiving a completely filled-in copy of this {parcelado ? 'contract' : 'agreement'} and the Buyers Guide.</p>
      </article>

      <div className="card no-print">
        <Attachments entityType="sale" entityId={sale.id} vehicleId={v.id} kind="document" onChange={reload}
          title={sale.contract_signed_at ? 'Contrato assinado ✓' : 'Depois de assinado: anexe o contrato (foto ou PDF)'} />
      </div>
    </div>
  )
}
