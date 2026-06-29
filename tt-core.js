/* ════════════════════════════════════════════════════════════════════
   TERM TRACKER — CORE
   Shared auth + memory layer for landing.html and index.html.

   HOW PERSISTENCE WORKS
   ─────────────────────
   • If you paste your Supabase project URL + anon key into TT_CONFIG below,
     accounts and all progress sync to the cloud and follow students across
     devices (the secure, multi-user path).
   • If those fields are left blank, Term Tracker automatically falls back to
     this browser's localStorage so the site still works instantly — but data
     then lives only on this one device/browser.

   TO TURN ON CLOUD SYNC (≈5 min)
   ──────────────────────────────
   1. Create a free project at https://supabase.com
   2. Project Settings → API → copy the "Project URL" and the "anon public" key
      into TT_CONFIG below.
   3. In the Supabase SQL editor, run supabase-schema.sql.
   4. Authentication → Providers → Email: turn OFF "Confirm email" for the
      smoothest student sign-up (or leave on if you want verification).
   That's it — sign-ups now create real, retrievable accounts.

   TO TURN ON "CONTINUE WITH GOOGLE" (recommended — safest, no passwords)
   ─────────────────────────────────────────────────────────────────────
   1. In Supabase: Authentication → Providers → Google → Enable.
   2. It shows a redirect/callback URL — copy it.
   3. In Google Cloud Console → APIs & Services → Credentials → create an
      "OAuth client ID" (type: Web application). Add your site URL to
      "Authorized JavaScript origins" and paste Supabase's callback URL into
      "Authorized redirect URIs".
   4. Copy the Google Client ID + Secret back into Supabase's Google provider.
   The "Continue with Google" button then signs students in with no password
   for us to ever store. (Until cloud mode is on, the button explains it needs
   Supabase keys.)
   ════════════════════════════════════════════════════════════════════ */

const TT_CONFIG = {
  // Project URL is public; pre-filled for this project. The anon/publishable key
  // and AI flag are loaded at runtime from /.netlify/functions/config on Netlify
  // (so no keys live in this file). On GitHub Pages / file://, that fetch simply
  // fails and the app falls back to localStorage mode.
  SUPABASE_URL:      'https://iswkwmoatnhkirebkpzi.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlzd2t3bW9hdG5oa2lyZWJrcHppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MTAyMDIsImV4cCI6MjA5ODE4NjIwMn0.hE2CoIHlO9wM29uMyvA4mY1Ccig136hp9s6zpMegWYE',
};
let TT_AI_ENABLED = false;  // set true once the config function reports an AI key is present

(function (global) {
  'use strict';

  const LS_USERS   = 'tt_users';     // local fallback: account records
  const LS_SESSION = 'tt_session';   // local fallback: signed-in user id
  const LS_CURRENT = 'tt_current';   // cached current-user summary (both modes)
  const LS_PROFILE = 'tt_profile_';  // local fallback: per-user profile blob

  const hasCloud = () => !!(TT_CONFIG.SUPABASE_URL && TT_CONFIG.SUPABASE_ANON_KEY);
  let sb = null;            // supabase client (cloud mode)
  let readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  /* ── helpers ── */
  function lsGet(k, fallback) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); }
    catch (e) { return fallback; }
  }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function uid() { return 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  async function sha256(str) {
    try {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
      // Extremely old browser / insecure context — weak but non-blocking fallback
      let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; }
      return 'x' + (h >>> 0).toString(16);
    }
  }

  function setCurrent(u) { u ? lsSet(LS_CURRENT, u) : (function(){ try { localStorage.removeItem(LS_CURRENT); } catch(e){} })(); }
  // Derive first/last name from Supabase metadata (handles Google's full_name/name)
  function namesFromMeta(meta, email) {
    meta = meta || {};
    let first = meta.firstName || meta.given_name || '';
    let last  = meta.lastName  || meta.family_name || '';
    if (!first && !last) {
      const full = (meta.full_name || meta.name || '').trim();
      if (full) { const parts = full.split(/\s+/); first = parts.shift(); last = parts.join(' '); }
    }
    if (!first) first = (email || '').split('@')[0] || 'Student';
    return { first, last };
  }
  function summary(u) {
    if (!u) return null;
    const first = u.firstName || '', last = u.lastName || '';
    const initials = ((first[0] || '') + (last[0] || '')).toUpperCase() || (u.email || '?')[0].toUpperCase();
    return { id: u.id, email: u.email, firstName: first, lastName: last, initials };
  }

  /* ════════════════ CLOUD MODE (Supabase) ════════════════ */
  function initCloud() {
    if (!global.supabase || !global.supabase.createClient) {
      console.warn('[TT] Supabase SDK not loaded — falling back to local storage.');
      return false;
    }
    sb = global.supabase.createClient(TT_CONFIG.SUPABASE_URL, TT_CONFIG.SUPABASE_ANON_KEY);
    return true;
  }

  /* ── Input sanitizers — strip anything the DB constraints would reject ── */
  function sanitizeText(v, maxLen) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').slice(0, maxLen);
  }
  function sanitizeCode(v) {
    if (typeof v !== 'string') return 'UNK';
    return v.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'UNK';
  }
  function sanitizeColor(v) {
    if (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) return v;
    return '#ffffff';
  }
  function sanitizeScore(v) {
    const n = parseFloat(v);
    if (isNaN(n) || n < 0) return null;
    return Math.min(n, 100);
  }
  const VALID_ASSESSMENTS = new Set(['Feb','Apr','Jun','Sep']);

  const cloud = {
    async signUp({ firstName, lastName, email, password }) {
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: { data: { firstName: sanitizeText(firstName, 100), lastName: sanitizeText(lastName, 100) } },
      });
      if (error) {
        const msg = error.message || '';
        if (msg.toLowerCase().includes('already registered') || msg.toLowerCase().includes('user already'))
          throw new Error('An account with that email already exists. Try signing in instead.');
        throw new Error(msg);
      }
      const user = data.user;
      // Supabase returns a user even when email confirmation is required —
      // identities being empty means the email is unconfirmed (existing unconfirmed account).
      if (!user || (Array.isArray(user.identities) && user.identities.length === 0))
        throw new Error('A confirmation email has been sent to ' + email + '. Please check your inbox and click the link to activate your account.');
      const u = { id: user.id, email, firstName, lastName };
      setCurrent(summary(u));
      return summary(u);
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) {
        const msg = error.message || '';
        if (msg.toLowerCase().includes('email not confirmed'))
          throw new Error('Your email address hasn\'t been confirmed yet. Check your inbox for the confirmation email, or contact support.');
        if (msg.toLowerCase().includes('invalid login'))
          throw new Error('Incorrect email or password. Please try again.');
        throw new Error(msg);
      }
      const n = namesFromMeta(data.user.user_metadata, data.user.email);
      const u = { id: data.user.id, email: data.user.email, firstName: n.first, lastName: n.last };
      setCurrent(summary(u));
      return summary(u);
    },
    async signOut() { try { await sb.auth.signOut(); } catch (e) {} setCurrent(null); },

    /* ── loadProfile / saveProfile: store the whole profile as one JSON
       blob keyed by user id. This round-trips the app's exact data shape
       (modules with feb/apr/jun + struggles + assessments, settings with
       firstName/lastName/year/timeline/hasExamData/markFmt) losslessly. ── */
    async loadProfile() {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return null;
      const { data, error } = await sb.from('profiles').select('data').eq('id', cur.id).maybeSingle();
      if (error || !data) return null;
      return data.data || null;
    },
    async saveProfile(obj) {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return false;
      if (!obj) return false;
      const { error } = await sb.from('profiles').upsert({ id: cur.id, data: obj, updated_at: new Date().toISOString() });
      if (error) { console.error('[TT] saveProfile error:', error.message); return false; }
      return true;
    },

    /* ── Schedule progress: sync completed weeks to schedule_progress table ── */
    async loadSchedule() {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return {};
      const { data } = await sb.from('schedule_progress').select('week_id').eq('user_id', cur.id).eq('completed', true);
      const map = {};
      (data || []).forEach(r => { map[r.week_id] = true; });
      return map;
    },
    async saveScheduleToggle(weekId, completed) {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return;
      if (completed) {
        await sb.from('schedule_progress').upsert({
          user_id: cur.id, week_id: sanitizeText(weekId, 50), period_id: 'main',
          completed: true, completed_at: new Date().toISOString(),
        }, { onConflict: 'user_id,week_id,period_id' });
      } else {
        await sb.from('schedule_progress').delete()
          .eq('user_id', cur.id).eq('week_id', weekId).eq('period_id', 'main');
      }
    },

    /* ── Task tracker: sync completed tasks to tasks table ── */
    async loadTasks() {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return {};
      const { data } = await sb.from('tasks').select('description').eq('user_id', cur.id).eq('completed', true);
      const map = {};
      (data || []).forEach(r => { map[r.description] = true; });
      return map;
    },
    async saveTaskToggle(taskId, completed, meta) {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return;
      const modCode = sanitizeCode((meta && meta.mod) || 'all');
      const week = sanitizeText((meta && meta.week) || '', 50);
      if (completed) {
        await sb.from('tasks').upsert({
          user_id: cur.id, module_code: modCode, week: week,
          description: sanitizeText(taskId, 1000),
          completed: true, completed_at: new Date().toISOString(),
        }, { onConflict: 'user_id,module_code,week,description' });
      } else {
        await sb.from('tasks').delete()
          .eq('user_id', cur.id).eq('description', taskId);
      }
    },

    /* ── Notes: per-module scratchpad (also used for breakdown/priority JSON) ── */
    async loadNotes() {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return {};
      const { data } = await sb.from('notes').select('module_code,content').eq('user_id', cur.id);
      const map = {};
      (data || []).forEach(r => {
        try { map[r.module_code] = JSON.parse(r.content); } catch (e) { map[r.module_code] = r.content; }
      });
      return map;
    },
    async saveNote(moduleCode, content) {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return;
      await sb.from('notes').upsert({
        user_id: cur.id,
        module_code: sanitizeCode(moduleCode),
        content: (typeof content === 'string' ? content : JSON.stringify(content)).slice(0, 10000),
      }, { onConflict: 'user_id,module_code' });
    },
  };

  /* ════════════════ LOCAL MODE (localStorage fallback) ════════════════ */
  const local = {
    async signUp({ firstName, lastName, email, password }) {
      const users = lsGet(LS_USERS, []);
      email = email.toLowerCase();
      if (users.some(u => u.email === email)) throw new Error('An account with that email already exists. Try signing in.');
      const rec = { id: uid(), email, firstName, lastName, pass: await sha256(email + ':' + password) };
      users.push(rec); lsSet(LS_USERS, users);
      lsSet(LS_SESSION, rec.id);
      setCurrent(summary(rec));
      return summary(rec);
    },
    async signIn(email, password) {
      const users = lsGet(LS_USERS, []);
      email = email.toLowerCase();
      const rec = users.find(u => u.email === email);
      if (!rec) throw new Error('No account found for that email. Create one first.');
      if (rec.pass !== await sha256(email + ':' + password)) throw new Error('Incorrect password. Please try again.');
      lsSet(LS_SESSION, rec.id);
      setCurrent(summary(rec));
      return summary(rec);
    },
    async signOut() { try { localStorage.removeItem(LS_SESSION); } catch (e) {} setCurrent(null); },
    async loadProfile() { const cur = lsGet(LS_CURRENT, null); return cur ? lsGet(LS_PROFILE + cur.id, null) : null; },
    async saveProfile(obj) { const cur = lsGet(LS_CURRENT, null); if (!cur) return false; lsSet(LS_PROFILE + cur.id, obj); return true; },

    async loadSchedule() { return lsGet('cta_sched_v2', {}); },
    async saveScheduleToggle(weekId, completed) {
      const s = lsGet('cta_sched_v2', {});
      if (completed) s[weekId] = true; else delete s[weekId];
      lsSet('cta_sched_v2', s);
    },
    async loadTasks() { return lsGet('ujCTAProgress_v2', {}); },
    async saveTaskToggle(taskId, completed) {
      const s = lsGet('ujCTAProgress_v2', {});
      if (completed) s[taskId] = true; else delete s[taskId];
      lsSet('ujCTAProgress_v2', s);
    },
    async loadNotes() { return {}; },
    async saveNote() {},
  };

  /* ════════════════ PUBLIC API ════════════════ */
  let impl = local;          // default until init resolves
  let mode = 'local';

  // Pull public runtime config (Supabase anon key + AI flag) from the Netlify
  // function. Silently ignored off-Netlify (GitHub Pages / file://) where it 404s.
  async function loadRuntimeConfig() {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch('/.netlify/functions/config', { signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) return;
      const cfg = await r.json();
      if (cfg.supabaseUrl)     TT_CONFIG.SUPABASE_URL = cfg.supabaseUrl;
      if (cfg.supabaseAnonKey) TT_CONFIG.SUPABASE_ANON_KEY = cfg.supabaseAnonKey;
      global.TT_AI_ENABLED = !!cfg.aiEnabled;
    } catch (e) { /* offline / not on Netlify — fall back to local */ }
  }

  function startLocal() {
    impl = local; mode = 'local';
    const sid = lsGet(LS_SESSION, null);
    if (sid) { const rec = lsGet(LS_USERS, []).find(u => u.id === sid); setCurrent(rec ? summary(rec) : null); }
    readyResolve(mode);
  }

  async function boot() {
    await loadRuntimeConfig();
    if (hasCloud() && initCloud()) {
      impl = cloud; mode = 'cloud';
      sb.auth.onAuthStateChange((_evt, session) => {
        if (session && session.user) {
          const n = namesFromMeta(session.user.user_metadata, session.user.email);
          setCurrent(summary({ id: session.user.id, email: session.user.email, firstName: n.first, lastName: n.last }));
          sb.from('user_settings').upsert({ user_id: session.user.id }, { onConflict: 'user_id', ignoreDuplicates: true }).then(() => {});
        } else { setCurrent(null); }
        readyResolve(mode);
      });
      // OAuth callbacks carry tokens in the hash — give Supabase time to process them
      const isOAuth = location.hash.includes('access_token') || location.hash.includes('refresh_token');
      setTimeout(() => readyResolve(mode), isOAuth ? 3000 : 400);
    } else {
      startLocal();
    }
  }

  const TTAuth = {
    get mode() { return mode; },
    ready,
    currentUser() { return lsGet(LS_CURRENT, null); },
    signUp(d)      { return impl.signUp(d); },
    signIn(e, p)   { return impl.signIn(e, p); },
    signOut()      { return impl.signOut(); },
    /** True when Google OAuth is available (cloud mode with Supabase configured). */
    canGoogle()    { return mode === 'cloud' && !!sb; },
    /** Begin Google OAuth. Redirects to `redirect` (default index.html) after success. */
    async signInWithGoogle(redirect) {
      if (mode !== 'cloud' || !sb) {
        throw new Error('Google sign-in needs cloud mode — add your Supabase keys in tt-core.js to enable it.');
      }
      // Build an absolute redirect URL. On GitHub Pages the path includes the repo
      // subpath; on Netlify it's the root. new URL handles both correctly.
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      const redirectTo = new URL(redirect || 'index.html', base).href;
      const { error } = await sb.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo, skipBrowserRedirect: false },
      });
      if (error) throw new Error(error.message);
    },
    /** Returns the live Supabase session user (null in local mode). Useful after OAuth redirects. */
    async getSessionUser() {
      if (mode !== 'cloud' || !sb) return null;
      try {
        const { data: { session } } = await sb.auth.getSession();
        if (!session || !session.user) return null;
        const n = namesFromMeta(session.user.user_metadata, session.user.email);
        const u = { id: session.user.id, email: session.user.email, firstName: n.first, lastName: n.last };
        setCurrent(summary(u));
        return summary(u);
      } catch (e) { return null; }
    },
    /** Resend the confirmation email. */
    async resendConfirmation(email) {
      if (mode !== 'cloud' || !sb) throw new Error('Cloud mode required.');
      const { error } = await sb.auth.resend({ type: 'signup', email });
      if (error) throw new Error(error.message);
    },
    /** Redirect to the landing page if nobody is signed in. Returns the user or null. */
    requireAuth(redirect = 'landing.html') {
      const u = this.currentUser();
      if (!u) { location.href = redirect; return null; }
      return u;
    },
  };

  const TTStore = {
    loadProfile()   { return impl.loadProfile(); },
    saveProfile(o)  { return impl.saveProfile(o); },
    loadSchedule()  { return impl.loadSchedule(); },
    saveScheduleToggle(id, done, meta) { return impl.saveScheduleToggle(id, done, meta); },
    loadTasks()     { return impl.loadTasks(); },
    saveTaskToggle(id, done, meta)     { return impl.saveTaskToggle(id, done, meta); },
    loadNotes()     { return impl.loadNotes(); },
    saveNote(code, content) { return impl.saveNote(code, content); },
  };

  /* AI client — talks to the Netlify function (key stays server-side). */
  const TTAI = {
    enabled() { return !!global.TT_AI_ENABLED; },
    async call(action, payload) {
      const r = await fetch('/.netlify/functions/ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, payload }),
      });
      if (!r.ok) { const t = await r.text().catch(()=>'' ); throw new Error('AI unavailable (' + r.status + ') ' + t.slice(0,120)); }
      return r.json();
    },
  };

  global.TTAuth  = TTAuth;
  global.TTStore = TTStore;
  global.TTAI    = TTAI;
  global.TT_MODE = () => mode;

  boot();
})(window);
