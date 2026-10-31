import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Copy, KeyRound, UserPlus, Users, Wrench } from 'lucide-react'
import { useMemberAction, useMembers } from './session.js'
import { useEngineers, useSave, useSaveSettings, useSettings } from './data.js'

// The admin's member list. Everyone here has their own private board; being on this list (and
// active) is what lets someone use the CRM - in the app, and from WhatsApp if they're also a
// workspace employee with their phone connected in the workspace portal.
export default function TeamPage({ me, accountMenu }) {
  const members = useMembers()
  const action = useMemberAction()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [handover, setHandover] = useState(null) // { email, password }
  const [notice, setNotice] = useState(null)

  const run = (body, onDone) =>
    action.mutate(body, {
      onSuccess: (result) => onDone?.(result),
      onError: () => setNotice(null),
    })

  const add = (e) => {
    e.preventDefault()
    run({ action: 'add', email, name }, (result) => {
      if (result.temporary_password) setHandover({ email: result.member.email, password: result.temporary_password })
      else setNotice(`${result.member.email} already has a workspace login - they sign in with their own password.`)
      setEmail('')
      setName('')
    })
  }

  const copy = (text) => navigator.clipboard?.writeText(text)

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-left">
          <Link to="/" className="icon-btn" aria-label="Back to complaints"><ArrowLeft size={18} /></Link>
          <div className="brand-icon"><Users size={20} strokeWidth={2.2} /></div>
          <h1 className="page-title">Team</h1>
        </div>
        <div className="topbar-right">{accountMenu}</div>
      </header>

      <section className="team">
        <p className="team-intro">
          People you add here can sign in to Service Desk and see every complaint, customer and AMC. Workspace employees on this list can
          also use it from WhatsApp once they connect their phone in the workspace portal. Engineers go on the engineers list below; link
          one to his login so the jobs he closes from WhatsApp count as his.
        </p>

        {handover && (
          <div className="team-card team-handover">
            <KeyRound size={18} />
            <div>
              <div className="team-card-title">Temporary password for {handover.email}</div>
              <p className="team-card-text">Give it to them directly - it’s shown only now. They can change it from their account menu.</p>
              <div className="team-handover-row">
                <code>{handover.password}</code>
                <button type="button" className="btn-secondary" onClick={() => copy(handover.password)}><Copy size={14} /> Copy</button>
                <button type="button" className="btn-secondary" onClick={() => setHandover(null)}>Done</button>
              </div>
            </div>
          </div>
        )}
        {notice && <div className="team-card team-notice">{notice}</div>}
        {action.error && <div className="team-card team-error">{action.error.message}</div>}

        <form className="team-card team-add" onSubmit={add}>
          <div className="team-card-title"><UserPlus size={16} /> Add a person</div>
          <div className="team-add-row">
            <label className="field">
              <span className="field-label">Email</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
            </label>
            <label className="field">
              <span className="field-label">Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" />
            </label>
            <button type="submit" className="btn-primary" disabled={action.isPending}>{action.isPending ? 'Adding…' : 'Add'}</button>
          </div>
        </form>

        <div className="team-card">
          <div className="team-card-title">Members {members.data && <span className="count-pill">{members.data.length}</span>}</div>
          {members.isLoading && <p className="field-empty">Loading…</p>}
          {members.error && <p className="field-empty">Couldn’t load members: {members.error.message}</p>}
          {members.data?.length === 0 && <p className="field-empty">No members yet.</p>}
          <ul className="member-list">
            {members.data?.map((m) => {
              const self = m.user_id === me.user_id
              return (
                <li key={m.user_id} className={m.status === 'disabled' ? 'is-disabled' : ''}>
                  <span className="account-avatar">{(m.name || m.email)[0].toUpperCase()}</span>
                  <div className="member-text">
                    <span className="member-name">{m.name}{self && ' (you)'}</span>
                    <span className="member-sub">
                      {m.email} · {m.role === 'admin' ? 'Admin' : 'User'}
                      {m.status === 'disabled' ? ' · Access paused' : ''}
                      {!m.created_login && ' · Workspace login'}
                    </span>
                  </div>
                  {!self && (
                    <div className="member-actions">
                      <button type="button" className="btn-secondary" disabled={action.isPending} onClick={() => run({ action: 'set_role', user_id: m.user_id, role: m.role === 'admin' ? 'user' : 'admin' })}>
                        {m.role === 'admin' ? 'Make user' : 'Make admin'}
                      </button>
                      {m.created_login && (
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={action.isPending}
                          onClick={() => window.confirm(`Reset ${m.email}'s password? Their current password stops working.`)
                            && run({ action: 'reset_password', user_id: m.user_id }, (r) => setHandover({ email: m.email, password: r.temporary_password }))}
                        >
                          Reset password
                        </button>
                      )}
                      <button type="button" className="btn-secondary" disabled={action.isPending} onClick={() => run({ action: 'set_status', user_id: m.user_id, status: m.status === 'active' ? 'disabled' : 'active' })}>
                        {m.status === 'active' ? 'Pause access' : 'Restore access'}
                      </button>
                      <button
                        type="button"
                        className="btn-ghost-danger"
                        disabled={action.isPending}
                        onClick={() => window.confirm(`Remove ${m.email}? They lose access; their board is kept if you add them again.`) && run({ action: 'remove', user_id: m.user_id })}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
        <EngineersCard members={members.data ?? []} />
        <BusinessCard />
      </section>
    </div>
  )
}

// The people who go out on jobs. An engineer linked to a member login can close jobs from WhatsApp
// as himself (and jobs he closes that weren't assigned become his).
function EngineersCard({ members }) {
  const engineers = useEngineers()
  const save = useSave('engineers')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState(null)
  const run = async (args) => {
    setError(null)
    try {
      await save.mutateAsync(args)
      return true
    } catch (err) {
      setError(/duplicate|unique/i.test(err.message) ? 'That engineer or login is already on the list.' : err.message)
      return false
    }
  }
  const add = async (e) => {
    e.preventDefault()
    if (!name.trim()) return
    if (await run({ values: { name: name.trim(), phone: phone.trim() || null } })) {
      setName('')
      setPhone('')
    }
  }
  return (
    <div className="team-card">
      <div className="team-card-title"><Wrench size={16} /> Engineers {engineers.data && <span className="count-pill">{engineers.data.filter((e) => e.active).length}</span>}</div>
      <form className="team-add-row" onSubmit={add}>
        <label className="field"><span className="field-label">Name</span><input value={name} placeholder="e.g. Ramesh Kumar" onChange={(e) => setName(e.target.value)} /></label>
        <label className="field"><span className="field-label">Phone</span><input value={phone} placeholder="Optional" onChange={(e) => setPhone(e.target.value)} /></label>
        <button type="submit" className="btn-primary" disabled={save.isPending}>Add</button>
      </form>
      {error && <div className="team-card team-error">{error}</div>}
      {engineers.isLoading && <p className="field-empty">Loading…</p>}
      <ul className="member-list">
        {(engineers.data ?? []).map((e) => (
          <li key={e.id} className={e.active ? '' : 'is-disabled'}>
            <span className="account-avatar">{e.name[0].toUpperCase()}</span>
            <div className="member-text">
              <span className="member-name">{e.name}</span>
              <span className="member-sub">{[e.phone, e.active ? null : 'Inactive'].filter(Boolean).join(' · ') || '—'}</span>
            </div>
            <div className="member-actions">
              <select
                className="desk-select"
                value={e.member_user_id ?? ''}
                aria-label={`Login for ${e.name}`}
                onChange={(ev) => run({ id: e.id, values: { member_user_id: ev.target.value || null } })}
              >
                <option value="">Not linked to a login</option>
                {members.map((m) => <option key={m.user_id} value={m.user_id}>Login: {m.name}</option>)}
              </select>
              <button type="button" className="btn-secondary" disabled={save.isPending} onClick={() => run({ id: e.id, values: { active: !e.active } })}>
                {e.active ? 'Set inactive' : 'Set active'}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function BusinessCard() {
  const settings = useSettings()
  const save = useSaveSettings()
  const [name, setName] = useState(null)
  const value = name ?? settings.data?.business_name ?? ''
  return (
    <form className="team-card team-add" onSubmit={(e) => { e.preventDefault(); save.mutate({ business_name: value.trim() || 'Service Desk' }) }}>
      <div className="team-card-title">Business name</div>
      <div className="team-add-row">
        <label className="field"><span className="field-label">Shown at the top of every screen</span><input value={value} onChange={(e) => setName(e.target.value)} /></label>
        <span />
        <button type="submit" className="btn-primary" disabled={save.isPending}>{save.isSuccess && name === null ? 'Saved' : 'Save'}</button>
      </div>
    </form>
  )
}
