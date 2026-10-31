// ₹1,72,000 - Indian digit grouping
export const inr = (amount) =>
  amount === null || amount === undefined || amount === '' ? '' : `₹${Math.round(Number(amount)).toLocaleString('en-IN')}`

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

// "12 min", "5 h", "3 days"
export function age(from, to = new Date()) {
  const ms = new Date(to) - new Date(from)
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`
  const days = Math.floor(ms / DAY)
  return `${days} day${days === 1 ? '' : 's'}`
}

export const isOld = (complaint) => complaint.status !== 'closed' && Date.now() - new Date(complaint.opened_at) > 2 * DAY

export const when = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

export const day = (iso) => new Date(`${iso}T00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

export const daysUntil = (iso) => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return Math.round((new Date(`${iso}T00:00`) - today) / DAY)
}

export const statusLabel = { open: 'Open', assigned: 'Assigned', closed: 'Closed' }
