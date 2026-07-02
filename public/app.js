/* COMPANY_OS panel — v1 READ-ONLY (решение 00). Тёмный дашборд (Guided + донат + Kanban, 05)
   + доска-диспетчер: карточка несёт роль(и) и по клику разворачивает готовый мультиролевой ТЗ.
   Безопасность: anon-ключ + RLS. Вход обязателен. Записи из панели НЕТ (копирование ТЗ = буфер обмена,
   не запись в БД). tz_blocks грузится ПО КЛИКУ отдельным select (контракт 03c: тяжело для списка). */

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
const COL_ORDER = ['blocked', 'in_progress', 'review', 'todo']; // done — свёрнут
const CANON_BASE = 'https://github.com/8mind8/Vomnia/blob/master/agency/prompts/';
const ROLE = {
  '/00': ['Vomnia Director', '00_vomnia_director.md'], '/01': ['Project Director', '01_project_director.md'],
  '/02': ['Semantic Master', '02_semantic_master.md'], '/03a': ['Lovable Prompt Engineer', '03a_lovable_prompt_engineer.md'],
  '/03b': ['Frontend Coder', '03b_frontend_coder.md'], '/03c': ['Backend/Supabase', '03c_backend_supabase.md'],
  '/04': ['Integrator', '04_integrator.md'], '/05': ['Visual Arch', '05_visual_arch.md'],
  '/06': ['Growth Expert', '06_growth_expert.md'], '/07': ['QA Tester', '07_qa_tester.md'],
  '/08': ['Prompt Architect', '08_prompt_architect.md'], '/09': ['Content Producer', '09_content_producer.md'],
  '/10': ['SMM Manager', '10_smm_manager.md'], '/11': ['Legal Assistant', '11_legal_assistant.md'],
  '/12': ['Automation & Research', '12_automation.md'],
};

if (!CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY) {
  document.body.innerHTML = '<p class="err" style="padding:24px">Панель не сконфигурирована: нет SUPABASE_URL / SUPABASE_ANON_KEY в env заявки.</p>';
  throw new Error('no config');
}
const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
let ME = null, curTasks = [], curProjectId = null, curFilter = 'all';
const tzCache = {}; // taskId → [{role,tz}]

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
      '<div class="badges">' + badge('◐ ' + (p.in_progress_tasks || 0)) +
        (p.blocked_tasks ? badge('🔴 ' + p.blocked_tasks, 'b-red') : '') +
        (p.hot_tasks ? badge('🔥 ' + p.hot_tasks, 'b-hot') : '') + '</div>';
    el.onclick = () => openProject(p.id);
    box.appendChild(el);
  });
  if (!box.children.length) box.innerHTML = '<p class="muted">Проєктів поки немає.</p>';
}

/* ---- Экран проекта (дашборд) ---- */
async function openProject(id) {
  hide('projects'); show('project');
  curProjectId = id;
  const { data: rows } = await sb.from('project_summary').select('*').eq('id', id).limit(1);
  const p = (rows && rows[0]) || {};
  $('pName').textContent = p.name || '';
  $('pMeta').textContent = [p.client, p.phase].filter(Boolean).join(' · ');

  // список задач БЕЗ tz_blocks (тяжело) — role берём (нужен для чипов); tz грузим по клику
  const { data: tasks, error } = await sb.from('tasks')
    .select('id,title,status,owner,role,stage,priority,blocker,updated_at').eq('project_id', id);
  if (error) { $('kanban').innerHTML = '<p class="err">' + esc(error.message) + '</p>'; return; }
  curTasks = tasks || [];

  const counts = { todo: 0, in_progress: 0, review: 0, done: 0, blocked: 0 };
  curTasks.forEach((t) => { if (counts[t.status] !== undefined) counts[t.status]++; });
  const total = curTasks.length, done = counts.done;
  const hot = curTasks.filter((t) => ['high', 'urgent'].includes(t.priority) && t.status !== 'done').length;
  const pct = total ? Math.round(done / total * 100) : 0;
  $('pctVal').textContent = pct + '%';
  $('pctBar').style.width = pct + '%';
  $('pctSub').textContent = done + ' / ' + total + ' задачі готові';
  $('kTodo').textContent = counts.todo; $('kProg').textContent = counts.in_progress;
  $('kBlock').textContent = counts.blocked; $('kHot').textContent = hot;

  renderDonut(counts, total, pct);
  renderOwners(curTasks);
  renderAttn(curTasks);
  syncFilterButtons();
  renderBoard();
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
  $('donut').innerHTML = '<div class="donut-wrap"><div class="donut">' +
    '<svg width="150" height="150" viewBox="0 0 150 150"><circle cx="75" cy="75" r="52" fill="none" stroke="var(--surface-2)" stroke-width="18"/>' +
    segs + '</svg><div class="mid"><b>' + pct + '%</b><s>готово</s></div></div>' + legend(counts) + '</div>';
}
function renderOwners(T) {
  const active = T.filter((t) => t.status !== 'done');
  const map = {};
  active.forEach((t) => { const o = t.owner || '—'; map[o] = (map[o] || 0) + 1; });
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  $('owners').innerHTML = rows.length ? rows.map(([o, n]) =>
    '<div class="owner"><span class="chip">' + esc(o) + '</span><span class="b"><i style="width:' + (n / max * 100) + '%"></i></span><span class="n">' + n + '</span></div>'
  ).join('') : '<p class="muted small">Активних задач немає.</p>';
}
function renderAttn(T) {
  const blockers = T.filter((t) => t.status === 'blocked');
  const hots = T.filter((t) => ['high', 'urgent'].includes(t.priority) && t.status !== 'done' && t.status !== 'blocked');
  const row = (t, ic, extra) => '<div class="row"><span class="ic">' + ic + '</span><span>' + esc(t.title) +
    (extra ? ' — <span class="blk">' + esc(extra) + '</span>' : '') + '</span><span class="who">' +
    esc(t.owner || '—') + (t.stage ? ' · ' + esc(t.stage) : '') + '</span></div>';
  let html = '<h3>🔴 Потребує уваги (' + blockers.length + ' блок · ' + hots.length + ' гарячих)</h3>';
  if (!blockers.length && !hots.length) html += '<div class="ok">Немає заблокованих і гарячих задач 🎉</div>';
  html += blockers.map((t) => row(t, '🔴', t.blocker || 'причина не вказана')).join('');
  html += hots.map((t) => row(t, '🔥', '')).join('');
  $('attn').innerHTML = html;
}

/* ---- доска-диспетчер (карточки с ролями/ТЗ) + фильтр Мої/Всі ---- */
function setFilter(f) { curFilter = f; syncFilterButtons(); renderBoard(); }
function syncFilterButtons() {
  $('fAll').classList.toggle('on', curFilter === 'all');
  $('fMine').classList.toggle('on', curFilter === 'mine');
}
function visibleTasks() {
  return curFilter === 'mine' ? curTasks.filter((t) => t.owner && t.owner === ME) : curTasks;
}
function roleChips(roles) {
  return (roles || []).map((r) => '<span class="rchip">' + esc(r) + '</span>').join('');
}
function taskCard(t) {
  const mine = ME && t.owner === ME;
  const blk = t.status === 'blocked' ? ' <span class="blk">🔴 ' + esc(t.blocker || '') + '</span>' : '';
  const pr = (t.priority && t.priority !== 'normal') ? ' · ' + esc(t.priority.toUpperCase()) : '';
  const hasRoles = Array.isArray(t.role) && t.role.length;
  return '<div class="task' + (mine ? ' mine' : '') + (hasRoles ? ' expandable' : '') + '" data-id="' + t.id + '" style="--pr:' + (PR[t.priority] || PR.normal) + '">' +
    '<div class="tt">' + esc(t.title) + (hasRoles ? ' <span class="caret">▸</span>' : '') + '</div>' +
    '<div class="rchips">' + roleChips(t.role) + '</div>' +
    '<div class="meta"><span class="own">' + esc(t.owner || '—') + '</span>' +
    (t.stage ? '<span>' + esc(t.stage) + '</span>' : '') + pr + blk + '</div>' +
    '<div class="tzdetail hidden"></div></div>';
}
function renderBoard() {
  const T = visibleTasks();
  const nonEmpty = COL_ORDER.filter((k) => T.some((t) => t.status === k));
  const cols = nonEmpty.map((k) => {
    const items = T.filter((t) => t.status === k);
    return '<div class="col"><div class="colh" style="color:' + ST[k].c + '">' + ST[k].ic + ' ' + ST[k].label +
      '<span class="cnt">' + items.length + '</span></div>' + items.map(taskCard).join('') + '</div>';
  }).join('');
  const done = T.filter((t) => t.status === 'done').length;
  $('kanban').innerHTML = '<div class="cols">' + (cols || '<p class="muted small">Задач немає' + (curFilter === 'mine' ? ' (у фільтрі «Мої»)' : '') + '.</p>') + '</div>' +
    (done ? '<div class="collapsed">✓ Готово ' + done + ' — згорнуто</div>' : '');
}

/* разворот карточки: грузим tz_blocks по клику (контракт 03c) */
async function toggleCard(cardEl) {
  const det = cardEl.querySelector('.tzdetail');
  const id = cardEl.dataset.id;
  if (!det.classList.contains('hidden')) { det.classList.add('hidden'); cardEl.classList.remove('open'); return; }
  cardEl.classList.add('open'); det.classList.remove('hidden');
  if (det.dataset.loaded) return;
  det.innerHTML = '<div class="muted small">Завантаження ТЗ…</div>';
  let blocks = tzCache[id];
  if (!blocks) {
    const { data } = await sb.from('tasks').select('tz_blocks').eq('id', id).limit(1);
    blocks = (data && data[0] && data[0].tz_blocks) || [];
    tzCache[id] = blocks;
  }
  const task = curTasks.find((t) => t.id === id) || {};
  const roles = (task.role && task.role.length) ? task.role : blocks.map((b) => b.role);
  det.innerHTML = roles.map((code) => {
    const meta = ROLE[code] || [code, ''];
    const b = blocks.find((x) => x.role === code);
    const tz = b && b.tz ? b.tz : '';
    const canon = meta[1] ? '<a class="canon" href="' + CANON_BASE + meta[1] + '" target="_blank" rel="noopener">канон ↗</a>' : '';
    return '<div class="tzrole"><div class="tzhead">▸ <b>' + esc(code) + '</b> «' + esc(meta[0]) + '»</div>' +
      '<div class="tztext">' + (tz ? esc(tz) : '<span class="muted">ТЗ не задано</span>') + '</div>' +
      '<div class="tzbtns"><button type="button" class="copybtn" data-copy data-id="' + id + '" data-role="' + esc(code) + '">Копіювати</button>' + canon + '</div></div>';
  }).join('') || '<div class="muted small">Ролі/ТЗ не задано.</div>';
  det.dataset.loaded = '1';
}
function doCopy(btn) {
  const id = btn.dataset.id, code = btn.dataset.role;
  const b = (tzCache[id] || []).find((x) => x.role === code);
  const text = code + '\n' + (b && b.tz ? b.tz : '');
  const ok = () => { const o = btn.textContent; btn.textContent = 'Скопійовано ✓'; setTimeout(() => (btn.textContent = o), 1400); };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok).catch(() => fallbackCopy(text, ok));
  else fallbackCopy(text, ok);
}
function fallbackCopy(text, ok) {
  const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); ok(); } catch (e) {} document.body.removeChild(ta);
}
// делегирование кликов доски
$('kanban').addEventListener('click', (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { e.stopPropagation(); doCopy(copy); return; }
  if (e.target.closest('.canon')) return; // ссылка на канон — обычный переход
  const card = e.target.closest('.task.expandable');
  if (card) toggleCard(card);
});

/* ---- утилиты ---- */
function badge(txt, cls) { return '<span class="badge ' + (cls || '') + '">' + esc(txt) + '</span>'; }

$('signin').onclick = signIn;
$('logout').onclick = logout;
$('back').onclick = openProjects;
$('fAll').onclick = () => setFilter('all');
$('fMine').onclick = () => setFilter('mine');
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
boot();
