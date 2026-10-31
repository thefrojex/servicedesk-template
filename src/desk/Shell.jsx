import { createContext, useContext, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { CalendarClock, ClipboardList, Users, Wrench } from 'lucide-react'
import Toasts from './components/Toasts.jsx'
import { useComplaints, useLiveActivity, useSettings } from './data.js'

// What changed outside this screen in the last moment: { complaints: { id: { via, action } }, ... }
const LiveContext = createContext({ live: {}, toast: () => {} })
export const useLive = () => useContext(LiveContext)

const LIVE_MS = 3200
const TOAST_MS = 5000
const statusWord = { open: 'Open', assigned: 'Assigned', closed: 'Closed' }

export default function Shell({ accountMenu, children }) {
  const [live, setLive] = useState({})
  const [toasts, setToasts] = useState([])
  const settings = useSettings()
  const complaints = useComplaints()

  const toast = (message, kind = 'success', action) => {
    const id = crypto.randomUUID()
    setToasts((ts) => [...ts.slice(-2), { id, message, kind, action, duration: TOAST_MS }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), TOAST_MS)
  }

  // Someone else (usually WhatsApp) changed something: light it up for a moment and say what.
  useLiveActivity((entries) => {
    const lit = { complaints: {}, customers: {}, amc: {} }
    for (const e of entries) {
      if (e.complaint_id) lit.complaints[e.complaint_id] = { via: e.via, action: e.action }
      if (e.entity_type === 'customer') lit.customers[e.entity_id] = { via: e.via, action: e.action }
      if (e.entity_type === 'amc_contract') lit.amc[e.entity_id] = { via: e.via, action: e.action }
    }
    setLive(lit)
    setTimeout(() => setLive({}), LIVE_MS)

    const fromWhatsapp = entries.some((e) => e.via === 'whatsapp')
    const main = entries.find((e) => e.entity_type === 'complaint') ?? entries[0]
    const label = main.entity_type === 'complaint'
      ? `#${main.changes?.ticket_no?.[1] ?? complaints.data?.find((c) => c.id === main.entity_id)?.ticket_no ?? ''} ${main.action === 'created' ? 'logged' : `→ ${statusWord[main.action] ?? 'updated'}`}`
      : main.entity_type === 'amc_contract' ? `${entries.filter((e) => e.entity_type === 'amc_contract').length} AMC${entries.filter((e) => e.entity_type === 'amc_contract').length === 1 ? '' : 's'} updated`
      : `${main.entity_type} ${main.action}`
    toast(`${fromWhatsapp ? 'From WhatsApp' : 'Updated by the team'}: ${label}`, fromWhatsapp ? 'whatsapp' : 'info')
  })

  const tabs = [
    { to: '/', label: 'Complaints', icon: ClipboardList },
    { to: '/customers', label: 'Customers', icon: Users },
    { to: '/amc', label: 'AMC', icon: CalendarClock },
  ]

  return (
    <LiveContext.Provider value={{ live, toast }}>
      <div className="page">
        <header className="topbar">
          <div className="topbar-left">
            <div className="brand-icon"><Wrench size={20} strokeWidth={2.2} /></div>
            <div className="desk-brand">
              <h1 className="page-title">{settings.data?.business_name ?? 'Service Desk'}</h1>
              <span className="desk-brand-sub">Service Desk</span>
            </div>
            <nav className="desk-tabs">
              {tabs.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} end className={({ isActive }) => `desk-tab ${isActive ? 'is-active' : ''}`}>
                  <Icon size={15} /> {label}
                </NavLink>
              ))}
            </nav>
          </div>
          <div className="topbar-right">{accountMenu}</div>
        </header>
        {children}
      </div>
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((ts) => ts.filter((t) => t.id !== id))} />
    </LiveContext.Provider>
  )
}
