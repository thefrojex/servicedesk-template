// Service Desk data: reads with TanStack Query straight from the app's tables (shared by the team),
// writes as plain inserts/updates (RLS lets active members change anything, nothing is deleted).
//
// Live updates: every change anywhere - this screen, another member, the WhatsApp assistant - writes
// an activity_log row. useLiveActivity listens for those over Supabase Realtime (plus a 15-second
// check if the socket is down), refreshes the data, and reports the entries so the screen can light
// up the rows that changed. Changes made from this tab are skipped.

import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

const schema = import.meta.env.VITE_SUPABASE_SCHEMA

export const keys = {
  all: ['desk'],
  complaints: ['desk', 'complaints'],
  customers: ['desk', 'customers'],
  engineers: ['desk', 'engineers'],
  amc: ['desk', 'amc'],
  settings: ['desk', 'settings'],
}

const fail = ({ data, error }) => {
  if (error) throw error
  return data
}

export const useComplaints = () =>
  useQuery({
    queryKey: keys.complaints,
    queryFn: async () => fail(await supabase
      .from('complaints')
      .select('id, ticket_no, problem, category, status, opened_at, assigned_at, closed_at, resolution, part_used, charge, created_via, rating_requested_at, customer:customers (id, name, area), machine:machines (id, model), engineer:engineers (id, name)')
      .order('opened_at', { ascending: false })
      .limit(500)),
  })

export const useCustomers = () =>
  useQuery({
    queryKey: keys.customers,
    queryFn: async () => fail(await supabase
      .from('customers')
      .select('id, name, area, contact_person, phone, machines (id, model, serial_no, installed_on)')
      .order('name')),
  })

export const useEngineers = () =>
  useQuery({
    queryKey: keys.engineers,
    queryFn: async () => fail(await supabase.from('engineers').select('id, name, phone, active, member_user_id').order('name')),
  })

export const useAmcs = () =>
  useQuery({
    queryKey: keys.amc,
    queryFn: async () => fail(await supabase
      .from('amc_contracts')
      .select('id, start_date, end_date, value, reminder_sent_at, renewed_at, customer:customers (id, name, area), machine:machines (id, model)')
      .order('end_date')),
  })

export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: async () => fail(await supabase.from('settings').select('business_name').maybeSingle()),
  })

// Ids this tab changed recently, so their log entries aren't shown as someone else's change.
const ownWrites = new Map()
const rememberOwn = (id) => {
  const now = Date.now()
  ownWrites.set(id, now)
  for (const [key, at] of ownWrites) if (now - at > 60000) ownWrites.delete(key)
}

// insert / update one row, then refresh everything (the lists are small)
export function useSave(table) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, values }) => {
      if (id) {
        rememberOwn(id)
        return fail(await supabase.from(table).update(values).eq('id', id).select().single())
      }
      const row = fail(await supabase.from(table).insert(values).select().single())
      rememberOwn(row.id)
      return row
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
  })
}

export const useSaveSettings = () => {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (values) => fail(await supabase.from('settings').update(values).eq('id', true)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.settings }),
  })
}

// Recent changes to one complaint, newest first (its history panel).
export const useComplaintHistory = (complaintId) =>
  useQuery({
    queryKey: ['desk', 'history', complaintId],
    enabled: Boolean(complaintId),
    queryFn: async () => fail(await supabase
      .from('activity_log')
      .select('id, action, changes, via, created_at')
      .eq('complaint_id', complaintId)
      .order('created_at', { ascending: false })
      .limit(20)),
  })

const pollMs = 15000

// onChange(entries) gets the activity_log rows behind changes made elsewhere, after the data has
// been refreshed to include them.
export function useLiveActivity(onChange) {
  const queryClient = useQueryClient()
  const lastSeen = useRef(undefined)
  const busy = useRef(false)
  const handler = useRef(onChange)
  handler.current = onChange

  useEffect(() => {
    const check = async () => {
      if (busy.current) return
      busy.current = true
      try {
        if (lastSeen.current === undefined) {
          const newest = fail(await supabase.from('activity_log').select('created_at').order('created_at', { ascending: false }).limit(1))
          lastSeen.current = newest[0]?.created_at ?? null
          return
        }
        let request = supabase.from('activity_log').select('id, complaint_id, entity_type, entity_id, action, changes, via, created_at')
        if (lastSeen.current) request = request.gt('created_at', lastSeen.current)
        const entries = fail(await request.order('created_at', { ascending: true }).limit(100))
        if (!entries.length) return
        lastSeen.current = entries[entries.length - 1].created_at
        const outside = entries.filter((e) => !(e.via === 'app' && ownWrites.has(e.entity_id)))
        if (!outside.length) return
        await queryClient.invalidateQueries({ queryKey: keys.all })
        handler.current?.(outside)
      } catch {
        // the next nudge or poll tries again
      } finally {
        busy.current = false
      }
    }

    check()
    const poll = setInterval(check, pollMs)
    const onFocus = () => check()
    window.addEventListener('focus', onFocus)
    let nudge = null
    const channel = supabase
      .channel('desk-activity')
      .on('postgres_changes', { event: 'INSERT', schema, table: 'activity_log' }, () => {
        clearTimeout(nudge)
        nudge = setTimeout(check, 250)
      })
      .subscribe()
    return () => {
      clearInterval(poll)
      window.removeEventListener('focus', onFocus)
      supabase.removeChannel(channel)
    }
  }, [queryClient])
}
