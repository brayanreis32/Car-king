import { createContext, useContext, useEffect, useState } from 'react'
import { HashRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { isConfigured, q, supabase } from './lib.js'
import { Brand, Icon, Spinner, ToastProvider } from './components/ui.jsx'
import Login, { CreateCompany } from './pages/Login.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Auctions from './pages/Auctions.jsx'
import AuctionDetail from './pages/AuctionDetail.jsx'
import Vehicles from './pages/Vehicles.jsx'
import VehicleDetail from './pages/VehicleDetail.jsx'
import Settings from './pages/Settings.jsx'
import Finance from './pages/Finance.jsx'

const AppCtx = createContext(null)
export const useApp = () => useContext(AppCtx)

export default function App() {
  if (!isConfigured) return <NotConfigured />
  return (
    <ToastProvider>
      <AuthGate />
    </ToastProvider>
  )
}

function AuthGate() {
  const [session, setSession] = useState(undefined)
  const [ctx, setCtx] = useState(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadProfile = async () => {
    if (!session) { setCtx(undefined); return }
    try {
      const profile = await q(supabase.from('profiles').select('*, roles(code, name)').eq('id', session.user.id).maybeSingle())
      if (!profile) { setCtx(null); return }
      const [company, perms] = await Promise.all([
        q(supabase.from('companies').select('*').eq('id', profile.company_id).single()),
        q(supabase.rpc('my_permissions')),
      ])
      const can = (module, action = 'view') => Boolean(perms.find((p) => p.module === module)?.[`can_${action}`])
      setCtx({ session, profile, company, can, reloadCompany: loadProfile })
    } catch (e) {
      setCtx({ error: e })
    }
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadProfile() }, [session?.user?.id])

  if (session === undefined) return <Spinner />
  if (!session) return <Login />
  if (ctx === undefined) return <Spinner />
  if (ctx === null) return <CreateCompany onDone={loadProfile} />
  if (ctx.error) return <div className="login"><div className="alert-box error">{ctx.error.message}</div></div>

  return (
    <AppCtx.Provider value={ctx}>
      <HashRouter>
        <Shell />
      </HashRouter>
    </AppCtx.Provider>
  )
}

const MENU = [
  { to: '/', icon: 'dashboard', text: 'Dashboard', short: 'Início', module: 'dashboard', end: true },
  { to: '/leiloes', icon: 'gavel', text: 'Auction Analyzer', short: 'Leilões', module: 'auction' },
  { to: '/veiculos', icon: 'car', text: 'Veículos', short: 'Veículos', module: 'vehicles' },
  { to: '/financeiro', icon: 'money', text: 'Financeiro', short: 'Financeiro', module: 'finance' },
  { to: '/configuracoes', icon: 'settings', text: 'Configurações', short: 'Ajustes', module: 'settings' },
]

function Shell() {
  const { profile, company, can } = useApp()
  const menu = MENU.filter((m) => can(m.module))
  return (
    <div className="shell">
      <header className="mobile-top"><img src="./logo.webp" alt="Car King Auto Sales" /></header>
      <aside className="sidebar">
        <div className="brand"><Brand /></div>
        <nav className="nav">
          {menu.map((m) => (
            <NavLink key={m.to} to={m.to} end={m.end}><Icon name={m.icon} />{m.text}</NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">{profile.full_name}</div>
          <div>{profile.roles?.name} · {company.name}</div>
          <button className="btn-sm" onClick={() => supabase.auth.signOut()}><Icon name="logout" /> Sair</button>
        </div>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/leiloes" element={<Auctions />} />
          <Route path="/leiloes/:id" element={<AuctionDetail />} />
          <Route path="/veiculos" element={<Vehicles />} />
          <Route path="/veiculos/:id" element={<VehicleDetail />} />
          <Route path="/financeiro" element={<Finance />} />
          <Route path="/configuracoes" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
      <nav className="bottom-nav">
        {menu.map((m) => (
          <NavLink key={m.to} to={m.to} end={m.end}><Icon name={m.icon} />{m.short}</NavLink>
        ))}
      </nav>
    </div>
  )
}

function NotConfigured() {
  return (
    <div className="login">
      <div className="login-card card stack">
        <Brand big />
        <div className="alert-box warning">
          Falta configurar a chave do Supabase. Coloque a <b>anon public key</b> em <code>app/src/config.js</code>.
        </div>
      </div>
    </div>
  )
}
