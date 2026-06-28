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
   3. In the Supabase SQL editor, run supabase-schema.sql (v2, normalized tables).
      If upgrading from v1 (single JSONB blob), also run migrate-v2.sql.
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
  SUPABASE_ANON_KEY: '',   // filled from the config function, or paste your anon key here for non-Netlify hosts
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
      if (error) throw new Error(error.message);
      const user = data.user;
      if (!user) throw new Error('Check your email to confirm your account, then sign in.');
      const u = { id: user.id, email, firstName, lastName };
      setCurrent(summary(u));
      return summary(u);
    },
    async signIn(email, password) {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
      const n = namesFromMeta(data.user.user_metadata, data.user.email);
      const u = { id: data.user.id, email: data.user.email, firstName: n.first, lastName: n.last };
      setCurrent(summary(u));
      return summary(u);
    },
    async signOut() { try { await sb.auth.signOut(); } catch (e) {} setCurrent(null); },

    /* ── loadProfile: read normalized tables → assemble the same shape
       the frontend expects: { isSetup, modules: [...], settings: {...} } ── */
    async loadProfile() {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return null;
      const uid = cur.id;

      const [settingsRes, modulesRes, marksRes, notesRes] = await Promise.all([
        sb.from('user_settings').select('*').eq('user_id', uid).maybeSingle(),
        sb.from('modules').select('*').eq('user_id', uid).order('sort_order'),
        sb.from('marks').select('*').eq('user_id', uid),
        sb.from('notes').select('module_code,content').eq('user_id', uid),
      ]);

      // Fall back to legacy blob if normalized tables are empty (pre-migration)
      if (!settingsRes.data && !modulesRes.data?.length) {
        const legacy = await sb.from('profiles').select('data').eq('id', uid).maybeSingle();
        if (legacy.data?.data?.isSetup) return legacy.data.data;
        return null;
      }

      const s = settingsRes.data || {};
      if (!s.is_setup) return null;

      const marksByModule = {};
      (marksRes.data || []).forEach(m => {
        if (!marksByModule[m.module_id]) marksByModule[m.module_id] = [];
        marksByModule[m.module_id].push({ assessment: m.assessment, score: parseFloat(m.score) });
      });

      const notesByCode = {};
      (notesRes.data || []).forEach(n => {
        try { notesByCode[n.module_code] = JSON.parse(n.content); } catch (e) {}
      });

      const modules = (modulesRes.data || []).map(mod => {
        const nd = notesByCode[mod.code] || {};
        return {
          name: mod.name,
          code: mod.code,
          color: mod.color,
          marks: marksByModule[mod.id] || [],
          _id: mod.id,
          breakdown: Array.isArray(nd.breakdown) ? nd.breakdown : [],
          priorities: Array.isArray(nd.priorities) ? nd.priorities : [],
        };
      });

      return {
        isSetup: true,
        modules,
        settings: {
          name: s.name || '',
          program: s.program || 'PGDA',
          institution: s.institution || '',
          examDate: s.exam_date || '',
          isSetup: true,
        },
      };
    },

    /* ── saveProfile: decompose the frontend shape into normalized rows.
       Uses upserts so it's safe to call repeatedly. Only writes diffs
       where practical (marks are upserted individually, not bulk-replaced). ── */
    async saveProfile(obj) {
      const cur = lsGet(LS_CURRENT, null); if (!cur) return false;
      const uid = cur.id;
      if (!obj) return false;

      try {
        // 1. User settings
        const settings = obj.settings || {};
        await sb.from('user_settings').upsert({
          user_id:     uid,
          name:        sanitizeText(settings.name, 200),
          program:     sanitizeText(settings.program || 'PGDA', 100),
          institution: sanitizeText(settings.institution, 200),
          exam_date:   settings.examDate || null,
          is_setup:    !!obj.isSetup,
        }, { onConflict: 'user_id' });

        // 2. Modules + marks
        const modules = Array.isArray(obj.modules) ? obj.modules : [];
        for (let i = 0; i < modules.length; i++) {
          const mod = modules[i];
          const code = sanitizeCode(mod.code);
          const color = sanitizeColor(mod.color);
          const name = sanitizeText(mod.name, 200) || code;

          // Upsert the module row and get its id back
          const { data: modRow } = await sb.from('modules').upsert({
            user_id: uid,
            name,
            code,
            color,
            sort_order: i,
          }, { onConflict: 'user_id,code' }).select('id').single();

          if (!modRow) continue;
          const moduleId = modRow.id;

          // Upsert each mark
          const marks = Array.isArray(mod.marks) ? mod.marks : [];
          for (const mk of marks) {
            if (!mk.assessment || !VALID_ASSESSMENTS.has(mk.assessment)) continue;
            const score = sanitizeScore(mk.score);
            await sb.from('marks').upsert({
              module_id:  moduleId,
              user_id:    uid,
              assessment: mk.assessment,
              score,
            }, { onConflict: 'module_id,assessment' });
          }

          // Save breakdown + priority data to the notes table (JSON per module)
          const bd = Array.isArray(mod.breakdown) ? mod.breakdown : [];
          const pr = Array.isArray(mod.priorities) ? mod.priorities : [];
          if (bd.length || pr.length) {
            const noteContent = JSON.stringify({ breakdown: bd.slice(0, 30), priorities: pr.slice(0, 15) });
            await sb.from('notes').upsert({
              user_id: uid,
              module_code: code,
              content: noteContent.slice(0, 10000),
            }, { onConflict: 'user_id,module_code' });
          }
        }

        return true;
      } catch (e) {
        console.error('[TT] saveProfile error:', e);
        return false;
      }
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
          // Seed a user_settings row (the trigger handles this too, but belt-and-suspenders)
          sb.from('user_settings').upsert({ user_id: session.user.id }, { onConflict: 'user_id', ignoreDuplicates: true }).then(() => {});
        } else { setCurrent(null); }
        readyResolve(mode);
      });
      setTimeout(() => readyResolve(mode), 400);
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
      const redirectTo = new URL(redirect || 'index.html', location.href).href;
      const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } });
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
