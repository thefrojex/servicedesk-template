import { useMemo, useState } from 'react'
import { AlertCircle, CheckCircle2, Clock, IndianRupee, MessageCircle, Plus, Search, UserX, X } from 'lucide-react'
import { useComplaintHistory, useComplaints, useCustomers, useEngineers, useSave } from './data.js'
import { age, inr, isOld, statusLabel, when } from './format.js'
import { useLive } from './Shell.jsx'

const filters = [
  { key: 'pending', label: 'Pending', test: (c) => c.status !== 'closed' },
  { key: 'open', label: 'Not assigned', test: (c) => c.status === 'open' },
  { key: 'old', label: 'Over 2 days', test: isOld },
  { key: 'closed', label: 'Closed', test: (c) => c.status === 'closed' },
  { key: 'all', label: 'All', test: () => true },
]

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d
}

function Stat({ icon: Icon, label, value, tone, onClick, active }) {
  return (
    <button type="button" className={`stat stat-${tone} ${onClick ? 'is-clickable' : ''} ${active ? 'is-active' : ''}`} onClick={onClick}>
      <span className="stat-icon"><Icon size={17} /></span>
      <span className="stat-text">
        <span className="stat-label">{label}</span>
        <span className="stat-value">{value}</span>
      </span>
    </button>
  )
}

export default function ComplaintsPage() {
  const complaints = useComplaints()
  const { live } = useLive()
  const [filter, setFilter] = useState('pending')
  const [search, setSearch] = useState('')
  const [engineerFilter, setEngineerFilter] = useState('all')
  const [selected, setSelected] = useState(null) // complaint id, 'new' or null

  const list = complaints.data ?? []
  const today = startOfToday()
  const pending = list.filter((c) => c.status !== 'closed')
  const closedToday = list.filter((c) => c.status === 'closed' && new Date(c.closed_at) >= today)
  const counts = Object.fromEntries(filters.map((f) => [f.key, list.filter(f.test).length]))

  const engineersWithWork = useMemo(() => {
    const byName = new Map()
    for (const c of pending) if (c.engineer) byName.set(c.engineer.name, (byName.get(c.engineer.name) ?? 0) + 1)
    return [...byName.entries()].sort((a, b) => b[1] - a[1])
  }, [pending])

  const q = search.trim().toLowerCase()
  const visible = list
    .filter(filters.find((f) => f.key === filter).test)
    .filter((c) => engineerFilter === 'all' || c.engineer?.name === engineerFilter)
    .filter((c) => !q || [c.customer?.name, c.customer?.area, c.machine?.model, c.problem, c.engineer?.name, `#${c.ticket_no}`].some((v) => v?.toLowerCase().includes(q)))
    // pending: oldest first (what needs chasing); otherwise newest first
    .sort((a, b) => (filter === 'closed' || filter === 'all' ? new Date(b.opened_at) - new Date(a.opened_at) : new Date(a.opened_at) - new Date(b.opened_at)))

  const current = selected && selected !== 'new' ? list.find((c) => c.id === selected) : null

  return (
    <>
      <section className="stats">
        <Stat icon={Clock} label="Pending" value={pending.length} tone="blue" onClick={() => setFilter('pending')} active={filter === 'pending'} />
        <Stat icon={AlertCircle} label="Pending over 2 days" value={counts.old} tone="red" onClick={() => setFilter('old')} active={filter === 'old'} />
        <Stat icon={CheckCircle2} label="Closed today" value={closedToday.length} tone="green" />
        <Stat icon={IndianRupee} label="Collected today" value={inr(closedToday.reduce((sum, c) => sum + Number(c.charge ?? 0), 0)) || '₹0'} tone="green" />
      </section>

      <section className="desk-toolbar">
        <nav className="filter-pills">
          {filters.map((f) => (
            <button key={f.key} type="button" className={`pill ${filter === f.key ? 'pill-active' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label} <span className="pill-count">{counts[f.key]}</span>
            </button>
          ))}
        </nav>
        <div className="desk-toolbar-right">
          <select className="desk-select" value={engineerFilter} onChange={(e) => setEngineerFilter(e.target.value)} aria-label="Engineer">
            <option value="all">All engineers</option>
            {engineersWithWork.map(([name, n]) => <option key={name} value={name}>{name} ({n} pending)</option>)}
          </select>
          <label className="search">
            <Search size={17} />
            <input value={search} placeholder="Customer, machine, problem…" onChange={(e) => setSearch(e.target.value)} />
            {search && <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}
          </label>
          <button type="button" className="primary-btn" onClick={() => setSelected('new')}><Plus size={18} /> <span>New complaint</span></button>
        </div>
      </section>

      <section className="desk-card">
        {complaints.isLoading ? <p className="desk-empty">Loading complaints…</p>
          : complaints.error ? <p className="desk-empty">Couldn’t load complaints: {complaints.error.message}</p>
          : visible.length === 0 ? <p className="desk-empty">{filter === 'pending' ? 'Nothing pending - every complaint is closed.' : 'No complaints here.'}</p>
          : (
            <table className="desk-table">
              <thead>
                <tr><th>#</th><th>Customer</th><th>Machine</th><th>Problem</th><th>Engineer</th><th>Status</th><th>Opened</th><th>Closed / charge</th></tr>
              </thead>
              <tbody>
                {visible.map((c) => {
                  const lit = live.complaints?.[c.id]
                  return (
                    <tr
                      key={c.id}
                      className={[selected === c.id && 'is-selected', lit && `live-row live-${lit.via}`, isOld(c) && 'is-old'].filter(Boolean).join(' ')}
                      onClick={() => setSelected(c.id)}
                    >
                      <td className="desk-ticket">
                        {lit && <span className="live-badge-inline">{lit.via === 'whatsapp' ? <><MessageCircle size={10} strokeWidth={2.75} /> WhatsApp</> : 'Updated'}</span>}
                        #{c.ticket_no}
                      </td>
                      <td><div className="desk-strong">{c.customer?.name}</div><div className="desk-muted">{c.customer?.area}</div></td>
                      <td className="desk-muted">{c.machine?.model ?? '—'}</td>
                      <td>{c.problem}</td>
                      <td>{c.engineer?.name ?? <span className="desk-noone"><UserX size={13} /> Not assigned</span>}</td>
                      <td><span className={`status-chip status-${c.status}`}>{statusLabel[c.status]}</span></td>
                      <td className={isOld(c) ? 'desk-late' : 'desk-muted'}>{c.status === 'closed' ? when(c.opened_at) : `${age(c.opened_at)} ago`}</td>
                      <td className="desk-muted">
                        {c.status === 'closed' ? <>{age(c.opened_at, c.closed_at)} · {c.part_used ?? 'no part'}{c.charge !== null && <> · <span className="desk-strong">{inr(c.charge)}</span></>}</> : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </section>

      {selected && <ComplaintPanel key={selected} complaint={current} onClose={() => setSelected(null)} />}
    </>
  )
}

const historyWords = { created: 'Logged', assigned: 'Assigned', closed: 'Closed', open: 'Reopened', updated: 'Changed' }

function ComplaintPanel({ complaint, onClose }) {
  const isNew = !complaint
  const customers = useCustomers()
  const engineers = useEngineers()
  const save = useSave('complaints')
  const saveCustomer = useSave('customers')
  const history = useComplaintHistory(complaint?.id)
  const { toast } = useLive()

  const [customerId, setCustomerId] = useState(complaint?.customer?.id ?? '')
  const [newCustomer, setNewCustomer] = useState('')
  const [machineId, setMachineId] = useState(complaint?.machine?.id ?? '')
  const [problem, setProblem] = useState(complaint?.problem ?? '')
  const [engineerId, setEngineerId] = useState(complaint?.engineer?.id ?? '')
  const [resolution, setResolution] = useState('')
  const [part, setPart] = useState('')
  const [charge, setCharge] = useState('')
  const [error, setError] = useState(null)

  const customer = customers.data?.find((c) => c.id === customerId)
  const machines = customer?.machines ?? []
  const activeEngineers = (engineers.data ?? []).filter((e) => e.active)

  const run = async (fn, message) => {
    setError(null)
    try {
      await fn()
      toast(message)
      onClose()
    } catch (err) {
      setError(err.message)
    }
  }

  const create = () => run(async () => {
    let custId = customerId
    if (custId === 'new') {
      if (!newCustomer.trim()) throw new Error('Enter the new customer’s name.')
      custId = (await saveCustomer.mutateAsync({ values: { name: newCustomer.trim() } })).id
    }
    if (!custId) throw new Error('Pick the customer.')
    if (!problem.trim()) throw new Error('Describe the problem.')
    const now = new Date().toISOString()
    await save.mutateAsync({
      values: {
        customer_id: custId,
        machine_id: machineId || (machines.length === 1 ? machines[0].id : null),
        problem: problem.trim(),
        engineer_id: engineerId || null,
        status: engineerId ? 'assigned' : 'open',
        assigned_at: engineerId ? now : null,
        engineer_notified_at: engineerId ? now : null,
      },
    })
  }, 'Complaint logged')

  const assign = () => run(async () => {
    if (!engineerId) throw new Error('Pick an engineer.')
    const now = new Date().toISOString()
    await save.mutateAsync({ id: complaint.id, values: { engineer_id: engineerId, status: 'assigned', assigned_at: now, engineer_notified_at: now } })
  }, `#${complaint?.ticket_no} assigned`)

  const close = () => run(async () => {
    if (!resolution.trim()) throw new Error('What was done to fix it?')
    const amount = charge.trim() === '' ? null : Number(charge.replace(/[₹,\s]/g, ''))
    if (amount !== null && (Number.isNaN(amount) || amount < 0)) throw new Error('The charge should be a number of rupees.')
    const now = new Date().toISOString()
    await save.mutateAsync({ id: complaint.id, values: { status: 'closed', closed_at: now, resolution: resolution.trim(), part_used: part.trim() || null, charge: amount, rating_requested_at: now } })
  }, `#${complaint?.ticket_no} closed`)

  const reopen = () => run(async () => {
    await save.mutateAsync({ id: complaint.id, values: { status: complaint.engineer ? 'assigned' : 'open', closed_at: null } })
  }, `#${complaint?.ticket_no} reopened`)

  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar" role="dialog" aria-label={isNew ? 'New complaint' : `Complaint #${complaint.ticket_no}`}>
        <div className="sidebar-header">
          <div>
            <div className="sidebar-title">{isNew ? 'New complaint' : `Complaint #${complaint.ticket_no}`}</div>
            {!isNew && <div className="desk-muted">{complaint.customer?.name} · {complaint.machine?.model ?? 'machine not recorded'}</div>}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="sidebar-body">
          {isNew ? (
            <>
              <label className="field">
                <span className="field-label">Customer</span>
                <select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setMachineId('') }}>
                  <option value="">Choose…</option>
                  {(customers.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}{c.area ? ` - ${c.area}` : ''}</option>)}
                  <option value="new">+ New customer</option>
                </select>
              </label>
              {customerId === 'new' && (
                <label className="field"><span className="field-label">New customer name</span><input autoFocus value={newCustomer} onChange={(e) => setNewCustomer(e.target.value)} /></label>
              )}
              {machines.length > 0 && (
                <label className="field">
                  <span className="field-label">Machine</span>
                  <select value={machineId} onChange={(e) => setMachineId(e.target.value)}>
                    {machines.length > 1 && <option value="">Choose…</option>}
                    {machines.map((m) => <option key={m.id} value={m.id}>{m.model}{m.serial_no ? ` (${m.serial_no})` : ''}</option>)}
                  </select>
                </label>
              )}
              <label className="field"><span className="field-label">Problem</span><textarea rows={3} value={problem} placeholder="e.g. paper jam in tray 2" onChange={(e) => setProblem(e.target.value)} /></label>
              <label className="field">
                <span className="field-label">Assign to</span>
                <select value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>
                  <option value="">Not yet</option>
                  {activeEngineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                </select>
              </label>
            </>
          ) : (
            <>
              <div className="desk-detail">
                <span className={`status-chip status-${complaint.status}`}>{statusLabel[complaint.status]}</span>
                <p className="desk-problem">{complaint.problem}</p>
                <dl className="desk-facts">
                  <dt>Opened</dt><dd>{when(complaint.opened_at)}{complaint.created_via === 'whatsapp' && <span className="desk-via"><MessageCircle size={11} /> WhatsApp</span>}</dd>
                  {complaint.assigned_at && <><dt>Assigned</dt><dd>{when(complaint.assigned_at)} to {complaint.engineer?.name}</dd></>}
                  {complaint.closed_at && <><dt>Closed</dt><dd>{when(complaint.closed_at)} - took {age(complaint.opened_at, complaint.closed_at)}</dd></>}
                  {complaint.resolution && <><dt>Work done</dt><dd>{complaint.resolution}</dd></>}
                  {complaint.part_used && <><dt>Part</dt><dd>{complaint.part_used}</dd></>}
                  {complaint.charge !== null && <><dt>Charge</dt><dd className="desk-strong">{inr(complaint.charge)}</dd></>}
                </dl>
              </div>

              {complaint.status !== 'closed' && (
                <>
                  <div className="field">
                    <span className="field-label">{complaint.engineer ? 'Reassign' : 'Assign to'}</span>
                    <div className="desk-inline">
                      <select value={engineerId} onChange={(e) => setEngineerId(e.target.value)}>
                        <option value="">Choose…</option>
                        {activeEngineers.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                      <button type="button" className="btn-secondary" disabled={save.isPending || !engineerId || engineerId === complaint.engineer?.id} onClick={assign}>Assign</button>
                    </div>
                  </div>
                  <div className="desk-close-box">
                    <span className="field-label">Close the complaint</span>
                    <input value={resolution} placeholder="Work done, e.g. roller change" onChange={(e) => setResolution(e.target.value)} />
                    <div className="desk-inline">
                      <input value={part} placeholder="Part used" onChange={(e) => setPart(e.target.value)} />
                      <input value={charge} inputMode="numeric" placeholder="Charge ₹" onChange={(e) => setCharge(e.target.value)} />
                    </div>
                    <button type="button" className="btn-primary" disabled={save.isPending} onClick={close}><CheckCircle2 size={15} /> Mark closed</button>
                  </div>
                </>
              )}

              <div className="field">
                <span className="field-label">History</span>
                {history.isLoading ? <p className="field-empty">Loading…</p> : (history.data ?? []).length === 0 ? <p className="field-empty">Nothing recorded yet.</p> : (
                  <ul className="history-list">
                    {history.data.map((h) => (
                      <li key={h.id}>
                        <span className="history-text">{historyWords[h.action] ?? 'Changed'}</span>
                        {h.via === 'whatsapp' && <span className="history-via"><MessageCircle size={11} /> WhatsApp</span>}
                        <span className="history-time">{when(h.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
          {error && <span className="field-error"><AlertCircle size={13} /> {error}</span>}
        </div>

        <div className="sidebar-footer">
          {isNew ? (
            <>
              <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="btn-primary" disabled={save.isPending} onClick={create}>Log complaint</button>
            </>
          ) : complaint.status === 'closed' ? (
            <button type="button" className="btn-secondary" disabled={save.isPending} onClick={reopen}>Reopen</button>
          ) : <span />}
        </div>
      </aside>
    </>
  )
}
