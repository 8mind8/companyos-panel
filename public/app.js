/* COMPANY_OS panel — логика SPA. v1 = READ-ONLY (решение 00): борд только на чтение.
   Модель безопасности: anon-ключ + RLS Supabase.
   - вход: Supabase Auth (email/пароль) → JWT с email (логин ОБЯЗАТЕЛЕН);
   - чтение борда: PostgREST (RLS: authenticated читает весь борд); anon — ничего.
   - записи из панели НЕТ (контролы смены статуса скрыты в v1). Смена статуса вернётся позже через
     RPC task_set_status (RLS-DEFINER: только свои задачи). Никаких service_role/секретов в браузере. */

const CFG = window.COMPANY_OS_CONFIG || {};
const STATUSES = ['todo', 'in_progress', 'blocked', 'review', 'done'];
const STATUS_RU = { todo: 'Очередь', in_progress: 'В работе', blocked: 'Блок', review: 'Ревью', done: 'Готово' };

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

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
  if (error) { $('loginErr').textContent = 'Не вышло войти: ' + error.message; return; }
  ME = data.user.email; onAuthed();
}

function onAuthed() {
  $('who').textContent = ME;
  show('logout');
  hide('login');
  openProjects();
}

async function logout() { await sb.auth.signOut(); ME = null; location.reload(); }

/* ---- Экран «Проекты» ---- */
async function openProjects() {
  hide('project'); show('projects');
  const { data, error } = await sb.from('project_summary').select('*').order('updated_at', { ascending: false });
  const box = $('projectCards');
  if (error) { box.innerHTML = '<p class="err">' + error.message + '</p>'; return; }
  box.innerHTML = '';
  (data || []).forEach((p) => {
    const el = document.createElement('div');
    el.className = 'card proj';
    el.innerHTML =
      '<div class="ptitle">' + esc(p.name) + '</div>' +
      '<div class="muted">' + esc(p.client || '') + ' · ' + esc(p.phase || '') + '</div>' +
      '<div class="focus">' + esc(p.current_focus || '—') + '</div>' +
      '<div class="badges">' +
        badge('в работе ' + (p.in_progress_tasks || 0)) +
        (p.blocked_tasks ? badge('🔴 блок ' + p.blocked_tasks, 'b-red') : '') +
        (p.review_tasks ? badge('ревью ' + p.review_tasks) : '') +
        (p.hot_tasks ? badge('🔥 ' + p.hot_tasks, 'b-hot') : '') +
        badge('открыто ' + (p.open_tasks || 0)) +
      '</div>';
    el.onclick = () => openProject(p.id);
    box.appendChild(el);
  });
  if (!box.children.length) box.innerHTML = '<p class="muted">Проектов пока нет.</p>';
}

/* ---- Экран проекта ---- */
async function openProject(id) {
  hide('projects'); show('project');
  const { data: rows } = await sb.from('project_summary').select('*').eq('id', id).limit(1);
  const p = (rows && rows[0]) || {};
  $('pName').textContent = p.name || '';
  $('pClient').textContent = p.client || '';
  $('pPhase').textContent = p.phase || '';
  $('pFocus').textContent = p.current_focus || '—';
  $('pNext').textContent = p.next_step || '—';

  const { data: tasks, error } = await sb.from('tasks').select('*').eq('project_id', id);
  if (error) { $('kanban').innerHTML = '<p class="err">' + error.message + '</p>'; return; }
  renderBlockers(tasks);
  renderKanban(id, tasks);
  renderFeed(tasks);
}

function renderBlockers(tasks) {
  const b = tasks.filter((t) => t.status === 'blocked');
  $('blockers').innerHTML = '<h3>🔴 Блокеры (' + b.length + ')</h3>' +
    (b.length ? '<ul>' + b.map((t) => '<li><b>' + esc(t.title) + '</b> — ' + esc(t.blocker || 'причина не указана') + '</li>').join('') + '</ul>'
              : '<p class="muted">Блокеров нет.</p>');
}

function renderKanban(projectId, tasks) {
  const k = $('kanban'); k.innerHTML = '';
  STATUSES.forEach((st) => {
    const col = document.createElement('div');
    col.className = 'col';
    col.innerHTML = '<div class="colh">' + STATUS_RU[st] + '</div>';
    tasks.filter((t) => t.status === st).forEach((t) => {
      const mine = ME && t.owner === ME;
      const card = document.createElement('div');
      card.className = 'task' + (mine ? ' mine' : ''); // свои задачи подсвечены (визуал; правки нет в v1)
      card.innerHTML = '<div>' + esc(t.title) + '</div>' +
        '<div class="muted small">' + esc(t.owner || 'без владельца') + (t.stage ? ' · ' + esc(t.stage) : '') +
        (t.priority && t.priority !== 'normal' ? ' · ' + esc(t.priority) : '') + '</div>';
      col.appendChild(card); // v1 READ-ONLY: контрол смены статуса не рендерим

    });
    k.appendChild(col);
  });
}

function renderFeed(tasks) {
  const recent = [...tasks].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)).slice(0, 12);
  $('feed').innerHTML = recent.map((t) =>
    '<li><span class="muted small">' + fmt(t.updated_at) + '</span> ' + esc(t.title) +
    ' → <b>' + STATUS_RU[t.status] + '</b></li>').join('') || '<li class="muted">Пусто.</li>';
}

/* ---- утилиты ---- */
function badge(txt, cls) { return '<span class="badge ' + (cls || '') + '">' + esc(txt) + '</span>'; }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmt(ts) { try { return new Date(ts).toLocaleString('uk-UA', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

$('signin').onclick = signIn;
$('logout').onclick = logout;
$('back').onclick = openProjects;
$('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') signIn(); });
boot();
