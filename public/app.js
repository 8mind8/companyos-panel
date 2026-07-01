/* COMPANY_OS panel — v1 READ-ONLY (решение 00). Тёмный дашборд (Guided + донат + Kanban-колонки, 05).
   Безопасность: anon-ключ + RLS.
   - вход: Supabase Auth (email/пароль) → JWT с email (логин ОБЯЗАТЕЛЕН);
   - чтение: PostgREST (RLS: authenticated читает весь борд; anon — ничего);
   - записи из панели НЕТ (v1). Смена статуса — позже через RPC task_set_status. Секретов в браузере нет. */

const CFG = window.COMPANY_OS_CONFIG || {};
const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ST = {
  todo:        { label: 'Відкрито',  ic: '●', c: 'var(--st-todo)' },
  in_progress: { label: 'В роботі',  ic: '◐', c: 'var(--st-progress)' },
  review:      { label: 'Перевірка', ic: '⏲', c: 'var(--st-review)' },
  done:        { label: 'Готово',    ic: '✓', c: 'var(--st-done)' },
  blocked:     { label: 'Блок',      ic: '🔴', c: 'var(--st-block)' },
};
const PR = { urgent: 'var(--st-block)', high: 'var(--accent)', normal: 'var(--st-progress)', low: 'var(--st-todo)' };
const DONUT_ORDER = ['done', 'in_progress', 'review', 'blocked', 'todo'];
const COL_ORDER = ['blocked', 'in_progress', 'review', 'todo']; // done — свёрнут (обычно много)

if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
  document.body.innerHTML = '<p class="err" style="padding:24px">Панель не сконфигурирована: нет SUPABASE_URL / SUPABASE_ANON_KEY в env заявки.</p>';
  throw new Error('no config');
}
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
let ME = null;

async function boot() {
  const { data } = await sb.auth.getSession();
  if (data.session) { ME = data.session.user.email; onAuthed(); }
  else { hide('projects'); hide('project'); show('login'); }
}
async function signIn() {
  $('loginErr').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  if (error) { $('loginErr').textContent = 'Не вдалося увійти: ' + error.message; return; }
  ME = data.user.email; onAuthed();
}
function onAuthed() { $('who').textContent = ME; show('logout'); hide('login'); openProjects(); }
async function logout() { await sb.auth.signOut(); ME = null; location.reload(); }

/* ---- Экран «Проєкти» ---- */
async function openProjects() {
  hide('project'); show('projects');
  const { data, error } = await sb.from('project_summary').select('*').order('updated_at', { ascending: false });
  const box = $('projectCards');
  if (error) { box.innerHTML = '<p class="err">' + esc(error.message) + '</p>'; return; }
  box.innerHTML = '';
  (data || []).forEach((p) => {
    const total = p.total_tasks || 0, done = total - (p.open_tasks || 0);
    const pct = total ? Math.round(done / total * 100) : 0;
    const el = document.createElement('div');
    el.className = 'widget proj';
    el.innerHTML =
      '<div class="ptitle">' + esc(p.name) + '</div>' +
      '<div class="muted small">' + esc(p.client || '') + ' · ' + esc(p.phase || '') + '</div>' +
      '<div class="track" style="margin-top:10px"><i style="width:' + pct + '%"></i></div>' +
      '<div class="focus small">' + pct + '% · ' + esc(p.current_focus || '—') + '</div>' +
      '<div class="badges">' +
        badge('◐ ' + (p.in_progress_tasks || 0)) +
        (p.blocked_tasks ? badge('🔴 ' + p.blocked_tasks, 'b-red') : '') +
        (p.hot_tasks ? badge('🔥 ' + p.hot_tasks, 'b-hot') : '') +
      '</div>';
    el.onclick = () => openProject(p.id);
    box.appendChild(el);
  });
  if (!box.children.length) box.innerHTML = '<p class="muted">Проєктів поки немає.</p>';
}

/* ---- Экран проекта (дашборд) ---- */
async function openProject(id) {
  hide('projects'); show('project');
  const { data: rows } = await sb.from('project_summary').select('*').eq('id', id).limit(1);
  const p = (rows && rows[0]) || {};
  $('pName').textContent = p.name || '';
  $('pMeta').textContent = [p.client, p.phase].filter(Boolean).join(' · ');

  const { data: tasks, error } = await sb.from('tasks').select('*').eq('project_id', id);
  if (error) { $('kanban').innerHTML = '<p class="err">' + esc(error.message) + '</p>'; return; }
  const T = tasks || [];

  // счётчики — из реальных задач (консистентно с доской)
  const counts = { todo: 0, in_progress: 0, review: 0, done: 0, blocked: 0 };
  T.forEach((t) => { if (counts[t.status] !== undefined) counts[t.status]++; });
  const total = T.length, done = counts.done;
  const hot = T.filter((t) => ['high', 'urgent'].includes(t.priority) && t.status !== 'done').length;

  const pct = total ? Math.round(done / total * 100) : 0;
  $('pctVal').textContent = pct + '%';
  $('pctBar').style.width = pct + '%';
  $('pctSub').textContent = done + ' / ' + total + ' задачі готові';
  $('kTodo').textContent = counts.todo;
  $('kProg').textContent = counts.in_progress;
  $('kBlock').textContent = counts.blocked;
  $('kHot').textContent = hot;

  renderDonut(counts, total, pct);
  renderOwners(T);
  renderAttn(T);
  renderBoard(T);
}

function legend(counts) {
  return '<div class="legend">' + DONUT_ORDER.map((k) =>
    '<span><i class="dot" style="background:' + ST[k].c + '"></i>' + ST[k].ic + ' ' + ST[k].label + ' <b>' + counts[k] + '</b></span>'
  ).join('') + '</div>';
}
function renderDonut(counts, total, pct) {
  const R = 52, C = 2 * Math.PI * R;
  let off = 0, segs = '';
  DONUT_ORDER.forEach((k) => {
    const len = total ? counts[k] / total * C : 0;
    if (len > 0) {
      segs += '<circle cx="75" cy="75" r="' + R + '" fill="none" stroke="' + ST[k].c + '" stroke-width="18" ' +
        'stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-off) + '" transform="rotate(-90 75 75)"/>';
      off += len;
    }
  });
  $('donut').innerHTML =
    '<div class="donut-wrap"><div class="donut">' +
      '<svg width="150" height="150" viewBox="0 0 150 150">' +
        '<circle cx="75" cy="75" r="52" fill="none" stroke="var(--surface-2)" stroke-width="18"/>' + segs +
      '</svg><div class="mid"><b>' + pct + '%</b><s>готово</s></div></div>' +
      legend(counts) + '</div>';
}
function renderOwners(T) {
  const active = T.filter((t) => t.status !== 'done');
  const map = {};
  active.forEach((t) => { const o = t.owner || '—'; map[o] = (map[o] || 0) + 1; });
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  $('owners').innerHTML = rows.length ? rows.map(([o, n]) =>
    '<div class="owner"><span class="chip">' + esc(o) + '</span>' +
    '<span class="b"><i style="width:' + (n / max * 100) + '%"></i></span>' +
    '<span class="n">' + n + '</span></div>').join('')
    : '<p class="muted small">Активних задач немає.</p>';
}
function renderAttn(T) {
  const blockers = T.filter((t) => t.status === 'blocked');
  const hots = T.filter((t) => ['high', 'urgent'].includes(t.priority) && t.status !== 'done' && t.status !== 'blocked');
  const row = (t, ic, extra) => '<div class="row"><span class="ic">' + ic + '</span><span>' + esc(t.title) +
    (extra ? ' — <span class="blk">' + esc(extra) + '</span>' : '') + '</span>' +
    '<span class="who">' + esc(t.owner || '—') + (t.stage ? ' · ' + esc(t.stage) : '') + '</span></div>';
  let html = '<h3>🔴 Потребує уваги (' + blockers.length + ' блок · ' + hots.length + ' гарячих)</h3>';
  if (!blockers.length && !hots.length) html += '<div class="ok">Немає заблокованих і гарячих задач 🎉</div>';
  html += blockers.map((t) => row(t, '🔴', t.blocker || 'причина не вказана')).join('');
  html += hots.map((t) => row(t, '🔥', '')).join('');
  $('attn').innerHTML = html;
}
function taskCard(t) {
  const mine = ME && t.owner === ME;
  const blk = t.status === 'blocked' ? ' <span class="blk">🔴 ' + esc(t.blocker || '') + '</span>' : '';
  const pr = (t.priority && t.priority !== 'normal') ? ' · ' + esc(t.priority.toUpperCase()) : '';
  return '<div class="task' + (mine ? ' mine' : '') + '" style="--pr:' + (PR[t.priority] || PR.normal) + '">' +
    '<div class="tt">' + esc(t.title) + '</div>' +
    '<div class="meta"><span class="own">' + esc(t.owner || '—') + '</span>' +
    (t.stage ? '<span>' + esc(t.stage) + '</span>' : '') + pr + blk + '</div></div>';
}
function renderBoard(T) {
  const nonEmpty = COL_ORDER.filter((k) => T.some((t) => t.status === k));
  let cols = nonEmpty.map((k) => {
    const items = T.filter((t) => t.status === k);
    return '<div class="col"><div class="colh" style="color:' + ST[k].c + '">' + ST[k].ic + ' ' + ST[k].label +
      '<span class="cnt">' + items.length + '</span></div>' + items.map(taskCard).join('') + '</div>';
  }).join('');
  const done = T.filter((t) => t.status === 'done').length;
  $('kanban').innerHTML = '<div class="cols">' + (cols || '<p class="muted small">Задач немає.</p>') + '</div>' +
    (done ? '<div class="collapsed">✓ Готово ' + done + ' — згорнуто</div>' : '');
}

/* ---- утилиты ---- */
function badge(txt, cls) { return '<span class="badge ' + (cls || '') + '">' + esc(txt) + '</span>'; }

$('signin').onclick = signIn;
$('logout').onclick = logout;
$('back').onclick = openProjects;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
boot();
