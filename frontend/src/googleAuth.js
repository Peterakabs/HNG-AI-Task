import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://lgseazfkoqaozavyozno.supabase.co';
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY;
export const googleAuthReady = Boolean(supabaseKey);
export const googleAuth = supabaseKey ? createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'spectre-google-oauth-session', storage: window.sessionStorage },
}) : null;

export function requireGoogleAuth() {
  if (!googleAuth) throw new Error('Google sign-in is not configured. Add VITE_SUPABASE_PUBLISHABLE_KEY to the frontend environment and redeploy.');
  return googleAuth;
}
