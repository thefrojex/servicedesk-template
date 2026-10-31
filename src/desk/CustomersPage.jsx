import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Plus, Printer, Search, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { keys, useAmcs, useComplaints, useCustomers, useSave } from './data.js'
import { age, day, daysUntil, inr, statusLabel, when } from './format.js'
import { useLive } from './Shell.jsx'

const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000

export default function CustomersPage() {
  const customers = useCustomers()
  const complaints = useComplaints()
  const amcs = useAmcs()
  const { live } = useLive()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState(null)

  const byCustomer = new Map()
  for (const c of complaints.data ?? []) {
    const list = byCustomer.get(c.customer?.id) ?? []
    list.push(c)
    byCustomer.set(c.customer?.id, list)
  }
  const amcOf = (id) => (amcs.data ?? []).filter((a) => a.customer?.id === id && !a.renewed_at).sort((a, b) => b.end_date.localeCompare(a.end_date))[0]

  const q = search.trim().toLowerCase()
  const visible = (customers.data ?? []).filter((c) => !q || [c.name, c.area, c.contact_person, ...c.machines.map((m) => m.model)].some((v) => v?.toLowerCase().includes(q)))

  return (
    <>
      <section className="desk-toolbar">
        <div className="desk-toolbar-title">{customers.data?.length ?? 0} customers</div>
        <div className="desk-toolbar-right">
          <label className="search">
            <Search size={17} />
            <input value={search} placeholder="Name, area, machine…" onChange={(e) => setSearch(e.target.value)} />
            {search && <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Clear search"><X size={14} /></button>}
          </label>
          <button type="button" className="primary-btn" onClick={() => setSelected('new')}><Plus size={18} /> <span>Add customer</span></button>
        </div>
      </section>

      <section className="desk-card">
        {customers.isLoading ? <p className="desk-empty">Loading customers…</p>
          : customers.error ? <p className="desk-empty">Couldn’t load customers: {customers.error.message}</p>
          : visible.length === 0 ? <p className="desk-empty">No customers match.</p>
          : (
            <table className="desk-table">
              <thead><tr><th>Customer</th><th>Machines</th><th>Visits (90 days)</th><th>Pending</th><th>Last visit</th><th>AMC</th></tr></thead>
              <tbody>
                {visible.map((c) => {
                  const list = byCustomer.get(c.id) ?? []
                  const recent = list.filter((x) => Date.now() - new Date(x.opened_at) < NINETY_DAYS)
                  const pending = list.filter((x) => x.status !== 'closed').length
                  const last = list[0]
                  const amc = amcOf(c.id)
                  const left = amc ? daysUntil(amc.end_date) : null
                  const lit = live.customers?.[c.id]
                  return (
                    <tr key={c.id} className={lit ? `live-row live-${lit.via}` : ''} onClick={() => setSelected(c.id)}>
                      <td><div className="desk-strong">{c.name}</div><div className="desk-muted">{[c.area, c.contact_person].filter(Boolean).join(' · ')}</div></td>
                      <td className="desk-muted">{c.machines.map((m) => m.model).join(', ') || '—'}</td>
                      <td>{recent.length}</td>
                      <td>{pending ? <span className="status-chip status-assigned">{pending} pending</span> : <span className="desk-muted">—</span>}</td>
                      <td className="desk-muted">{last ? `${age(last.opened_at)} ago` : '—'}</td>
                      <td>{amc ? <span className={left < 0 ? 'desk-late' : left <= 30 ? 'desk-soon' : 'desk-muted'}>{left < 0 ? `Lapsed ${-left} days ago` : `Ends ${day(amc.end_date)}`}</span> : <span className="desk-muted">No AMC</span>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
      </section>

      {selected === 'new' && <NewCustomerPanel onClose={() => setSelected(null)} />}
      {selected && selected !== 'new' && (
        <CustomerPanel customer={customers.data?.find((c) => c.id === selected)} complaints={byCustomer.get(selected) ?? []} amc={amcOf(selected)} onClose={() => setSelected(null)} />
      )}
    </>
  )
}

function CustomerPanel({ customer, complaints, amc, onClose }) {
  if (!customer) return null
  const recent = complaints.filter((c) => Date.now() - new Date(c.opened_at) < NINETY_DAYS)
  const byProblem = {}
  for (const c of recent) byProblem[c.category] = (byProblem[c.category] ?? 0) + 1
  const charged = recent.reduce((sum, c) => sum + Number(c.charge ?? 0), 0)
  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar" role="dialog" aria-label={customer.name}>
        <div className="sidebar-header">
          <div>
            <div className="sidebar-title">{customer.name}</div>
            <div className="desk-muted">{[customer.area, customer.contact_person, customer.phone].filter(Boolean).join(' · ')}</div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="sidebar-body">
          <div className="desk-summary">
            <div><span className="desk-summary-value">{recent.length}</span><span className="desk-muted">visits in 3 months</span></div>
            <div><span className="desk-summary-value">{inr(charged) || '₹0'}</span><span className="desk-muted">charged</span></div>
            <div><span className="desk-summary-value">{complaints.filter((c) => c.status !== 'closed').length}</span><span className="desk-muted">pending</span></div>
          </div>
          {Object.keys(byProblem).length > 0 && (
            <div className="desk-chips">{Object.entries(byProblem).sort((a, b) => b[1] - a[1]).map(([k, n]) => <span key={k} className="desk-chip">{n} × {k}</span>)}</div>
          )}
          <Machines customer={customer} />
          <div className="field">
            <span className="field-label">AMC</span>
            {amc ? <p className="desk-amc-line">{inr(amc.value)} · {day(amc.start_date)} → {day(amc.end_date)}{daysUntil(amc.end_date) < 0 && <span className="desk-late"> · lapsed</span>}</p> : <p className="field-empty">No AMC.</p>}
          </div>
          <div className="field">
            <span className="field-label">Service history</span>
            <ul className="desk-history">
              {complaints.map((c) => (
                <li key={c.id}>
                  <div className="desk-history-top"><span className="desk-strong">#{c.ticket_no} {c.problem}</span><span className={`status-chip status-${c.status}`}>{statusLabel[c.status]}</span></div>
                  <div className="desk-muted">{when(c.opened_at)}{c.engineer && ` · ${c.engineer.name}`}{c.part_used && ` · ${c.part_used}`}{c.charge !== null && ` · ${inr(c.charge)}`}</div>
                </li>
              ))}
              {complaints.length === 0 && <li className="field-empty">No complaints yet.</li>}
            </ul>
          </div>
        </div>
      </aside>
    </>
  )
}

// A customer's machines, and adding one (say they bought a second copier).
function Machines({ customer }) {
  const queryClient = useQueryClient()
  const [model, setModel] = useState('')
  const [serial, setSerial] = useState('')
  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('machines').insert({ customer_id: customer.id, model: model.trim(), serial_no: serial.trim() || null })
      if (error) throw error
    },
    onSuccess: () => {
      setModel('')
      setSerial('')
      queryClient.invalidateQueries({ queryKey: keys.all })
    },
  })
  return (
    <div className="field">
      <span className="field-label">Machines</span>
      <ul className="desk-machines">
        {customer.machines.map((m) => <li key={m.id}><Printer size={14} /> {m.model}{m.serial_no && <span className="desk-muted"> · {m.serial_no}</span>}</li>)}
        {customer.machines.length === 0 && <li className="desk-muted">None recorded</li>}
      </ul>
      <form className="desk-inline" onSubmit={(e) => { e.preventDefault(); if (model.trim()) add.mutate() }}>
        <input value={model} placeholder="Add machine, e.g. Canon iR 2530" onChange={(e) => setModel(e.target.value)} />
        <input value={serial} placeholder="Serial no." onChange={(e) => setSerial(e.target.value)} />
        <button type="submit" className="btn-secondary" disabled={add.isPending || !model.trim()}>Add</button>
      </form>
      {add.error && <span className="field-error"><AlertCircle size={13} /> {add.error.message}</span>}
    </div>
  )
}

function NewCustomerPanel({ onClose }) {
  const save = useSave('customers')
  const queryClient = useQueryClient()
  const { toast } = useLive()
  const [form, setForm] = useState({ name: '', area: '', contact_person: '', phone: '', model: '' })
  const [error, setError] = useState(null)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const submit = async () => {
    setError(null)
    if (!form.name.trim()) return setError('Enter the customer’s name.')
    try {
      const row = await save.mutateAsync({ values: { name: form.name.trim(), area: form.area.trim() || null, contact_person: form.contact_person.trim() || null, phone: form.phone.trim() || null } })
      if (form.model.trim()) {
        const { error } = await supabase.from('machines').insert({ customer_id: row.id, model: form.model.trim() })
        if (error) throw error
        await queryClient.invalidateQueries({ queryKey: keys.all })
      }
      toast(`Added ${row.name}`)
      onClose()
    } catch (err) {
      setError(/duplicate|unique/i.test(err.message) ? 'A customer with that name already exists.' : err.message)
    }
  }
  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} />
      <aside className="sidebar" role="dialog" aria-label="Add customer">
        <div className="sidebar-header"><div className="sidebar-title">Add customer</div><button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button></div>
        <div className="sidebar-body">
          <label className="field"><span className="field-label">Name</span><input autoFocus value={form.name} onChange={set('name')} /></label>
          <label className="field"><span className="field-label">Area</span><input value={form.area} placeholder="e.g. Karol Bagh" onChange={set('area')} /></label>
          <div className="field-row">
            <label className="field"><span className="field-label">Contact person</span><input value={form.contact_person} onChange={set('contact_person')} /></label>
            <label className="field"><span className="field-label">Phone</span><input value={form.phone} onChange={set('phone')} /></label>
          </div>
          <label className="field"><span className="field-label">Machine model</span><input value={form.model} placeholder="e.g. Canon iR 2525" onChange={set('model')} /></label>
          {error && <span className="field-error"><AlertCircle size={13} /> {error}</span>}
        </div>
        <div className="sidebar-footer"><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button><button type="button" className="btn-primary" disabled={save.isPending} onClick={submit}>Add customer</button></div>
      </aside>
    </>
  )
}
