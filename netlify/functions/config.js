/* ════════════════════════════════════════════════════════════════════
   TERM TRACKER — public runtime config (Netlify Function)

   Returns ONLY values that are safe in the browser:
     • Supabase project URL
     • Supabase publishable / anon key (public by design, protected by RLS)
     • whether AI is configured (boolean, never the key itself)

   Set these in Netlify → Site settings → Environment variables:
     SUPABASE_URL        https://<project-ref>.supabase.co
     SUPABASE_ANON_KEY   your publishable / anon key (NOT the secret key)
     NVIDIA_API_KEY      your NVIDIA key (used only by ai.js, never returned)
   ════════════════════════════════════════════════════════════════════ */

exports.handler = async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    aiEnabled: !!process.env.NVIDIA_API_KEY,
  }),
});
