// Who is signed in, and what they are in this CRM. Sign-in is the workspace's Supabase Auth (the
// same logins as every app in the workspace, and the workspace portal signs people in here too);
// membership is this app's own list. desk_session_seeded() makes the first sign-in the admin and
// loads the demo data for the whole team.

import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../lib/supabase'

export function useAuthUser() {
  const [state, setState] = useState({ loading: true, user: null })
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setState({ loading: false, user: data.session?.user ?? null }))
    const { data } = supabase.auth.onAuthStateChange((_event, session) => setState({ loading: false, user: session?.user ?? null }))
    return () => data.subscription.unsubscribe()
  }, [])
  return state
}

export function useMembership(userId) {
  return useQuery({
    queryKey: ['desk', 'session', userId],
    enabled: Boolean(userId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc('desk_session_seeded')
      if (error) throw error
      return data // null = not a member
    },
    staleTime: 60000,
  })
}

export function useResetDemo() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('reset_demo')
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['desk'] }),
  })
}

export async function signOut(queryClient) {
  await supabase.auth.signOut()
  queryClient.clear()
}

// ---------- the admin's member list (writes go through the edge function) ----------

const usersFunction = `${import.meta.env.VITE_SUPABASE_SCHEMA}-users`
const membersKey = ['desk', 'members']

export function useMembers() {
  return useQuery({
    queryKey: membersKey,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('members')
        .select('user_id, email, name, role, status, created_login, created_at')
        .order('created_at')
      if (error) throw error
      return data
    },
  })
}

async function callUsersFunction(body) {
  const { data, error } = await supabase.functions.invoke(usersFunction, { body })
  if (error) {
    // The function answers { error } with a 4xx; surface that message, not "non-2xx status"
    const detail = await error.context?.json?.().catch(() => null)
    throw new Error(detail?.error ?? error.message)
  }
  return data
}

export function useMemberAction() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: callUsersFunction,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: membersKey }),
  })
}

// A member whose login this CRM created should replace the temporary password.
export async function changePassword(password) {
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw error
}
