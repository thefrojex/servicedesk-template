import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, UserPlus, Users, Wrench } from 'lucide-react'
import { useMembers, usePeople, useSetMember } from './session.js'
import { useSettings } from './data.js'

// The admin's member list. Membership is the workspace's (core): anyone on the workspace's
// employee list can be added, and the same list and roles show in the console. Engineers are
// members with the engineer role - complaints can be assigned to them, and they close their jobs
// from WhatsApp once their phone is connected in the workspace portal.
const roleLabels = { engineer: 'Engineer', dispatcher: 'Dispatcher', admin: 'Admin' }

export default function TeamPage({ me, accountMenu }) {
  const members = useMembers()
  const people = usePeople()
  const setMember = useSetMember()
  const [adding, setAdding] = useState('')
  const [asEngineer, setAsEngineer] = useState(true)

  const memberIds = new Set((members.data ?? []).map((m) => m.id))
  const candidates = (people.data ?? []).filter((p) => !memberIds.has(p.id))
  const rolesOf = (m) => (m.roles ?? []).filter((r) => r in roleLabels)
  const toggleRole = (m, role) => {
    const current = rolesOf(m)
    setMember.mutate({ personId: m.id, roles: current.includes(role) ? current.filter((r) => r !== role) : [...current, role] })
  }
  const add = (e) => {
    e.preventDefault()
    if (adding) setMember.mutate({ personId: adding, roles: asEngineer ? ['engineer'] : [] }, { onSuccess: () => setAdding('') })
  }
  const engineers = (members.data ?? []).filter((m) => rolesOf(m).includes('engineer'))

  return (
    <div className="page">
      <header className="topbar">
        <div className="topbar-left">
          <Link to="/" className="icon-btn" aria-label="Back"><ArrowLeft size={18} /></Link>
          <div className="brand-icon"><Users size={20} strokeWidth={2.2} /></div>
          <h1 className="page-title">Team</h1>
        </div>
        <div className="topbar-right">{accountMenu}</div>
      </header>

      <section className="team">
        <p className="team-intro">
          Add the workspace’s employees to the Service Desk. Everyone here sees every complaint, customer and AMC.
          Engineers can be given jobs and close them from WhatsApp; dispatchers take complaints and hand them out.
          The workspace owner manages employees and who reports to whom in the console.
        </p>

        {setMember.error && <div className="team-card team-error">{setMember.error.message}</div>}

        <form className="team-card team-add" onSubmit={add}>
          <div className="team-card-title"><UserPlus size={16} /> Add a person</div>
          <div className="team-add-row">
            <label className="field">
              <span className="field-label">Employee</span>
              <select value={adding} onChange={(e) => setAdding(e.target.value)}>
                <option value="">{people.isLoading ? 'Loading…' : candidates.length ? 'Choose someone' : 'Everyone is already a member'}</option>
                {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</option>)}
              </select>
            </label>
            <label className="contact-check"><input type="checkbox" checked={asEngineer} onChange={(e) => setAsEngineer(e.target.checked)} /> Engineer</label>
            <button type="submit" className="btn-primary" disabled={!adding || setMember.isPending}>{setMember.isPending ? 'Adding…' : 'Add'}</button>
          </div>
        </form>

        <div className="team-card">
          <div className="team-card-title"><Wrench size={16} /> Members {members.data && <span className="count-pill">{members.data.length}</span>}
            {members.data && <span className="desk-muted"> · {engineers.length} engineer{engineers.length === 1 ? '' : 's'}</span>}</div>
          {members.isLoading && <p className="field-empty">Loading…</p>}
          {members.error && <p className="field-empty">Couldn’t load members: {members.error.message}</p>}
          <ul className="member-list">
            {members.data?.map((m) => {
              const self = m.auth_user_id === me.user_id
              const owner = m.workspace_role === 'owner'
              const roles = rolesOf(m)
              return (
                <li key={m.id}>
                  <span className="account-avatar">{(m.name || m.email || '?')[0].toUpperCase()}</span>
                  <div className="member-text">
                    <span className="member-name">{m.name}{self && ' (you)'}</span>
                    <span className="member-sub">
                      {[m.title, owner ? 'Workspace owner' : null, roles.filter((r) => !(owner && r === 'admin')).map((r) => roleLabels[r]).join(', ') || (owner ? null : 'Member')].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <div className="member-actions">
                    {['engineer', 'dispatcher'].map((role) => (
                      <button key={role} type="button" className="btn-secondary" disabled={setMember.isPending} onClick={() => toggleRole(m, role)}>
                        {roles.includes(role) ? `Not ${roleLabels[role].toLowerCase()}` : `Make ${roleLabels[role].toLowerCase()}`}
                      </button>
                    ))}
                    {!owner && !self && (
                      <>
                        <button type="button" className="btn-secondary" disabled={setMember.isPending} onClick={() => toggleRole(m, 'admin')}>
                          {roles.includes('admin') ? 'Remove admin' : 'Make admin'}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost-danger"
                          disabled={setMember.isPending}
                          onClick={() => window.confirm(`Remove ${m.name} from the Service Desk? Their jobs stay; they lose access until you add them again.`) && setMember.mutate({ personId: m.id, active: false })}
                        >
                          Remove
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        </div>

        <BusinessCard />
      </section>
    </div>
  )
}

// The business name is the workspace's, shown at the top of every screen
function BusinessCard() {
  const settings = useSettings()
  return (
    <div className="team-card">
      <div className="team-card-title">Business name</div>
      <p className="team-card-text">{settings.data?.business_name ?? '…'} - change it in the console, under Workspace → Company. Every app in the workspace uses the same name.</p>
    </div>
  )
}
