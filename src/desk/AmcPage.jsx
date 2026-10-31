import { useState } from 'react'
import { AlertTriangle, BellRing, CalendarClock, CheckCircle2, RefreshCw } from 'lucide-react'
import { useAmcs, useSave } from './data.js'
import { day, daysUntil, inr } from './format.js'
import { useLive } from './Shell.jsx'

const views = [
  { key: 'due', label: 'Due in 30 days', test: (a) => !a.renewed_at && daysUntil(a.end_date) >= 0 && daysUntil(a.end_date) <= 30 },
  { key: 'lapsed', label: 'Lapsed, not renewed', test: (a) => !a.renewed_at && daysUntil(a.end_date) < 0 },
  { key: 'active', label: 'Active', test: (a) => !a.renewed_at && daysUntil(a.end_date) > 30 },
  { key: 'all', label: 'All', test: () => true },
]

export default function AmcPage() {
  const amcs = useAmcs()
  const save = useSave('amc_contracts')
  const { live, toast } = useLive()
  const [view, setView] = useState('due')
  const list = amcs.data ?? []
  const sum = (rows) => rows.reduce((total, a) => total + Number(a.value), 0)
  const due = list.filter(views[0].test)
  const lapsed = list.filter(views[1].test)
  const visible = list.filter(views.find((v) => v.key === view).test)

  const remind = async (rows) => {
    const now = new Date().toISOString()
    for (const a of rows) await save.mutateAsync({ id: a.id, values: { reminder_sent_at: now } })
    toast(`${rows.length} marked for a renewal reminder`)
  }
  const renew = async (a) => {
    const start = new Date(`${a.end_date}T00:00`)
    start.setDate(start.getDate() + 1)
    const end = new Date(start)
    end.setFullYear(end.getFullYear() + 1)
    end.setDate(end.getDate() - 1)
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    await save.mutateAsync({ id: a.id, values: { renewed_at: new Date().toISOString() } })
    await save.mutateAsync({ values: { customer_id: a.customer.id, machine_id: a.machine?.id ?? null, start_date: iso(start), end_date: iso(end), value: a.value } })
    toast(`${a.customer.name}: AMC renewed till ${day(iso(end))}`)
  }

  return (
    <>
      <section className="stats">
        <button type="button" className={`stat stat-blue is-clickable ${view === 'due' ? 'is-active' : ''}`} onClick={() => setView('due')}>
          <span className="stat-icon"><CalendarClock size={17} /></span>
          <span className="stat-text"><span className="stat-label">Renewals due in 30 days</span><span className="stat-value">{inr(sum(due)) || '₹0'} · {due.length}</span></span>
        </button>
        <button type="button" className={`stat stat-red is-clickable ${view === 'lapsed' ? 'is-active' : ''}`} onClick={() => setView('lapsed')}>
          <span className="stat-icon"><AlertTriangle size={17} /></span>
          <span className="stat-text"><span className="stat-label">Lapsed, not renewed</span><span className="stat-value">{inr(sum(lapsed)) || '₹0'} · {lapsed.length}</span></span>
        </button>
        <div className="stat stat-green">
          <span className="stat-icon"><CheckCircle2 size={17} /></span>
          <span className="stat-text"><span className="stat-label">Active contracts</span><span className="stat-value">{list.filter((a) => !a.renewed_at && daysUntil(a.end_date) >= 0).length}</span></span>
        </div>
        <div className="stat">
          <span className="stat-icon"><BellRing size={17} /></span>
          <span className="stat-text"><span className="stat-label">Due, not yet reminded</span><span className="stat-value">{due.filter((a) => !a.reminder_sent_at).length}</span></span>
        </div>
      </section>

      <section className="desk-toolbar">
        <nav className="filter-pills">
          {views.map((v) => (
            <button key={v.key} type="button" className={`pill ${view === v.key ? 'pill-active' : ''}`} onClick={() => setView(v.key)}>
              {v.label} <span className="pill-count">{list.filter(v.test).length}</span>
            </button>
          ))}
        </nav>
        {view === 'due' && due.some((a) => !a.reminder_sent_at) && (
          <button type="button" className="primary-btn" disabled={save.isPending} onClick={() => remind(due.filter((a) => !a.reminder_sent_at))}><BellRing size={16} /> <span>Remind all due</span></button>
        )}
      </section>

      <section className="desk-card">
        {amcs.isLoading ? <p className="desk-empty">Loading AMCs…</p>
          : amcs.error ? <p className="desk-empty">Couldn’t load AMCs: {amcs.error.message}</p>
          : visible.length === 0 ? <p className="desk-empty">Nothing here.</p>
          : (
            <table className="desk-table">
              <thead><tr><th>Customer</th><th>Machine</th><th>Ends</th><th>Value</th><th>Reminder</th><th /></tr></thead>
              <tbody>
                {visible.map((a) => {
                  const left = daysUntil(a.end_date)
                  const lit = live.amc?.[a.id]
                  return (
                    <tr key={a.id} className={lit ? `live-row live-${lit.via}` : ''}>
                      <td><div className="desk-strong">{a.customer?.name}</div><div className="desk-muted">{a.customer?.area}</div></td>
                      <td className="desk-muted">{a.machine?.model ?? '—'}</td>
                      <td className={a.renewed_at ? 'desk-muted' : left < 0 ? 'desk-late' : left <= 30 ? 'desk-soon' : 'desk-muted'}>
                        {day(a.end_date)} · {a.renewed_at ? 'renewed' : left < 0 ? `lapsed ${-left} days ago` : left === 0 ? 'today' : `in ${left} days`}
                      </td>
                      <td className="desk-strong">{inr(a.value)}</td>
                      <td className="desk-muted">{a.reminder_sent_at ? 'Marked' : '—'}</td>
                      <td className="desk-actions">
                        {!a.renewed_at && !a.reminder_sent_at && left <= 30 && <button type="button" className="btn-secondary" disabled={save.isPending} onClick={() => remind([a])}>Remind</button>}
                        {!a.renewed_at && <button type="button" className="btn-secondary" disabled={save.isPending} onClick={() => renew(a)}><RefreshCw size={13} /> Renewed</button>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </section>
    </>
  )
}
