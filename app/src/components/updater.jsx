// Avisa quando há versão nova do sistema publicada (o celular às vezes deixa o
// app aberto em segundo plano por dias). Confere ao voltar para o app e a cada 5 min.
import { useEffect, useState } from 'react'

const current = () => document.querySelector('script[type="module"][src*="assets/index-"]')?.getAttribute('src')?.split('/').pop()

export function UpdateBanner() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const mine = current()
    if (!mine) return undefined // modo de desenvolvimento
    let busy = false
    const check = async () => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const html = await (await fetch(`./index.html?v=${Date.now()}`, { cache: 'no-store' })).text()
        const latest = html.match(/assets\/(index-[^"']+\.js)/)?.[1]
        if (latest && latest !== mine) setReady(true)
      } catch { /* sem internet: tenta depois */ } finally { busy = false }
    }
    check()
    const t = setInterval(check, 5 * 60 * 1000)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [])
  if (!ready) return null
  return (
    <button className="update-banner" onClick={() => window.location.reload()}>
      Nova versão do sistema disponível — <b>toque aqui para atualizar</b>
    </button>
  )
}

export const BUILD = typeof __BUILD__ !== 'undefined' ? __BUILD__ : 'dev'
