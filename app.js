// ═══════════════════════════════════════════════════
const SUPA_URL = 'https://ejljwgxdgoaejwaffxdv.supabase.co';
const SUPA_KEY = 'sb_publishable_0PZhEVmTnywUa11GNgW9NQ_QkEaCYcE';
// Worker використовується тільки для B24 фото і синхронізації
const API_URL  = 'https://dlight-dashboard.romashykhin.workers.dev';
const TEAMS_LIST = ['Беркут','Бухгалтерія','Ефективність','Кулібіни','Локомотив','Майстри ланцюгів','Медоїди','Портал знань','Ремкоплект','Синергія','Склад','Техкомпас','Тойота','Фіксики'];

// Supabase REST API хелпер
async function supa(table, params = '', method = 'GET', body = null) {
  const url = `${SUPA_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  // Для PATCH і DELETE теж просимо return=representation щоб перевірити що оновлення реально відбулось
  const prefer = (method === 'POST' || method === 'PATCH' || method === 'DELETE')
    ? 'return=representation' : 'return=minimal';
  const opts = {
    method,
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Prefer': prefer,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase ${method} ${table}: ${err}`);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  // Для PATCH/DELETE — якщо повернувся порожній масив, значить запис не знайдено
  if ((method === 'PATCH' || method === 'DELETE') && Array.isArray(data) && data.length === 0) {
    console.warn(`Supabase ${method} ${table}: 0 rows affected (filter: ${params})`);
    throw new Error('Запис не знайдено або не оновлено — можливо дані застарілі. Перезавантажте сторінку.');
  }
  return data;
}

async function supaGet(table, params = '') { return supa(table, params); }
async function supaPost(table, body) { return supa(table, '', 'POST', body); }
async function supaPatch(table, params, body) { return supa(table, params, 'PATCH', body); }
async function supaDelete(table, params) { return supa(table, params, 'DELETE'); }
async function supaUpsert(table, body, onConflict) {
  const conflictParam = onConflict ? `?on_conflict=${onConflict}` : '';
  const url = `${SUPA_URL}/rest/v1/${table}${conflictParam}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Content-Type': 'application/json',
      'Prefer': `resolution=merge-duplicates,return=representation`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase upsert ${table}: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
// ═══════════════════════════════════════════════════

const REFRESH_INTERVAL = 5 * 60 * 1000;
const DAYS_UK = ['Пн','Вт','Ср','Чт','Пт','Сб'];
const STATUS_LABELS = { done:'Вирішено', wip:'В роботі', over:'Прострочено', wait:'Очікує' };

let allProblems = [], allEscalations = [], allCorrective = [], allComments = [];
let currentTab = 'data', currentSubtype = 'problem';
let refreshTimer = null;
let charts = {};

// ── КОМАНДИ ───────────────────────────────────
function getSelectedTeam() {
  return document.getElementById('teamSelect')?.value || 'Тойота';
}

function onTeamChange() {
  // Зберігаємо тільки локально — не робимо запит до сервера
  try { sessionStorage.setItem('selected_team', getSelectedTeam()); } catch(e) {}
  // Скидаємо конфіг графіків до дефолту (завантажиться при loadData)
  chartConfigs = JSON.parse(JSON.stringify(DEFAULT_CHARTS));
  document.querySelectorAll('#chartTabRow .mtab').forEach((btn,i) => {
    btn.textContent = 'Графік '+(i+1);
  });
  // Скасовуємо попередній refreshTimer щоб не перезаписав дані нової команди старими
  clearTimeout(refreshTimer);
  loadData(false); // нова команда — спробуємо кеш
  // Оновлюємо секцію пропозицій для нової команди (якщо вже завантажені)
  if (typeof renderTeamProposals === 'function' && allProposals && allProposals.length !== undefined) {
    renderTeamProposals();
  }
}


// ════════════════════════════════════════════════
// ЛІДЕРБОРД "ПЛЮШКА"
// ════════════════════════════════════════════════
let lbVisible = false;
let lbData = null;
let lbRawData = null; // всі рядки з таблиці (усі місяці)


// ── ПРАВИЛА ПЛЮШКИ ────────────────────────────
function openRules() {
  document.getElementById('rulesModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeRules() {
  document.getElementById('rulesModal').classList.remove('open');
  document.body.style.overflow = '';
}
function closeRulesOutside(e) {
  if (e.target === document.getElementById('rulesModal')) closeRules();
}
function openCalc() {
  document.getElementById('calcModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeCalc() {
  document.getElementById('calcModal').classList.remove('open');
  document.body.style.overflow = '';
}
let lbSelectedPeriod = 'total'; // 'total' | 'Червень' | 'Липень' | ...

function toggleLeaderboard() {
  lbVisible = !lbVisible;
  document.getElementById('leaderboardPanel').style.display = lbVisible ? 'block' : 'none';
  document.getElementById('mainDash').style.display = lbVisible ? 'none' : 'block';
  document.getElementById('lbTabBtn').classList.toggle('lb-active', lbVisible);
  if (lbVisible && !lbRawData) loadLeaderboard();
}

function changeLbPeriod(period) {
  lbSelectedPeriod = period;
  if (lbRawData) renderLeaderboard(lbRawData);
}

// Знаходить унікальні місяці з даних, повертає у порядку появи
function lbGetAvailableMonths(raw) {
  const seen = new Set();
  const months = [];
  raw.forEach(r => {
    if (r.month && !seen.has(r.month)) {
      seen.add(r.month);
      months.push(r.month);
    }
  });
  return months;
}

// Агрегує (сумує) значення для команди за всі місяці
function lbAggregateAll(raw) {
  const byTeam = new Map();
  raw.forEach(r => {
    if (!r.name) return;
    let t = byTeam.get(r.name);
    if (!t) {
      t = {
        name: r.name,
        tasksGreen: 0, partnerAgreements: 0, reactionViol: 0,
        dashboardData: 0, proposals: 0, totalScore: 0,
        likes: 0, money: 0, members: 0, totalMoney: 0,
        month: 'Всього',
      };
      byTeam.set(r.name, t);
    }
    t.tasksGreen        += r.tasksGreen;
    t.partnerAgreements += r.partnerAgreements;
    t.reactionViol      += r.reactionViol;
    t.dashboardData     += r.dashboardData;
    t.proposals         += r.proposals;
    t.totalScore        += r.totalScore;
    t.likes             += r.likes;
    t.money             += r.money;
    t.totalMoney        += r.totalMoney;
    // Кількість учасників беремо максимальну (не сумуємо, бо це одні й ті самі люди)
    if (r.members > t.members) t.members = r.members;
  });
  // Округлимо лайти до 1 знака
  return Array.from(byTeam.values()).map(t => ({ ...t, likes: Math.round(t.likes * 10) / 10 }));
}

async function loadLeaderboard() {
  document.getElementById('lbContent').innerHTML = `
    <div style="text-align:center;padding:40px;color:var(--c-muted);font-family:var(--mono)">
      <div style="width:32px;height:32px;border:3px solid var(--c-border);border-top-color:#1a1f36;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 12px"></div>
      Завантаження лідерборду...
    </div>`;
  try {
    const SHEET_ID = '1OzcA_9PA_YI6owQy-zuLFgv0vTVCCF6GCK95527COhE';
    const GID      = '599275599';
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&gid=${GID}`;

    const res  = await fetch(url);
    const text = await res.text();
    // Google Sheets JSONP: /*O_o*/\ngoogle.visualization.Query.setResponse({...});
    let jsonStr = text;
    // Прибираємо все до першої {
    const start = text.indexOf('{');
    // Прибираємо все після останньої }
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error('Невірний формат відповіді Google Sheets');
    jsonStr = text.substring(start, end + 1);
    console.log('LB raw (перші 200):', text.substring(0, 200));
    const json = JSON.parse(jsonStr);
    const rows = json.table.rows;
    console.log('LB rows count:', rows.length);
    if (rows.length > 0) {
      console.log('LB row[0] full:', JSON.stringify(rows[0]));
      console.log('LB row[1] full:', JSON.stringify(rows[1]));
      console.log('LB row[2] full:', JSON.stringify(rows[2]));
      console.log('LB row[3] full:', JSON.stringify(rows[3]));
      console.log('LB cols:', JSON.stringify(json.table.cols));
    }

    const teams = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i].c;
      if (!row) continue;
      // C(idx=2) = назва команди
      const nameCell = row[2];
      if (!nameCell || nameCell.v === null || nameCell.v === undefined) continue;
      const name = String(nameCell.v||'').trim();
      if (!name || name.length < 2) continue;
      if (['команди','команда','#','№'].includes(name.toLowerCase())) continue;

      const get = (idx) => {
        if (!row[idx] || row[idx].v === null || row[idx].v === undefined) return 0;
        return parseFloat(row[idx].v) || 0;
      };
      const getStr = (idx) => {
        if (!row[idx] || row[idx].v === null) return '';
        return String(row[idx].v||'').trim();
      };

      teams.push({
        name,
        tasksGreen:        get(3),   // D
        partnerAgreements: get(4),   // E
        reactionViol:      get(5),   // F
        dashboardData:     get(6),   // G
        proposals:         get(7),   // H
        totalScore:        get(8),   // I
        likes:             get(9),   // J
        money:             get(10),  // K
        members:           get(11),  // L
        totalMoney:        get(12),  // M
        month:             getStr(13), // N — місяць рядка
      });
    }

    // Зберігаємо СИРІ дані (всі рядки за всі місяці) для фільтрації
    lbRawData = teams;
    lbData = teams; // для сумісності зі старим кодом
    console.log('LB loaded rows:', teams.length);
    renderLeaderboard(teams);
  } catch(e) {
    document.getElementById('lbContent').innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--c-red);font-family:var(--mono)">
        Помилка: ${e.message}<br>
        <small style="color:var(--c-muted)">Переконайся що таблиця публічна (Переглядач)</small><br>
        <button onclick="loadLeaderboard()" style="margin-top:12px;font-family:var(--mono);padding:6px 16px;border:1px solid var(--c-red);background:transparent;color:var(--c-red);border-radius:4px;cursor:pointer">Повторити</button>
      </div>`;
  }
}

function renderLeaderboard(rawTeams) {
  if (!rawTeams || !rawTeams.length) {
    document.getElementById('lbContent').innerHTML = '<div style="text-align:center;padding:40px;color:var(--c-muted)">Немає даних</div>';
    return;
  }

  // Фільтруємо/агрегуємо залежно від обраного періоду
  const isTotal = lbSelectedPeriod === 'total';
  let teams;
  if (isTotal) {
    teams = lbAggregateAll(rawTeams);
  } else {
    teams = rawTeams.filter(t => t.month === lbSelectedPeriod);
  }
  teams.sort((a,b) => b.totalScore - a.totalScore);

  if (!teams.length) {
    // На випадок якщо для обраного місяця немає даних
    const availableMonths = lbGetAvailableMonths(rawTeams);
    const monthOptions = availableMonths.map(m =>
      `<option value="${escHtmlAttr(m)}" ${lbSelectedPeriod === m ? 'selected' : ''}>${escHtml(m)} 2026</option>`
    ).join('');
    document.getElementById('lbContent').innerHTML = `
      <div class="lb-hero">
        <div class="lb-hero-title">🏆 ЛІДЕРБОРД «ПЛЮШКА»</div>
        <div style="margin-top:12px;display:flex;justify-content:center;gap:8px;align-items:center">
          <span style="font-family:var(--mono);font-size:11px;color:rgba(245,197,24,.75)">Період:</span>
          <select onchange="changeLbPeriod(this.value)" style="font-family:var(--mono);font-size:12px;padding:6px 12px;border-radius:6px;border:1px solid rgba(245,197,24,.35);background:rgba(255,255,255,.08);color:#f5c518;cursor:pointer;outline:none">
            <option value="total">📊 Загальні показники</option>
            ${monthOptions}
          </select>
        </div>
      </div>
      <div style="text-align:center;padding:40px;color:var(--c-muted)">Немає даних за обраний період</div>`;
    return;
  }

  const maxScore   = Math.max(...teams.map(t => t.totalScore), 1);
  const totalMoney = teams.reduce((s,t) => s + t.totalMoney, 0);
  const totalLikes = teams.reduce((s,t) => s + t.likes, 0);
  const activeTeams = teams.length;
  const medals = ['🥇','🥈','🥉'];
  const barColors = ['#f5c518','#1a9e5c','#1a6fb5','#c0392b','#8e44ad','#e67e22','#27ae60','#2980b9','#e74c3c','#9b59b6','#f39c12','#16a085','#2c3e50','#d35400','#7f8c8d','#1abc9c'];

  // Побудова динамічного дропдауна місяців
  const availableMonths = lbGetAvailableMonths(rawTeams);
  const monthOptions = availableMonths.map(m =>
    `<option value="${escHtmlAttr(m)}" ${lbSelectedPeriod === m ? 'selected' : ''}>${escHtml(m)} 2026</option>`
  ).join('');

  const periodLabel = isTotal ? 'Загальні показники' : `${lbSelectedPeriod} 2026`;
  const periodSub   = isTotal
    ? 'Рейтинг команд за весь період змагання (сума за всі місяці)'
    : `Рейтинг команд за ${lbSelectedPeriod.toLowerCase()} 2026`;

  let html = `
    <div class="lb-hero">
      <div class="lb-hero-title">🏆 ЛІДЕРБОРД «ПЛЮШКА» — ${periodLabel}</div>
      <div class="lb-hero-sub">${periodSub}</div>
      <div style="margin-top:12px;display:flex;justify-content:center;gap:8px;align-items:center">
        <span style="font-family:var(--mono);font-size:11px;color:rgba(245,197,24,.75)">Період:</span>
        <select onchange="changeLbPeriod(this.value)"
                style="font-family:var(--mono);font-size:12px;padding:6px 12px;border-radius:6px;border:1px solid rgba(245,197,24,.35);background:rgba(255,255,255,.08);color:#f5c518;cursor:pointer;outline:none">
          <option value="total" ${isTotal ? 'selected' : ''}>📊 Загальні показники</option>
          ${monthOptions}
        </select>
      </div>
    </div>

    <div class="lb-stats">
      <div class="lb-stat">
        <div class="lb-stat-val" style="color:var(--c-green)">₴${totalMoney.toLocaleString('uk-UA')}</div>
        <div class="lb-stat-lbl">Загальний призовий фонд</div>
      </div>
      <div class="lb-stat">
        <div class="lb-stat-val" style="color:#d4a017">${totalLikes.toLocaleString('uk-UA')}</div>
        <div class="lb-stat-lbl">Всього лайтів</div>
      </div>
      <div class="lb-stat">
        <div class="lb-stat-val">${activeTeams}</div>
        <div class="lb-stat-lbl">Команд у грі</div>
      </div>
    </div>
    <div class="lb-table-wrap">
      <table class="lb-table">
        <thead><tr>
          <th style="width:44px">#</th>
          <th class="th-left">Команда</th>
          ${isTotal ? '' : `
          <th>Задачі<br><span style="font-size:9px;opacity:.7">/30</span></th>
          <th>Угоди<br><span style="font-size:9px;opacity:.7">/5</span></th>
          <th>Реакція<br><span style="font-size:9px;opacity:.7">/25</span></th>
          <th>Дашборд<br><span style="font-size:9px;opacity:.7">/20</span></th>
          <th>Пропозиції<br><span style="font-size:9px;opacity:.7">/20</span></th>
          <th>Бали</th>`}
          <th title="Всього лайтів у команди — сума нарахованих балів у вигляді лайтів (1 бал = 0,1 лайта)">👍</th>
          <th title="Грошей на кожного учасника команди (розрахунок індивідуального виграшу)">₴/ос</th>
          <th title="Всього грошовий фонд команди — сума грошей за всіх учасників (₴/ос × кількість учасників)">Всього ₴</th>
        </tr></thead>
        <tbody>`;

  teams.forEach((t, i) => {
    const rank = i + 1;
    const pct  = maxScore > 0 ? Math.round(t.totalScore / maxScore * 100) : 0;
    const col  = barColors[i % barColors.length];
    const rankEl = rank <= 2
      ? `<span class="lb-rank lb-rank-${rank}" style="font-size:22px;font-weight:800">${rank}</span>`
      : `<span class="lb-rank lb-rank-n">${rank}</span>`;
    const rowBg = rank===1 ? 'background:linear-gradient(90deg,#fffbeb,#fff)' :
                  rank===2 ? 'background:linear-gradient(90deg,#f8f8f8,#fff)' : '';
    const note = t.note ? `<br><span class="lb-note">⭐ ${t.note}</span>` : '';
    // Показуємо всі значення: >0 зелений, 0 чорний, <0 червоний
    const v = x => {
      if (x === null || x === undefined) return `<span style="color:var(--c-border)">—</span>`;
      let cls = 'lb-val';
      if (x > 0)      cls += ' lb-val-pos';
      else if (x < 0) cls += ' lb-val-neg';
      else            cls += ' lb-val-zero';
      return `<span class="${cls}">${x}</span>`;
    };

    html += `<tr style="${rowBg}">
      <td style="text-align:center">${rankEl}</td>
      <td class="lb-team">${t.name}${note}</td>
      ${isTotal ? '' : `
      <td>${v(t.tasksGreen)}</td>
      <td>${v(t.partnerAgreements)}</td>
      <td>${v(t.reactionViol)}</td>
      <td>${v(t.dashboardData)}</td>
      <td>${v(t.proposals)}</td>
      <td>
        <span class="lb-score">${t.totalScore}</span>
        <div class="lb-bar-bg"><div class="lb-bar" style="width:${pct}%;background:${col}"></div></div>
      </td>`}
      <td>${v(t.likes)}</td>
      <td>${v(t.money)}</td>
      <td>${t.totalMoney !== null && t.totalMoney !== undefined ? `<span class="lb-money ${t.totalMoney > 0 ? 'lb-val-pos' : t.totalMoney < 0 ? 'lb-val-neg' : 'lb-val-zero'}">₴${t.totalMoney.toLocaleString('uk-UA')}</span>` : '<span style="color:var(--c-border)">—</span>'}</td>
    </tr>`;
  });

  html += '</tbody></table></div>';
  document.getElementById('lbContent').innerHTML = html;
}

// ════════════════════════════════════════════════
// УЧАСНИКИ КОМАНДИ
// ════════════════════════════════════════════════
let teamMembers  = [];  // поточні учасники команди
let allB24Users  = [];  // всі співробітники з B24
let b24Loaded    = false;

async function loadTeamMembers() {
  try {
    const team = getSelectedTeam();
    const CACHE_KEY = 'members_' + team;
    const CACHE_TTL = 5 * 60 * 1000;

    // sessionStorage кеш
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, ts } = JSON.parse(cached);
        if (Date.now() - ts < CACHE_TTL) {
          teamMembers = data.members || [];
          renderTeamMembers();
          const cnt = teamMembers.length;
          setText('kpiMV', cnt || '—');
          setDelta('kpiMVDelta', cnt ? cnt + ' осіб у команді' : 'ще не додано', cnt ? 'up' : '');
          return;
        }
      }
    } catch(e) {}

    const rows = await supaGet('team_members', `team=eq.${encodeURIComponent(team)}&select=b24_id,name,position,photo`);
    const data = { members: (rows||[]).map(r => ({ id: r.b24_id, name: r.name, position: r.position, photo: r.photo })) };
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch(e) {}

    teamMembers = data.members || [];
    renderTeamMembers();
    const cnt = teamMembers.length;
    setText('kpiMV', cnt || '—');
    setDelta('kpiMVDelta', cnt ? cnt + ' осіб у команді' : 'ще не додано', cnt ? 'up' : '');
  } catch(e) {
    console.warn('Учасники:', e.message);
  }
}

// Стискаємо фото через Cloudflare Worker (webp 100px)
function thumbUrl(url, size) {
  if (!url) return '';
  // Проксіюємо через наш Worker який стискає до webp
  return `${API_URL}?action=photo&url=${encodeURIComponent(url)}`;
}

function renderTeamMembers() {
  const grid = document.getElementById('membersGrid');
  const count = document.getElementById('memberCount');
  if (!grid) return;

  if (count) count.textContent = teamMembers.length ? `${teamMembers.length} осіб` : '';

  if (!teamMembers.length) {
    grid.innerHTML = `<div style="color:var(--c-muted);font-size:12px;font-family:var(--mono);padding:8px">
      Учасників ще не додано — натисни "+ Додати учасника"</div>`;
    return;
  }

  grid.innerHTML = teamMembers.map((m, i) => {
    const initials = (m.name||'').split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const photoUrl = m.photo ? thumbUrl(m.photo, 100) : '';
    const avatar = photoUrl
      ? `<img class="member-avatar" src="${photoUrl}" loading="lazy" decoding="async" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" alt="" width="52" height="52">`
      : '';
    const placeholder = `<div class="member-avatar-placeholder" ${m.photo?'style="display:none"':''}>${initials}</div>`;
    return `<div class="member-card">
      <button class="member-remove" onclick="removeMember(${i})" title="Видалити">×</button>
      ${avatar}${placeholder}
      <div class="member-name">${m.name||'—'}</div>
      <div class="member-pos">${m.position||''}</div>
    </div>`;
  }).join('');
}

function removeMember(i) {
  teamMembers.splice(i, 1);
  renderTeamMembers();
  saveTeamMembersToSheets();
}

async function saveTeamMembersToSheets() {
  try {
    sessionStorage.removeItem('members_' + getSelectedTeam());
    const team = getSelectedTeam();
    await supaDelete('team_members', `team=eq.${encodeURIComponent(team)}`);
    if (teamMembers.length) {
      await supaPost('team_members', teamMembers.map(m => ({ team, b24_id: m.id, name: m.name, position: m.position, photo: m.photo })));
    }
    showToast('Учасників збережено', 'success');
  } catch(e) {
    showToast('Помилка збереження', 'error');
  }
}

// ── ПАНЕЛЬ ДОДАВАННЯ ─────────────────────────
function openMembersPanel() {
  document.getElementById('membersPanel').style.display = 'block';
  document.getElementById('membersSearch').focus();
  if (!b24Loaded) loadB24Users();
}

function closeMembersPanel() {
  document.getElementById('membersPanel').style.display = 'none';
  document.getElementById('membersDropdown').classList.remove('open');
}

async function loadB24Users() {
  const drop = document.getElementById('membersDropdown');
  drop.innerHTML = '<div style="padding:10px 12px;color:var(--c-muted);font-size:12px">Завантаження...</div>';
  drop.classList.add('open');
  try {
    const res  = await fetch(`${API_URL}?action=getB24Users`);
    const data = await res.json();
    allB24Users = data.users || [];
    b24Loaded = true;
    filterB24Users('');
  } catch(e) {
    drop.innerHTML = `<div style="padding:10px 12px;color:var(--c-red);font-size:12px">Помилка: ${e.message}</div>`;
  }
}

async function syncB24Users() {
  showToast('Синхронізація з Bitrix24...', '');
  b24Loaded = false;
  allB24Users = [];
  await loadB24Users();
  showToast('Список оновлено', 'success');
}

function openMembersDropdown() {
  if (allB24Users.length) {
    document.getElementById('membersDropdown').classList.add('open');
    filterB24Users(document.getElementById('membersSearch').value);
  } else {
    loadB24Users();
  }
}

function filterB24Users(query) {
  const drop = document.getElementById('membersDropdown');
  if (!allB24Users.length) return;
  drop.classList.add('open');

  const q = query.toLowerCase().trim();
  const existing = new Set(teamMembers.map(m => m.id));
  const filtered = allB24Users
    .filter(u => !existing.has(u.id))
    .filter(u => !q || u.name.toLowerCase().includes(q) || (u.position||'').toLowerCase().includes(q))
    .slice(0, 20);

  if (!filtered.length) {
    drop.innerHTML = '<div style="padding:10px 12px;color:var(--c-muted);font-size:12px">Не знайдено</div>';
    return;
  }

  drop.innerHTML = filtered.map((u, idx) => {
    const initials = u.name.split(' ').map(w=>w[0]).join('').slice(0,2).toUpperCase();
    const avatarEl = u.photo
      ? `<img src="${u.photo}" onerror="this.style.display='none'" style="width:28px;height:28px;border-radius:50%;object-fit:cover">`
      : `<div style="width:28px;height:28px;border-radius:50%;background:#1a1f36;color:#f5c518;display:flex;align-items:center;justify-content:center;font-size:11px;font-family:var(--mono)">${initials}</div>`;
    return `<div class="members-option" data-idx="${idx}" style="cursor:pointer">
      ${avatarEl}
      <div class="members-option-info">
        <div class="members-option-name">${u.name}</div>
        <div class="members-option-pos">${u.position||'—'}</div>
      </div>
    </div>`;
  }).join('');

  // Зберігаємо відфільтрований список для кліку
  drop._filtered = filtered;

  // Обробник кліку через делегування
  drop.onclick = (e) => {
    const opt = e.target.closest('.members-option');
    if (!opt) return;
    const idx = +opt.dataset.idx;
    const u = drop._filtered[idx];
    if (u) addMemberFromB24(u.id, u.name, u.position, u.photo);
  };
}

function addMemberFromB24(id, name, position, photo) {
  if (teamMembers.find(m => m.id === id)) {
    showToast('Учасник вже в команді', '');
    return;
  }
  teamMembers.push({ id: String(id), name: String(name||''), position: String(position||''), photo: String(photo||'') });
  renderTeamMembers();
  saveTeamMembersToSheets();
  filterB24Users(document.getElementById('membersSearch')?.value || '');
  const s = document.getElementById('membersSearch');
  if (s) s.value = '';
  showToast(name + ' додано до команди', 'success');
}

function escHtmlAttr(str) {
  return String(str||'').replace(/'/g,'&#39;').replace(/"/g,'&quot;');
}

function escHtml(str) {
  return String(str||'')
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// Закрити dropdown при кліку поза
document.addEventListener('click', e => {
  const panel = document.getElementById('membersPanel');
  const drop  = document.getElementById('membersDropdown');
  if (drop && !panel?.contains(e.target)) drop.classList.remove('open');
});

async function loadSavedTeam() {
  // Тільки sessionStorage — без мережевих запитів
  try {
    const local = sessionStorage.getItem('selected_team');
    if (local) {
      const sel = document.getElementById('teamSelect');
      if (sel) {
        for (let opt of sel.options) {
          if (opt.value === local || opt.text === local) { sel.value = opt.value; break; }
        }
      }
    }
  } catch(e) {}
}

// ════════════════════════════════════════════════
// ЗАВАНТАЖЕННЯ ДАНИХ
// ════════════════════════════════════════════════
async function loadData(forceReload = false) {
  showLoading(true); hideError();
  // Фіксуємо команду на момент виклику — якщо користувач перемкне поки йде запит, не рендеримо
  const requestedTeam = getSelectedTeam();
  try {
    const team = requestedTeam;
    const CACHE_KEY = 'dash_' + team;
    const CACHE_TTL = 10 * 60 * 1000;

    // Перевіряємо кеш
    if (!forceReload) {
      try {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) {
          const { data, ts } = JSON.parse(cached);
          const age = Date.now() - ts;
          if (age < CACHE_TTL) {
            // Перевіряємо що команда не змінилась поки читали кеш
            if (getSelectedTeam() !== requestedTeam) { showLoading(false); return; }
            renderAll(data);
            loadTeamMembers();
            setUpdateTime(new Date(ts));
            setDotOk();
            showLoading(false);
            if (age > 3 * 60 * 1000) setTimeout(() => { if (getSelectedTeam() === requestedTeam) loadData(true); }, 100);
            else { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => loadData(true), REFRESH_INTERVAL); }
            return;
          }
        }
      } catch(e) {}
    }

    // Паралельно завантажуємо всі дані з Supabase
    const enc = encodeURIComponent(team);
    const [
      configRows, chartDataRows, problemRows,
      correctiveRows, escalationRows, commentRows,
      chartsConfigRows, agreementsRows
    ] = await Promise.all([
      supaGet('team_config',   `team=eq.${enc}&select=key,value`),
      supaGet('chart_data',    `team=eq.${enc}&select=chart_idx,label,value,plan&order=created_at.asc`),
      supaGet('problems',      `team=eq.${enc}&select=*&order=created_at.desc`),
      supaGet('corrective',    `team=eq.${enc}&select=*&order=created_at.desc`),
      supaGet('escalations',   `team=eq.${enc}&select=*&order=created_at.desc`),
      supaGet('comments',      `team=eq.${enc}&select=*&order=created_at.desc`),
      supaGet('charts_config', `team=eq.${enc}&select=config`),
      supaGet('agreements',    `or=(team_a.eq.${enc},team_b.eq.${enc})&select=*`),
    ]);

    // Формуємо конфігурацію
    const cfg = {};
    (configRows||[]).forEach(r => cfg[r.key] = r.value);

    // Групуємо дані графіків по індексу
    const charts = [0,1,2,3,4].map(i =>
      (chartDataRows||[]).filter(r => r.chart_idx === i)
        .map(r => ({ label: fmtLabel(r.label), value: r.value, plan: r.plan }))
    );

    // Рахуємо угоди
    const agRows = agreementsRows || [];
    const today = new Date(); today.setHours(0,0,0,0);
    const isExp = d => { if (!d) return false; const p = d.split('.'); return p.length===3 && new Date(+p[2],+p[1]-1,+p[0]) < today; };
    const activeCnt = agRows.filter(r => r.accepted_us && r.accepted_partner && !isExp(r.valid_until)).length;
    const inactiveCnt = agRows.filter(r => !r.accepted_us || !r.accepted_partner || isExp(r.valid_until)).length;
    const problemAg = agRows.filter(r => !r.accepted_us || !r.accepted_partner || isExp(r.valid_until))
      .map(r => ({
        partner: r.team_a === team ? r.team_b : r.team_a,
        desc: r.description || '',
        date: r.valid_until || '',
        acceptedUs: r.accepted_us,
        acceptedPartner: r.accepted_partner,
        status: isExp(r.valid_until) ? 'over' : (!r.accepted_us && !r.accepted_partner) ? 'over' : 'wait',
      }));

    const data = {
      team,
      meta: {
        month: cfg.month || '',
        teamName: cfg.teamName || team,
        companyMission: cfg.companyMission || '',
        companyValues: cfg.companyValues || '',
        teamMission: cfg.teamMission || '',
        teamGoal: cfg.teamGoal || '',
        teamValues: cfg.teamValues || '',
      },
      monthly:     [],
      daily:       [],
      weekly:      [],
      problems:    (problemRows||[]).map(r => ({ date:r.date, description:r.description, action:r.action, responsible:r.responsible, comment:r.comment, status:r.status, id:r.id })),
      corrective:  (correctiveRows||[]).map(r => ({ date:r.date, description:r.description, responsible:r.responsible, deadline:r.deadline, status:r.status, id:r.id, source_problem_id:r.source_problem_id })),
      escalations: (escalationRows||[]).map(r => ({ date:r.date, description:r.description, responsible:r.responsible, status:r.status, id:r.id })),
      partners:    [],
      comments:    (commentRows||[]).map(r => ({ date:r.date, description:r.description, text:r.description, source:r.author, author:r.author, status:r.status, id:r.id })),
      charts,
      agreements:  { active: activeCnt, inactive: inactiveCnt, problem: problemAg, configured: true },
      chartsConfig: chartsConfigRows?.[0]?.config || null,
      updatedAt:   new Date().toISOString(),
    };

    // Кешуємо
    try { sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data, ts: Date.now() })); } catch(e) {}

    // Перевіряємо що команда не змінилась поки йшли запити до Supabase
    if (getSelectedTeam() !== requestedTeam) {
      console.warn('loadData: команду змінено під час запиту', requestedTeam, '→', getSelectedTeam());
      showLoading(false);
      return;
    }

    renderAll(data);
    loadTeamMembers();
    setUpdateTime(new Date());
    setDotOk();
  } catch(err) {
    showError('Помилка: ' + err.message);
    setDotError();
    console.error(err);
  } finally {
    showLoading(false);
  }
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadData(true), REFRESH_INTERVAL);
}

function renderAll(data) {
  // БАГ 5: захист від рендеру неправильної команди (race condition / стара відповідь)
  const currentTeam = getSelectedTeam();
  if (data && data.team && data.team !== currentTeam) {
    console.warn('renderAll: відкинуто дані команди', data.team, '— зараз вибрана', currentTeam);
    return;
  }
  fullData = data;
  cachedFullData = data;
  // Завантажуємо конфіг графіків ПЕРЕД рендером KPI
  if (data.chartsConfig && Array.isArray(data.chartsConfig) && data.chartsConfig.length > 0) {
    chartConfigs = data.chartsConfig;
    document.querySelectorAll('#chartTabRow .mtab').forEach((btn,i) => {
      btn.textContent = chartConfigs[i]?.title || ('Графік '+(i+1));
    });
  } else {
    // Якщо конфіг не прийшов — ресетимо до дефолту
    chartConfigs = JSON.parse(JSON.stringify(DEFAULT_CHARTS));
  }
  renderMeta(data.meta);
  applyMonthFilter(data);
}

// ── МІСЯЦЬ → номер (для фільтрації дат) ──────────
const MONTH_MAP = {
  'Січень':1,'Лютий':2,'Березень':3,'Квітень':4,'Травень':5,'Червень':6,
  'Липень':7,'Серпень':8,'Вересень':9,'Жовтень':10,'Листопад':11,'Грудень':12
};

let fullData = null;       // повні дані з API (ніколи не фільтруються)
let cachedFullData = null; // відфільтровані дані для графіків

function onMonthChange() {
  if (fullData) applyMonthFilter(fullData);
}

function getSelectedMonth() {
  return document.getElementById('monthSelect').value;
}

function applyMonthFilter(data) {
  const period = getSelectedMonth();
  // period може бути: "" (всі), "Червень" (старий формат - тільки місяць), або "Червень 2026"
  let mNum = null, yNum = null;
  if (period) {
    const parts = period.split(' ');
    const monthName = parts[0];
    mNum = MONTH_MAP[monthName] || null;
    if (parts[1] && /^\d{4}$/.test(parts[1])) yNum = parseInt(parts[1], 10);
  }

  function matchesPeriod(dateStr) {
    if (!dateStr || !mNum) return true;
    const s = String(dateStr);
    // Формат "dd.mm.yyyy"
    const p1 = s.split('.');
    if (p1.length >= 2 && /^\d{1,2}$/.test(p1[1])) {
      if (parseInt(p1[1], 10) !== mNum) return false;
      if (yNum && p1[2] && parseInt(p1[2], 10) !== yNum) return false;
      return true;
    }
    // Формат "yyyy-mm-dd"
    const p2 = s.match(/^(\d{4})-(\d{2})-\d{2}/);
    if (p2) {
      if (parseInt(p2[2], 10) !== mNum) return false;
      if (yNum && parseInt(p2[1], 10) !== yNum) return false;
      return true;
    }
    return true;
  }

  function filterByDate(arr) {
    if (!arr || !period) return arr || [];
    return arr.filter(r => matchesPeriod(r.date));
  }

  // Фільтруємо дані графіків по місяцю+року
  function filterCharts(charts) {
    if (!charts || !period) return charts || [];
    return charts.map(chartArr =>
      (chartArr || []).filter(r => matchesPeriod(r.label))
    );
  }

  const daily    = data.daily || [];
  const weekly   = data.weekly || [];
  const problems = data.problems || [];
  const escals   = data.escalations || [];
  const corr     = data.corrective || [];
  const comments = data.comments || [];
  const monthly  = data.monthly || [];
  // Тільки графіки фільтруються по місяцю
  const charts   = filterCharts(data.charts);

  // cachedFullData = дані з відфільтрованими графіками
  cachedFullData = { ...data, daily, weekly, problems,
    escalations: escals, corrective: corr, comments, monthly, charts };

  renderKPI(daily, problems, data.partners, comments, charts);
  renderAllUserCharts(cachedFullData);

  allProblems    = problems;
  allEscalations = escals;
  allCorrective  = corr;
  allComments    = comments;
  renderProblems(allProblems, 'all');
  document.querySelectorAll('.filter-bar .chip').forEach((b,i)=>b.classList.toggle('active',i===0));
  renderEscalations(allEscalations);
  renderPartners(data.partners || [], data.agreements);
  renderComments(allComments);
  renderCorrective(allCorrective);
}

function renderMeta(meta) {
  if (!meta) return;
  setText('hTeamName', getSelectedTeam());
  setText('companyMission', meta.companyMission || '');
  setText('teamMission', meta.teamMission || '');
  setText('teamGoal', meta.teamGoal || '');
  renderValuesList('companyValues', meta.companyValues);
  renderValuesList('teamValues', meta.teamValues);
  // Спочатку наповнюємо дропдаун реальними періодами з даних
  populateMonthDropdown(fullData);
  // Потім встановлюємо значення (останній місяць де є дані)
  const sel = document.getElementById('monthSelect');
  if (sel && !sel.value) {
    const lastMonth = findLastMonthWithData(fullData);
    if (lastMonth) {
      sel.value = lastMonth;
    } else if (meta.month) {
      // Fallback: якщо даних немає — використовуємо значення з team_config
      const name = Object.keys(MONTH_MAP).find(m =>
        meta.month.toUpperCase().includes(m.toUpperCase())
      );
      if (name) sel.value = name;
    }
  }
}

// Витягує {month, year} з рядка дати (підтримує "dd.mm.yyyy" і "yyyy-mm-dd")
function extractPeriod(str) {
  if (!str) return null;
  const s = String(str);
  const p1 = s.split('.');
  if (p1.length >= 2 && /^\d{1,2}$/.test(p1[1])) {
    const m = parseInt(p1[1], 10);
    if (m < 1 || m > 12) return null;
    const y = (p1[2] && /^\d{4}$/.test(p1[2])) ? parseInt(p1[2], 10) : null;
    return { month: m, year: y };
  }
  const p2 = s.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (p2) return { month: parseInt(p2[2], 10), year: parseInt(p2[1], 10) };
  return null;
}

// Збирає всі унікальні періоди {month, year} з даних
function collectAllPeriods(data) {
  if (!data) return [];
  const periods = new Map(); // key="YYYY-MM" -> {month, year}
  const collect = (str) => {
    const p = extractPeriod(str);
    if (!p) return;
    const key = (p.year || 0) + '-' + String(p.month).padStart(2,'0');
    periods.set(key, p);
  };
  (data.daily       || []).forEach(r => collect(r.date));
  (data.problems    || []).forEach(r => collect(r.date));
  (data.corrective  || []).forEach(r => collect(r.date));
  (data.escalations || []).forEach(r => collect(r.date));
  (data.comments    || []).forEach(r => collect(r.date));
  (data.charts      || []).forEach(arr => (arr || []).forEach(r => collect(r.label)));
  // Сортуємо по спаданню (новіші зверху)
  return Array.from(periods.values()).sort((a,b) => {
    const ay = a.year || 0, by = b.year || 0;
    if (ay !== by) return by - ay;
    return b.month - a.month;
  });
}

// Знаходить найновіший період у даних і повертає його як "Червень 2026"
function findLastMonthWithData(data) {
  const periods = collectAllPeriods(data);
  if (!periods.length) return null;
  const p = periods[0];
  const name = Object.keys(MONTH_MAP).find(n => MONTH_MAP[n] === p.month);
  if (!name) return null;
  return p.year ? `${name} ${p.year}` : name;
}

// Наповнює дропдаун `monthSelect` реальними періодами з даних
function populateMonthDropdown(data) {
  const sel = document.getElementById('monthSelect');
  if (!sel) return;
  const periods = collectAllPeriods(data);
  const currentValue = sel.value;
  // Лишаємо першу опцію "Всі періоди"
  sel.innerHTML = '<option value="">Всі періоди</option>';
  periods.forEach(p => {
    const name = Object.keys(MONTH_MAP).find(n => MONTH_MAP[n] === p.month);
    if (!name) return;
    const label = p.year ? `${name} ${p.year}` : name;
    const opt = document.createElement('option');
    opt.value = label;
    opt.textContent = label;
    sel.appendChild(opt);
  });
  // Відновлюємо вибране значення якщо воно ще існує в списку
  if (currentValue && Array.from(sel.options).some(o => o.value === currentValue)) {
    sel.value = currentValue;
  }
}
function renderValuesList(id, valStr) {
  const el = document.getElementById(id);
  if (!el || !valStr) return;
  el.innerHTML = String(valStr).split(',').map(v=>v.trim()).filter(Boolean).map(v=>`<li>${v}</li>`).join('');
}

// ════════════════════════════════════════════════
// KPI
// ════════════════════════════════════════════════
function renderKPI(daily, problems, partners, comments, charts) {
  // БАГ 4: ЄДИНА ЛОГІКА ЕФЕКТИВНОСТІ — у % від плану для всіх команд
  // Це дозволяє порівнювати команди на одній шкалі 0–100%+
  const chart1Data = (charts || cachedFullData?.charts || fullData?.charts || [])[0] || [];
  if (chart1Data.length) {
    const vals = chart1Data.map(r => r.value).filter(v => v !== null && v !== undefined);
    if (vals.length) {
      const avg1  = Math.round(vals.reduce((a,b)=>a+b,0) / vals.length * 10) / 10;
      const cfg   = chartConfigs[0];
      const unit  = cfg?.unit || '';
      const plan  = cfg?.planValue;
      const planMin = cfg?.planMin != null && cfg?.planMin !== '' ? +cfg.planMin : null;
      const planMax = cfg?.planMax != null && cfg?.planMax !== '' ? +cfg.planMax : null;
      const hasCorridor = planMin != null || planMax != null;
      const label = cfg?.title || 'Графік 1';
      const dir   = cfg?.planDir || 'above';

      setText('kpiEffLabel', 'Ефективність команди');

      if (hasCorridor) {
        // Логіка коридору: якщо середнє в коридорі → 100%, поза → % відхилення від найближчої межі
        const okMin = planMin == null || avg1 >= planMin;
        const okMax = planMax == null || avg1 <= planMax;
        let eff;
        if (okMin && okMax) {
          eff = 100;
        } else {
          let deviationPct = 0;
          if (planMin != null && avg1 < planMin && planMin !== 0) {
            deviationPct = Math.abs((planMin - avg1) / planMin) * 100;
          } else if (planMax != null && avg1 > planMax && planMax !== 0) {
            deviationPct = Math.abs((avg1 - planMax) / planMax) * 100;
          }
          eff = Math.max(0, Math.round(100 - deviationPct));
        }
        setText('kpiEff', eff + '%');
        const factStr = avg1 + (unit ? ' ' + unit : '');
        const rangeStr = (planMin != null ? planMin : '−∞') + '..' + (planMax != null ? planMax : '+∞') + (unit ? ' ' + unit : '');
        setDelta('kpiEffDelta', `${factStr} у коридорі ${rangeStr}`, eff >= 100 ? 'up' : 'dn');
        const card = document.getElementById('kpiEff')?.closest('.kpi-card');
        if (card) {
          if (eff >= 100) card.style.setProperty('--accent', 'var(--c-green)');
          else if (eff >= 80) card.style.setProperty('--accent', 'var(--c-yellow)');
          else card.style.setProperty('--accent', 'var(--c-red)');
        }
      } else if (plan && plan > 0) {
        // Рахуємо ефективність у %
        let eff;
        if (dir === 'above') {
          // Треба бути вище плану: 100% = факт досяг плану, більше = краще
          eff = (avg1 / plan) * 100;
        } else {
          // Треба бути нижче плану (наприклад, час реагування, кількість помилок)
          // 100% = факт досяг плану (= план); якщо менше — краще
          eff = avg1 > 0 ? (plan / avg1) * 100 : 100;
        }
        eff = Math.round(eff);

        setText('kpiEff', eff + '%');
        // Підпис: показуємо факт vs план
        const factStr = avg1 + (unit ? ' ' + unit : '');
        const planStr = plan + (unit ? ' ' + unit : '');
        const arrow = dir === 'above' ? '≥' : '≤';
        setDelta('kpiEffDelta', `${factStr} ${arrow} ${planStr}`, eff >= 100 ? 'up' : 'dn');

        // Колір картки: зелений ≥100%, жовтий 80-99%, червоний <80%
        const card = document.getElementById('kpiEff')?.closest('.kpi-card');
        if (card) {
          if (eff >= 100) card.style.setProperty('--accent', 'var(--c-green)');
          else if (eff >= 80) card.style.setProperty('--accent', 'var(--c-yellow)');
          else card.style.setProperty('--accent', 'var(--c-red)');
        }
      } else {
        // Без плану — старий показ (середнє значення у власних одиницях)
        setText('kpiEff', avg1 + (unit ? ' ' + unit : ''));
        setDelta('kpiEffDelta', `немає плану (${vals.length} зап.)`, '');
        const card = document.getElementById('kpiEff')?.closest('.kpi-card');
        if (card) card.style.setProperty('--accent', 'var(--c-muted)');
      }
    } else {
      setText('kpiEffLabel', 'Ефективність команди');
      setText('kpiEff', '—');
      setDelta('kpiEffDelta', 'немає даних', '');
    }
  } else {
    setText('kpiEffLabel', 'Ефективність команди');
    setText('kpiEff', '—');
    setDelta('kpiEffDelta', 'немає даних', '');
  }

  // Блок 2 — кількість учасників команди
  const membersCnt = teamMembers?.length ?? 0;
  setText('kpiMV', membersCnt || '—');
  setDelta('kpiMVDelta', membersCnt ? `осіб у команді` : 'ще не додано', membersCnt ? 'up' : '');

  if (problems) {
    const open = problems.filter(p=>p.status!=='done').length;
    const over = problems.filter(p=>p.status==='over').length;
    setText('kpiProblems', open);
    setDelta('kpiProblemsDelta', `${over} прострочено`, over>0?'dn':'up');
  }
  if (partners) {
    const pending = partners.filter(p=>p.days&&p.days.includes(0)).length;
    setText('kpiPartners', partners.length);
    setDelta('kpiPartnersDelta', pending>0?`${pending} не підписано`:'всі підписано', pending>0?'warn':'up');
  }
  if (comments) {
    const done = comments.filter(c=>c.status==='done').length;
    setText('kpiComments', comments.length);
    setDelta('kpiCommentsDelta', `${done} вирішено`, done===comments.length?'up':'warn');
  }
}

// ════════════════════════════════════════════════
// БАЗОВІ УТИЛІТИ ГРАФІКІВ
// ════════════════════════════════════════════════
const CO = { gc:'rgba(226,230,240,.8)', tc:'#6b7491', tf:{size:10,family:'IBM Plex Mono'} };
function cScales(yMin, yMax, yCb) {
  return {
    x:{type:'category',ticks:{color:CO.tc,font:CO.tf,maxRotation:45,autoSkip:true,maxTicksLimit:15},grid:{color:CO.gc}},
    y:{min:yMin,max:yMax,ticks:{color:CO.tc,font:CO.tf,callback:yCb||(v=>v)},grid:{color:CO.gc}}
  };
}
function mkChart(id, cfg) {
  if (charts[id]) charts[id].destroy();
  const el = document.getElementById(id);
  if (!el) return;
  charts[id] = new Chart(el, cfg);
}

// ════════════════════════════════════════════════
// 5 НАЛАШТОВУВАНИХ ГРАФІКІВ (кожен — свій аркуш)
// ════════════════════════════════════════════════

const DEFAULT_CHARTS = [
  { title:'Графік 1', tooltip:'Значення', type:'bar', color:'#d4a017', lineColor:'#1a9e5c', unit:'', min:0, max:null, showPlan:true },
  { title:'Графік 2', tooltip:'Значення', type:'bar', color:'#1a6fb5', lineColor:'#1a9e5c', unit:'', min:0, max:null, showPlan:true },
  { title:'Графік 3', tooltip:'Значення', type:'bar', color:'#1a9e5c', lineColor:'#c0392b', unit:'', min:0, max:null, showPlan:true },
  { title:'Графік 4', tooltip:'Значення', type:'bar', color:'#c0392b', lineColor:'#1a9e5c', unit:'', min:0, max:null, showPlan:true },
  { title:'Графік 5', tooltip:'Значення', type:'line', color:'#1a6fb5', lineColor:'#1a9e5c', unit:'', min:0, max:null, showPlan:true },
];

let chartConfigs = [];
let currentChartTab = 0;

function getChartStorageKey() {
  return 'chartsConfig_' + getSelectedTeam(); // fallback key (не використовується)
}

async function loadChartConfigs() {
  // Конфіг вже прийшов в data.chartsConfig при завантаженні
  // Ця функція використовується тільки при зміні команди
  try {
    const rows3 = await supaGet('charts_config', `team=eq.${encodeURIComponent(getSelectedTeam())}&select=config`);
    const data = { config: rows3?.[0]?.config || null };
    if (data.config && Array.isArray(data.config) && data.config.length > 0) {
      chartConfigs = data.config;
    } else {
      chartConfigs = JSON.parse(JSON.stringify(DEFAULT_CHARTS));
    }
  } catch(e) {
    chartConfigs = JSON.parse(JSON.stringify(DEFAULT_CHARTS));
  }
}

async function saveChartConfigsToStorage() {
  try {
    const team2 = getSelectedTeam();
    await supaUpsert('charts_config', { team: team2, config: chartConfigs, updated_at: new Date().toISOString() }, 'team');
    sessionStorage.removeItem('dash_' + team2);
  } catch(e) {
    console.warn('Не вдалось зберегти конфіг графіків:', e.message);
  }
}

// Рендер одного графіка з даних charts[idx]
// Конвертує будь-який формат дати → дд.мм.рррр, або залишає рядок як є
function fmtLabel(raw) {
  if (raw == null) return '';
  // Якщо вже рядок без дати — повертаємо як є (наприклад "Тиждень 4")
  if (typeof raw === 'string') {
    // Спробуємо розпізнати дату
    const d = new Date(raw);
    if (!isNaN(d.getTime()) && raw.length > 6) {
      // Виглядає як дата — форматуємо
      const dd = String(d.getDate()).padStart(2,'0');
      const mm = String(d.getMonth()+1).padStart(2,'0');
      const yyyy = d.getFullYear();
      return `${dd}.${mm}.${yyyy}`;
    }
    return raw; // звичайний рядок
  }
  // Date об'єкт
  if (raw instanceof Date && !isNaN(raw.getTime())) {
    const dd = String(raw.getDate()).padStart(2,'0');
    const mm = String(raw.getMonth()+1).padStart(2,'0');
    const yyyy = raw.getFullYear();
    return `${dd}.${mm}.${yyyy}`;
  }
  return String(raw);
}

function renderUserChart(idx, fullData) {
  const cfg = chartConfigs[idx];
  if (!cfg) return;

  setText('chartTitle' + idx, cfg.title || ('Графік ' + (idx+1)));

  let chartData = [...((fullData?.charts || [])[idx] || [])];

  // Сортування по даті або номеру (старі зліва, нові зправа)
  chartData.sort((a, b) => {
    const parseD = s => {
      const str = String(s).trim();
      // "Тиждень 4", "Week 4", "Тиж 4" — сортуємо по номеру
      const wkMatch = str.match(/(\d+)/);
      // дд.мм.рррр
      const p = str.split('.');
      if (p.length === 3 && p[2].length === 4) return new Date(+p[2], +p[1]-1, +p[0]).getTime();
      // yyyy-mm-dd
      if (/^\d{4}-\d{2}-\d{2}/.test(str)) return new Date(str).getTime();
      // "Тиждень N" або просто число
      if (wkMatch) return +wkMatch[1];
      return 0;
    };
    return parseD(a.label) - parseD(b.label);
  });

  // Форматуємо мітки для осі X: рядок залишаємо як є
  const labels = chartData.map(r => String(r.label ?? ''));
  const values = chartData.map(r => r.value);

  // Пороги коридору мають пріоритет; planValue — застарілий одиничний варіант (для сумісності)
  const planMin = cfg.planMin != null && cfg.planMin !== '' ? +cfg.planMin : null;
  const planMax = cfg.planMax != null && cfg.planMax !== '' ? +cfg.planMax : null;
  const plan    = cfg.planValue != null ? +cfg.planValue : null;
  const dir     = cfg.planDir || 'above';
  const hasCorridor = planMin != null || planMax != null;
  const unitSuffix = cfg.unit ? ' ' + cfg.unit : '';

  // Кольори стовпців залежно від плану
  function getColor(val) {
    if (val == null) return '#e2e6f0';
    // Пріоритет: коридор
    if (hasCorridor) {
      const okMin = planMin == null || val >= planMin;
      const okMax = planMax == null || val <= planMax;
      if (okMin && okMax) return 'rgba(26,158,92,0.82)'; // зелений — у коридорі
      // Обчислюємо відхилення від найближчої межі у % від межі
      let deviationPct = 0;
      if (planMin != null && val < planMin && planMin !== 0) {
        deviationPct = Math.abs((planMin - val) / planMin) * 100;
      } else if (planMax != null && val > planMax && planMax !== 0) {
        deviationPct = Math.abs((val - planMax) / planMax) * 100;
      } else {
        deviationPct = 100;
      }
      if (deviationPct <= 20) return 'rgba(212,160,23,0.82)'; // жовтий
      return 'rgba(192,57,43,0.82)'; // червоний
    }
    // Одиничне значення (стара логіка)
    if (plan == null) return '#d4a017bb';
    if (dir === 'above') {
      if (val >= plan)       return 'rgba(26,158,92,0.82)';
      if (val >= plan * 0.9) return 'rgba(212,160,23,0.82)';
      return 'rgba(192,57,43,0.82)';
    } else {
      if (val <= plan)       return 'rgba(26,158,92,0.82)';
      if (val <= plan * 1.1) return 'rgba(212,160,23,0.82)';
      return 'rgba(192,57,43,0.82)';
    }
  }

  const barColors = values.map(v => v != null ? getColor(v) : '#e2e6f0');

  const datasets = [];
  if (cfg.type === 'line') {
    datasets.push({
      label: cfg.tooltip || cfg.title,
      data: values,
      borderColor: '#1a6fb5',
      backgroundColor: 'rgba(26,111,181,0.12)',
      borderWidth: 2, pointRadius: 3, fill: true, tension: 0.3,
      pointBackgroundColor: values.map(v => v != null ? getColor(v) : '#e2e6f0'),
    });
  } else {
    datasets.push({
      label: cfg.tooltip || cfg.title,
      data: values,
      backgroundColor: barColors,
      borderRadius: 3,
    });
  }

  // План на графіку
  if (cfg.showPlan !== false) {
    if (hasCorridor) {
      // Коридор — верхня і нижня межа + напівпрозора зафарбована зона між ними
      // Зона малюється як fill між двома лініями
      if (planMax != null) {
        datasets.push({
          label: 'Верхній поріг',
          data: Array(labels.length).fill(planMax),
          type: 'line',
          borderColor: 'rgba(26,158,92,0.9)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: planMin != null ? '+1' : false, // зафарбовуємо до наступного датасету (нижнього порога)
          backgroundColor: 'rgba(26,158,92,0.08)',
          order: 99,
        });
      }
      if (planMin != null) {
        datasets.push({
          label: 'Нижній поріг',
          data: Array(labels.length).fill(planMin),
          type: 'line',
          borderColor: 'rgba(26,158,92,0.9)',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          order: 100,
        });
      }
    } else if (plan != null) {
      // Стара логіка: одна лінія плану
      datasets.push({
        label: 'План',
        data: Array(labels.length).fill(plan),
        type: 'line',
        borderColor: 'rgba(26,158,92,0.9)',
        borderWidth: 2,
        borderDash: [6, 4],
        pointRadius: 0,
        fill: false,
      });
    }
  }

  const yMax = cfg.max != null && cfg.max !== '' ? +cfg.max : undefined;
  const yMin = cfg.min != null ? +cfg.min : 0;

  mkChart('userChart' + idx, {
    type: cfg.type === 'line' ? 'line' : 'bar',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => {
              if (ctx.dataset.label === 'План')            return `План: ${ctx.raw}${unitSuffix}`;
              if (ctx.dataset.label === 'Верхній поріг')   return `Верх. поріг: ${ctx.raw}${unitSuffix}`;
              if (ctx.dataset.label === 'Нижній поріг')    return `Ниж. поріг: ${ctx.raw}${unitSuffix}`;
              return `${ctx.dataset.label}: ${ctx.raw}${unitSuffix}`;
            }
          }
        }
      },
      scales: cScales(yMin, yMax, v => v + unitSuffix)
    }
  });
}

function renderAllUserCharts(fullData) {
  for (let i = 0; i < 5; i++) renderUserChart(i, fullData);
}

// ── НАЛАШТУВАННЯ ГРАФІКІВ ────────────────────
function openChartSettings() {
  renderChartSettingsPanel(currentChartTab);
  document.getElementById('chartSettingsBackdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeChartSettings() {
  document.getElementById('chartSettingsBackdrop').classList.remove('open');
  document.body.style.overflow = '';
}
function closeChartSettingsOutside(e) {
  if (e.target === document.getElementById('chartSettingsBackdrop')) closeChartSettings();
}
function switchChartTab(idx, btn) {
  currentChartTab = idx;
  document.querySelectorAll('#chartTabRow .mtab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderChartSettingsPanel(idx);
}

function renderChartSettingsPanel(idx) {
  const cfg = chartConfigs[idx] || DEFAULT_CHARTS[idx];
  document.getElementById('chartSettingsBody').innerHTML = `
    <div class="form-section">
      <div class="form-section-label">Загальне</div>
      <div class="form-grid">
        <div class="form-field full"><label class="field-label">Назва графіка</label>
          <input class="field-input" id="cs_title" value="${cfg.title||''}"></div>
        <div class="form-field full"><label class="field-label">Підпис у tooltip</label>
          <input class="field-input" id="cs_tooltip" value="${cfg.tooltip||''}"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-label">Тип та кольори</div>
      <div class="form-grid">
        <div class="form-field"><label class="field-label">Тип графіка</label>
          <select class="field-input" id="cs_type">
            <option value="bar" ${cfg.type==='bar'?'selected':''}>Стовпчастий</option>
            <option value="line" ${cfg.type==='line'?'selected':''}>Лінійний</option>
          </select></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-label">Шкала (вісь Y)</div>
      <div class="form-grid-3">
        <div class="form-field"><label class="field-label">Одиниця виміру</label>
          <input class="field-input" id="cs_unit" value="${cfg.unit||''}" placeholder="%, шт."></div>
        <div class="form-field"><label class="field-label">Мін.</label>
          <input class="field-input" type="number" id="cs_min" value="${cfg.min??0}"></div>
        <div class="form-field"><label class="field-label">Макс. (порожньо = авто)</label>
          <input class="field-input" type="number" id="cs_max" value="${cfg.max??''}"></div>
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-label">План (можна задати як одне значення, коридор, тільки верхню або тільки нижню межу)</div>
      <div class="form-grid">
        <div class="form-field"><label class="field-label">Нижній поріг (порожньо = немає)</label>
          <input class="field-input" type="number" id="cs_planMin" value="${cfg.planMin??''}" placeholder="напр. 80"></div>
        <div class="form-field"><label class="field-label">Верхній поріг (порожньо = немає)</label>
          <input class="field-input" type="number" id="cs_planMax" value="${cfg.planMax??''}" placeholder="напр. 100"></div>
        <div class="form-field"><label class="field-label">Одне значення плану (застаріле, для сумісності)</label>
          <input class="field-input" type="number" id="cs_planValue" value="${cfg.planValue??''}" placeholder="напр. 85"></div>
        <div class="form-field"><label class="field-label">Умова виконання (для одиничного значення)</label>
          <select class="field-input" id="cs_planDir">
            <option value="above" ${(cfg.planDir||'above')==='above'?'selected':''}>Добре — вище плану</option>
            <option value="below" ${cfg.planDir==='below'?'selected':''}>Добре — нижче плану</option>
          </select></div>
        <div class="form-field"><label class="field-label" style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="cs_showPlan" ${cfg.showPlan!==false?'checked':''} style="width:16px;height:16px">
          Показувати план на графіку
        </label></div>
      </div>
      <div style="font-size:11px;color:var(--c-muted);margin-top:8px;line-height:1.5">
        💡 <b>Як це працює:</b> якщо задати обидва пороги — з'явиться коридор із зафарбованою зоною і двома пунктирними лініями. Тільки нижній — значення мають бути «не нижче». Тільки верхній — «не вище». Якщо задано лише «Одне значення» — стара логіка з однією лінією.
      </div>
    </div>
    <div class="form-section">
      <div class="form-section-label">Тригер — автоматична проблема</div>
      <div style="font-size:11px;color:var(--c-muted);font-family:var(--mono);margin-bottom:8px">
        Якщо за місяць значення потрапляє в зону певну кількість разів — автоматично створюється проблема в трекері
      </div>
      <div class="form-grid">
        <div class="form-field">
          <label class="field-label">🔴 Червона зона — більше ніж (разів/міс)</label>
          <input class="field-input" type="number" id="cs_triggerRed" min="0"
            value="${cfg.triggerRed??''}" placeholder="напр. 3 (0 = вимкнено)">
        </div>
        <div class="form-field">
          <label class="field-label">🟡 Жовта зона — більше ніж (разів/міс)</label>
          <input class="field-input" type="number" id="cs_triggerYellow" min="0"
            value="${cfg.triggerYellow??''}" placeholder="напр. 5 (0 = вимкнено)">
        </div>
        <div class="form-field">
          <label class="field-label">Відповідальний</label>
          <input class="field-input" type="text" id="cs_triggerResp"
            value="${cfg.triggerResp||''}" placeholder="Прізвище">
        </div>
        <div class="form-field full">
          <label class="field-label">Шаблон опису проблеми</label>
          <input class="field-input" id="cs_triggerDesc"
            value="${cfg.triggerDesc||''}" placeholder="напр. Показник виходить за межі норми">
        </div>
      </div>
    </div>
    <div style="background:var(--c-card);border:1px solid var(--c-border);border-radius:6px;padding:10px 12px;font-size:11px;color:var(--c-muted);font-family:var(--mono)">
      Аркуш: <b>«Графік${idx+1}»</b> · Колонки: Мітка | Значення<br>
      🟢 Зелений: виконано · 🟡 Жовтий: ±10% від плану · 🔴 Червоний: не виконано<br>
      ⚡ Тригер: щодня рахує випадки за поточний місяць. Запусти <b>setupDailyTrigger()</b> в Apps Script
    </div>`;
}

async function saveChartSettings() {
  const idx = currentChartTab;
  const maxVal = document.getElementById('cs_max').value;
  chartConfigs[idx] = {
    title:      document.getElementById('cs_title').value.trim(),
    tooltip:    document.getElementById('cs_tooltip').value.trim(),
    type:       document.getElementById('cs_type').value,
    color:      chartConfigs[idx]?.color || '#d4a017',
    lineColor:  '#1a9e5c',
    unit:       document.getElementById('cs_unit').value.trim(),
    min:        +document.getElementById('cs_min').value || 0,
    max:        maxVal !== '' ? +maxVal : null,
    showPlan:   document.getElementById('cs_showPlan').checked,
    planMin:    document.getElementById('cs_planMin').value !== '' ? +document.getElementById('cs_planMin').value : null,
    planMax:    document.getElementById('cs_planMax').value !== '' ? +document.getElementById('cs_planMax').value : null,
    planValue:  document.getElementById('cs_planValue').value !== '' ? +document.getElementById('cs_planValue').value : null,
    planDir:    document.getElementById('cs_planDir').value,
    triggerRed:    document.getElementById('cs_triggerRed')?.value !== '' ? +document.getElementById('cs_triggerRed').value : null,
    triggerYellow: document.getElementById('cs_triggerYellow')?.value !== '' ? +document.getElementById('cs_triggerYellow').value : null,
    triggerResp:   document.getElementById('cs_triggerResp')?.value.trim() || '',
    triggerDesc:   document.getElementById('cs_triggerDesc')?.value.trim() || '',
  };
  saveChartConfigsToStorage();
  const newTitle = chartConfigs[idx].title || ('Графік ' + (idx+1));
  document.querySelectorAll('#chartTabRow .mtab')[idx].textContent = newTitle;
  setText('chartTitle' + idx, newTitle);
  const dataToUse = cachedFullData || fullData;
  if (dataToUse) renderUserChart(idx, dataToUse);
  saveAllTriggers();
  const msg = document.getElementById('chartSettingsMsg');
  msg.textContent = '✓ Збережено!';
  msg.className = 'form-msg success';
  setTimeout(() => { msg.textContent = ''; }, 2000);
}

// ── ЗБЕРЕЖЕННЯ ТРИГЕРІВ В SHEETS ─────────────
async function saveAllTriggers() {
  try {
    const triggers = chartConfigs
      .map((cfg, i) => (cfg.triggerRed || cfg.triggerYellow) ? {
        chartIdx:      i,
        triggerRed:    cfg.triggerRed    || 0,
        triggerYellow: cfg.triggerYellow || 0,
        planValue:     cfg.planValue     || 0,
        planMin:       cfg.planMin       ?? null,
        planMax:       cfg.planMax       ?? null,
        planDir:       cfg.planDir       || 'above',
        desc:          cfg.triggerDesc   || `Відхилення показника "${cfg.title||'Графік '+(i+1)}"`,
        resp:          cfg.triggerResp   || '',
      } : null)
      .filter(Boolean);

    const url = `${API_URL}?action=saveTriggers&team=${encodeURIComponent(getSelectedTeam())}&data=${encodeURIComponent(JSON.stringify(triggers))}`;
    await fetch(url);
  } catch(e) {
    console.warn('Тригери не збережені:', e.message);
  }
}

async function resetChartSettings() {
  if (!confirm('Скинути всі графіки до стандартних?')) return;
  chartConfigs = JSON.parse(JSON.stringify(DEFAULT_CHARTS));
  saveChartConfigsToStorage();
  document.querySelectorAll('#chartTabRow .mtab').forEach((btn,i) => {
    btn.textContent = chartConfigs[i].title || ('Графік '+(i+1));
  });
  renderChartSettingsPanel(currentChartTab);
  const dataToUse = cachedFullData || fullData;
  if (dataToUse) renderAllUserCharts(dataToUse);
  const msg = document.getElementById('chartSettingsMsg');
  msg.textContent = '✓ Скинуто';
  msg.className = 'form-msg success';
  setTimeout(() => { msg.textContent = ''; }, 2000);
}

// ── ДОДАВАННЯ ДАНИХ З ГРАФІКА ────────────────
// ════════════════════════════════════════════════
// РЕДАКТОР ДАНИХ ГРАФІКА
// ════════════════════════════════════════════════
let chartEditIdx  = 0;
let chartEditData = [];

function openChartDataEdit(idx) {
  chartEditIdx = idx;
  const cfg = chartConfigs[idx];
  document.getElementById('chartEditTitle').textContent = `✎ ${cfg?.title||'Графік '+(idx+1)} — редагування даних`;
  document.getElementById('chartEditMsg').textContent = '';
  const raw = (fullData?.charts||[])[idx]||[];
  chartEditData = raw.map(r=>({label:r.label||'',value:r.value??'',plan:r.plan??''}));
  renderChartEditTable();
  document.getElementById('chartEditModal').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeChartEdit() {
  document.getElementById('chartEditModal').classList.remove('open');
  document.body.style.overflow='';
}

function renderChartEditTable() {
  const tbody = document.getElementById('chartEditBody');
  if (!chartEditData.length) {
    tbody.innerHTML=`<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--c-muted);font-size:12px">Немає даних</td></tr>`;
    return;
  }
  tbody.innerHTML = chartEditData.map((r,i)=>`<tr style="border-bottom:1px solid var(--c-border);${i%2===0?'background:#fafbfc':''}">
    <td style="padding:5px 8px">
      <input value="${escHtml(String(r.label))}" onchange="chartEditData[${i}].label=this.value"
        style="font-family:var(--mono);font-size:11px;padding:3px 6px;border:1px solid var(--c-border);border-radius:3px;width:110px;outline:none">
    </td>
    <td style="padding:5px 8px;text-align:center">
      <input type="number" value="${r.value??''}" onchange="chartEditData[${i}].value=this.value!==''?+this.value:null"
        style="font-family:var(--mono);font-size:12px;padding:3px 6px;border:1px solid var(--c-border);border-radius:3px;width:80px;text-align:center;outline:none">
    </td>
    <td style="padding:5px 8px;text-align:center">
      <input type="number" value="${r.plan??''}" placeholder="—" onchange="chartEditData[${i}].plan=this.value!==''?+this.value:''"
        style="font-family:var(--mono);font-size:12px;padding:3px 6px;border:1px solid var(--c-border);border-radius:3px;width:80px;text-align:center;outline:none;color:var(--c-muted)">
    </td>
    <td style="text-align:center;width:36px">
      <button onclick="deleteChartRow(${i})" style="font-size:16px;color:var(--c-red);background:transparent;border:none;cursor:pointer;padding:2px 6px">×</button>
    </td>
  </tr>`).join('');
}

function deleteChartRow(i) {
  chartEditData.splice(i,1);
  renderChartEditTable();
}

async function saveChartEdit() {
  const msg = document.getElementById('chartEditMsg');
  msg.textContent='Збереження...'; msg.style.color='var(--c-muted)';
  try {
    const team = getSelectedTeam();

    // Очищаємо старі дані (може бути 0 рядків — це нормально)
    try {
      await supaDelete('chart_data', `team=eq.${encodeURIComponent(team)}&chart_idx=eq.${chartEditIdx}`);
    } catch(e) {
      // Якщо 0 рядків видалено — не помилка для графіків
      if (!e.message.includes('не знайдено')) throw e;
    }

    const rows2 = chartEditData.filter(r=>r.label||(r.value!==null&&r.value!=='')).map(r=>({team,chart_idx:chartEditIdx,label:r.label,value:r.value,plan:r.plan||null}));
    if(rows2.length) await supaPost('chart_data', rows2);

    // Оновлюємо локальні дані
    const newData = chartEditData.filter(r=>r.label||(r.value!==null&&r.value!==''));
    if (fullData?.charts) fullData.charts[chartEditIdx] = newData;
    if (cachedFullData?.charts) cachedFullData.charts[chartEditIdx] = newData;
    sessionStorage.removeItem('dash_' + team);
    renderUserChart(chartEditIdx, cachedFullData||fullData);

    msg.textContent='✓ Збережено!'; msg.style.color='var(--c-green)';
    showToast('Дані оновлено','success');
    setTimeout(()=>closeChartEdit(),800);
  } catch(e) {
    msg.textContent='✕ '+e.message; msg.style.color='var(--c-red)';
  }
}

function openChartDataAdd(chartIdx) {
  const cfg = chartConfigs[chartIdx];
  currentQuickSection = '__chart__' + chartIdx;
  setText('quickAddTitle', '+ Дані: ' + (cfg?.title || ('Графік '+(chartIdx+1))));
  document.getElementById('quickAddBody').innerHTML = `
    <div class="form-section">
      <div class="form-section-label">Аркуш: Графік${chartIdx+1}</div>
      <div class="form-grid">
        <div class="form-field full"><label class="field-label">Мітка (дата або назва)</label>
          <input class="field-input" type="text" id="cd_label" value="${today()}" placeholder="напр. 14.05.2026 або Тиждень 1"></div>
        <div class="form-field full"><label class="field-label">Значення</label>
          <input class="field-input" type="number" id="cd_value" placeholder="87"></div>
      </div>
    </div>`;
  document.getElementById('quickAddMsg').textContent = '';
  window.__chartIdx = chartIdx;
  document.getElementById('quickAddBackdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('cd_value')?.focus(), 100);
}

// Перевизначаємо submitQuickAdd для графіків
const _origSubmitQuickAdd = window.submitQuickAdd;
window.submitQuickAdd = async function() {
  if (!currentQuickSection?.startsWith('__chart__')) {
    return _origSubmitQuickAdd?.();
  }
  const idx = window.__chartIdx;
  const btn = document.getElementById('quickAddBtn');
  const msg = document.getElementById('quickAddMsg');
  const label = document.getElementById('cd_label')?.value.trim();
  const value = document.getElementById('cd_value')?.value;

  if (!label) { msg.textContent = '✕ Введіть мітку'; msg.className='form-msg error'; return; }
  if (value === '') { msg.textContent = '✕ Введіть значення'; msg.className='form-msg error'; return; }

  btn.disabled = true;
  msg.textContent = 'Збереження...';
  msg.className = 'form-msg';

  try {
    const team = getSelectedTeam();
    await supaPost('chart_data', { team, chart_idx: idx, label, value: +value, plan: null });
    sessionStorage.removeItem('dash_' + team);
    msg.textContent = '✓ Збережено!';
    msg.className = 'form-msg success';
    showToast('Дані збережено', 'success');
    setTimeout(() => { closeQuickAdd(); loadData(true); }, 900);
  } catch(e) {
    msg.textContent = '✕ ' + e.message;
    msg.className = 'form-msg error';
  } finally {
    btn.disabled = false;
  }
};


// ════════════════════════════════════════════════
// ТАБЛИЦІ З INLINE ЗМІНОЮ СТАТУСУ
// ════════════════════════════════════════════════
function statusSelect(rowIndex, section, currentStatus) {
  return `<select class="status-select" onchange="changeStatus(${rowIndex},'${section}',this)" title="Змінити статус">
    ${['done','wip','over','wait'].map(s=>`<option value="${s}"${s===currentStatus?' selected':''}>${STATUS_LABELS[s]}</option>`).join('')}
  </select>`;
}

async function changeStatus(rowIndex, section, selectEl) {
  const newStatus = selectEl.value;
  selectEl.classList.add('saving');
  selectEl.disabled = true;
  try {
    const maps = { problems: allProblems, escalations: allEscalations, corrective: allCorrective, comments: allComments };
    const tableMap = { problems: 'problems', escalations: 'escalations', corrective: 'corrective', comments: 'comments' };
    const row = maps[section]?.[rowIndex];
    if (!row?.id) throw new Error('ID не знайдено');

    await supaPatch(tableMap[section], `id=eq.${row.id}`, { status: newStatus });
    if (maps[section]?.[rowIndex]) maps[section][rowIndex].status = newStatus;
    sessionStorage.removeItem('dash_' + getSelectedTeam());
    showToast('Статус оновлено', 'success');
  } catch(e) {
    showToast('Помилка: ' + e.message, 'error');
  } finally {
    selectEl.classList.remove('saving');
    selectEl.disabled = false;
  }
}

// ── INLINE EDIT CELL ─────────────────────────────
function editCell(rowIndex, section, field, currentVal, label) {
  // Для полів з переліком кроків — перетворюємо "1. ... 2. ..." на нові рядки
  const displayVal = formatSteps(currentVal);
  const encoded = encodeURIComponent(currentVal || '');
  return `<td class="edit-cell" id="cell_${section}_${rowIndex}_${field}" data-val="${encoded}" data-section="${section}" data-row="${rowIndex}" data-field="${field}" data-label="${escHtmlAttr(label)}">
    ${currentVal
      ? `<span class="cell-val" onclick="activateEditFromCell(this.parentNode)">${displayVal}</span>`
      : `<button class="write-btn" onclick="activateEditFromCell(this.parentNode)">✎ ${label}</button>`
    }
  </td>`;
}

// Викликається з cell — читає всі параметри з data-* атрибутів
function activateEditFromCell(cellEl) {
  if (!cellEl) return;
  const section  = cellEl.dataset.section;
  const rowIndex = parseInt(cellEl.dataset.row, 10);
  const field    = cellEl.dataset.field;
  const label    = cellEl.dataset.label;
  const val      = decodeURIComponent(cellEl.dataset.val || '');
  activateEdit(section, rowIndex, field, val, label);
}

// Розбиває суцільний текст типу "1. Один. 2. Два. 3. Три." на окремі рядки
function formatSteps(val) {
  if (!val) return '';
  let s = String(val).trim();
  // Якщо вже є переноси — не чіпаємо
  if (s.includes('\n')) return escHtml(s);
  // Шукаємо шаблон "N. " або "N) " після пробілу — це ознака списку
  // Розбиваємо на кроки, зберігаючи номери
  const pattern = /(?<=\s)(?=\d+[\.\)]\s)/g;
  const parts = s.split(pattern).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1) return parts.map(p => escHtml(p)).join('\n');
  return escHtml(s);
}

function escQ(str) {
  return String(str)
    .replace(/\\/g,'\\\\')      // спочатку — бекслеші
    .replace(/'/g,'&#39;')
    .replace(/"/g,'&quot;')
    .replace(/\r/g,'')          // прибираємо CR
    .replace(/\n/g,'\\n');      // переноси → escape-послідовність
}

function activateEdit(section, rowIndex, field, currentVal, label) {
  const cellId = `cell_${section}_${rowIndex}_${field}`;
  const cell = document.getElementById(cellId);
  if (!cell) return;
  const isMultiline = ['steps','action','desc','text','description','comment'].includes(field);
  // Зберігаємо старе значення у data-old щоб cancel міг його відновити
  cell.setAttribute('data-old', encodeURIComponent(currentVal || ''));
  cell.innerHTML = isMultiline
    ? `<textarea class="inline-input" id="inp_${cellId}" rows="3" style="width:100%;min-width:140px">${escHtml(currentVal)}</textarea>
       <div class="inline-actions">
         <button class="inline-save" onclick="saveInlineEdit('${section}',${rowIndex},'${field}','${cellId}','${escHtmlAttr(label)}')">✓</button>
         <button class="inline-cancel" onclick="cancelInlineEditFromCell(this.closest('.edit-cell'))">✕</button>
       </div>`
    : `<input class="inline-input" id="inp_${cellId}" type="text" value="${escHtmlAttr(currentVal)}" style="width:100%;min-width:120px">
       <div class="inline-actions">
         <button class="inline-save" onclick="saveInlineEdit('${section}',${rowIndex},'${field}','${cellId}','${escHtmlAttr(label)}')">✓</button>
         <button class="inline-cancel" onclick="cancelInlineEditFromCell(this.closest('.edit-cell'))">✕</button>
       </div>`;
  const inp = document.getElementById('inp_' + cellId);
  if (inp) { inp.focus(); inp.select && inp.select(); }
}

function cancelInlineEditFromCell(cellEl) {
  if (!cellEl) return;
  cancelInlineEdit(cellEl.dataset.section, +cellEl.dataset.row, cellEl.dataset.field);
}

async function saveInlineEdit(section, rowIndex, field, cellId, label) {
  const inp = document.getElementById('inp_' + cellId);
  if (!inp) return;
  const newVal = inp.value.trim();
  const cell = document.getElementById(cellId);
  if (cell) cell.innerHTML = '<span style="color:var(--c-muted);font-size:11px">Збереження...</span>';

  // Мапінг UI-полів → колонки Supabase
  // (в UI історично використовуються "steps", "resp", "action", а в БД — "action", "responsible")
  const FIELD_MAP = {
    problems:    { steps: 'action',     resp: 'responsible' },
    escalations: { action: 'action',    resp: 'responsible' },
    corrective:  { action: 'action',    resp: 'responsible' },
    comments:    { text: 'description' },
  };
  const dbField = FIELD_MAP[section]?.[field] || field;

  try {
    const maps = { problems: allProblems, escalations: allEscalations, corrective: allCorrective, comments: allComments };
    const tableMap = { problems: 'problems', escalations: 'escalations', corrective: 'corrective', comments: 'comments' };
    const row = maps[section]?.[rowIndex];
    if (!row?.id) throw new Error('ID не знайдено');

    await supaPatch(tableMap[section], `id=eq.${row.id}`, { [dbField]: newVal });
    // Оновлюємо і UI-поле, і DB-поле локально
    if (maps[section]?.[rowIndex]) {
      maps[section][rowIndex][field] = newVal;
      maps[section][rowIndex][dbField] = newVal;
    }

    sessionStorage.removeItem('dash_' + getSelectedTeam());
    showToast('Збережено', 'success');
    rerenderSection(section);
  } catch(e) {
    showToast('Помилка: ' + e.message, 'error');
    rerenderSection(section);
  }
}

function cancelInlineEdit(section, rowIndex, field) {
  rerenderSection(section);
}

function rerenderSection(section) {
  if (section === 'problems')    renderProblems(allProblems, currentProbFilter);
  if (section === 'escalations') renderEscalations(allEscalations);
  if (section === 'corrective')  renderCorrective(allCorrective);
  if (section === 'comments')    renderComments(allComments);
}

let currentProbFilter = 'all';

function renderProblems(problems, filter) {
  currentProbFilter = filter || 'all';
  const filtered = currentProbFilter==='all' ? problems : problems.filter(p=>p.status===currentProbFilter);
  document.getElementById('probBody').innerHTML = filtered.map((p,i)=>{
    // Знаходимо реальний індекс у allProblems (не у відфільтрованому!)
    const realIdx = allProblems.findIndex(x => x.id === p.id);
    return `<tr>
    <td style="font-family:var(--mono);font-size:10px;color:var(--c-muted);white-space:nowrap">${p.date}</td>
    ${editCell(realIdx,'problems','description', p.description||p.desc||'', 'Написати опис')}
    ${editCell(realIdx,'problems','steps', p.action||p.steps||'', 'Написати кроки')}
    ${editCell(realIdx,'problems','resp',  p.responsible||p.resp||'',  'Відп.')}
    ${editCell(realIdx,'problems','comment', p.comment||'', 'Додати результат')}
    <td>${statusSelect(realIdx,'problems',p.status)}</td>
    <td style="text-align:center;white-space:nowrap">
      <button class="mkcd-btn" onclick="createCDFromProblem(${p.id})" title="Створити коригуючу дію з цієї проблеми">➡️ КД</button>
      <button class="row-del-btn" onclick="deleteProblem(${p.id})" title="Видалити проблему">🗑</button>
    </td>
  </tr>`;
  }).join('') || emptyRow(7,'Немає записів');
}

function filterProbs(filter, btn) {
  document.querySelectorAll('.filter-bar .chip').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  renderProblems(allProblems, filter);
}

// Видаляє проблему з БД
async function deleteProblem(problemId) {
  const problem = allProblems.find(p => p.id === problemId);
  if (!problem) return;
  const desc = problem.description || problem.desc || '(без опису)';
  if (!confirm(`Видалити проблему?\n\n"${desc}"\n\nДію не можна скасувати.`)) return;

  try {
    await supaDelete('problems', `id=eq.${problemId}`);
    allProblems = allProblems.filter(p => p.id !== problemId);
    sessionStorage.removeItem('dash_' + getSelectedTeam());
    renderProblems(allProblems, currentProbFilter);
    showToast('Видалено', 'success');
  } catch(e) {
    showToast('Помилка: ' + e.message, 'error');
  }
}

// Створює коригуючу дію з обраної проблеми
async function createCDFromProblem(problemId) {  const problem = allProblems.find(p => p.id === problemId);
  if (!problem) {
    showToast('Проблема не знайдена', 'error');
    return;
  }
  if (!confirm(`Створити КД з цієї проблеми?\n\n"${problem.description || problem.desc || ''}"`)) return;

  const team = getSelectedTeam();
  const today = new Date();
  const dateStr = today.toISOString().slice(0,10); // YYYY-MM-DD

  try {
    const payload = {
      team: team,
      date: dateStr,
      description: problem.description || problem.desc || '',
      responsible: problem.responsible || problem.resp || '',
      status: 'wait',
      source_problem_id: problemId,
    };
    const rows = await supaPost('corrective', payload);
    // Оновлюємо локальний список КД
    if (rows && rows[0]) {
      const r = rows[0];
      allCorrective.unshift({
        date: r.date,
        description: r.description,
        responsible: r.responsible,
        deadline: r.deadline,
        status: r.status,
        id: r.id,
        source_problem_id: r.source_problem_id,
      });
      renderCorrective(allCorrective);
    }
    sessionStorage.removeItem('dash_' + team);
    showToast('✓ КД створено з проблеми №' + problemId, 'success');
  } catch(e) {
    showToast('Помилка: ' + e.message, 'error');
  }
}

function renderEscalations(escalations) {
  document.getElementById('escalBody').innerHTML = escalations.map((e,i)=>`<tr>
    <td style="font-family:var(--mono);font-size:10px;color:var(--c-muted);white-space:nowrap">${e.date}</td>
    <td style="font-size:11px;max-width:160px">${e.description||e.desc||'—'}</td>
    ${editCell(i,'escalations','action', e.responsible||e.action||'', 'Написати дію')}
    <td>${statusSelect(i,'escalations',e.status)}</td>
  </tr>`).join('') || emptyRow(4,'Немає записів');
}

// Тестові дані партнерів (поки API не має цих полів)
const DEMO_PARTNERS = [
  {team:'Фіксики',    agreement:'Проведення інструктажів з питань охорони праці та пожежної безпеки', deadline:'30.12.2025', active:true},
  {team:'Фіксики',    agreement:'Виконання вимог нормативно-правових актів з ОП та ПБ в офісі та виробництві', deadline:'30.12.2025', active:true},
  {team:'Фіксики',    agreement:'Брати участь в тестуванні доробок в BAS', deadline:'30.12.2025', active:true},
  {team:'Бухгалтерія',agreement:'Проведення інструктажів з питань охорони праці та пожежної безпеки', deadline:'30.12.2025', active:true},
  {team:'Бухгалтерія',agreement:'Виконання вимог нормативно-правових актів з ОП та ПБ в офісі та виробництві', deadline:'30.12.2025', active:true},
  {team:'Бухгалтерія',agreement:'Брати участь в тестуванні доробок в BAS', deadline:'30.12.2025', active:true},
  {team:'Запчасти_ОП',agreement:'Проведення інструктажів з питань охорони праці та пожежної безпеки', deadline:'30.12.2025', active:true},
  {team:'Запчасти_ОП',agreement:'Виконання вимог нормативно-правових актів з ОП та ПБ в офісі та виробництві', deadline:'30.12.2025', active:true},
  {team:'Запчасти_ОП',agreement:'Брати участь в тестуванні доробок в BAS', deadline:'30.12.2025', active:true},
];

function renderPartners(partners, agreements) {
  const ag = agreements || {};
  const activeCount   = ag.configured ? (ag.active   ?? 0) : 26;
  const inactiveCount = ag.configured ? (ag.inactive ?? 0) : 9;

  setText('partnerActiveCount',   activeCount);
  setText('partnerInactiveCount', inactiveCount);
  setText('kpiPartners', activeCount + inactiveCount);
  setDelta('kpiPartnersDelta', `${inactiveCount} не підписано`, inactiveCount > 0 ? 'warn' : 'up');

  const problems = ag.problem || [];
  const body = document.getElementById('partnerList');

  if (!ag.configured) { renderPartnerDemo(); return; }

  if (activeCount === 0 && inactiveCount === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:16px;font-size:12px;color:var(--c-muted)">
      Угоди ще не додані. <a href="agreements.html" style="color:var(--c-blue)">Перейти до матриці угод →</a>
    </td></tr>`;
    return;
  }

  if (problems.length === 0) {
    body.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--c-green);padding:16px;font-size:12px;font-family:var(--mono)">
      ✓ Всі угоди підписані</td></tr>`;
    return;
  }

  body.innerHTML = problems.map((r, i) => {
    const statusCls = r.status === 'wait' ? 'pill-wait' : 'pill-over';
    const statusLbl = r.status === 'wait' ? 'На підписі' : 'Не підписана';
    const team = getSelectedTeam();
    // Посилання на картку угоди в agreements.html
    const cardUrl = `agreements.html?teamA=${encodeURIComponent(team)}&teamB=${encodeURIComponent(r.partner)}`;
    return `<tr>
      <td style="font-family:var(--mono);font-size:10px;color:var(--c-muted)">${i+1}</td>
      <td style="font-weight:500;font-size:12px;white-space:nowrap">${r.partner}</td>
      <td style="font-size:11px;max-width:180px">${r.desc}</td>
      <td style="font-family:var(--mono);font-size:10px;color:var(--c-muted);white-space:nowrap">${r.date||'—'}</td>
      <td style="font-size:10px;font-family:var(--mono);white-space:nowrap">
        <span style="color:${r.acceptedUs?'var(--c-green)':'var(--c-red)'}">${r.acceptedUs?'✓':'✗'} Ми</span>
        &nbsp;
        <span style="color:${r.acceptedPartner?'var(--c-green)':'var(--c-red)'}">${r.acceptedPartner?'✓':'✗'} Партнер</span>
      </td>
      <td><span class="pill ${statusCls}">${statusLbl}</span></td>
      <td><a href="${cardUrl}" style="font-family:var(--mono);font-size:10px;color:var(--c-blue);text-decoration:none;padding:2px 7px;border:1px solid var(--c-blue);border-radius:3px;white-space:nowrap" title="Відкрити картку угоди">✎ Підписати</a></td>
    </tr>`;
  }).join('');
}

function renderPartnerDemo() {
  const today = new Date();
  document.getElementById('partnerList').innerHTML = DEMO_PARTNERS.map((r,i) => {
    const act = !r.deadline || (() => {
      const p = r.deadline.split('.'); if(p.length<3) return true;
      return new Date(+p[2],+p[1]-1,+p[0]) >= today;
    })();
    return `<tr>
      <td style="font-family:var(--mono);font-size:10px;color:var(--c-muted)">${i+1}</td>
      <td style="font-weight:500;font-size:12px;white-space:nowrap">${r.team||'—'}</td>
      <td style="font-size:12px;max-width:240px">${r.agreement||'—'}</td>
      <td colspan="3" style="white-space:nowrap">
        <span class="pill ${act?'pill-done':'pill-over'}">${r.deadline||'—'}</span>
      </td>
    </tr>`;
  }).join('') || emptyRow(6,'Немає даних');
}

function isPartnerActive(r, today) {
  if (r.active === false) return false;
  if (!r.deadline) return true;
  const parts = String(r.deadline).split('.');
  if (parts.length < 3) return true;
  return new Date(+parts[2], +parts[1]-1, +parts[0]) >= today;
}

function renderComments(comments) {
  document.getElementById('commentsList').innerHTML = comments.map((c,i)=>`
    <div class="comment-card">
      <div class="comment-meta">
        <span class="comment-source">${c.source||c.author||'—'}</span>
        <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="comment-date">${c.date}</span>
          ${statusSelect(i,'comments',c.status)}
        </span>
      </div>
      <div class="comment-text">${c.text||c.description||'—'}</div>
      <div style="margin-top:6px" id="cell_comments_${i}_text" data-val="${encodeURIComponent(c.text||c.description||'')}" data-section="comments" data-row="${i}" data-field="text" data-label="Редагувати текст">
        <button class="write-btn" onclick="activateEditFromCell(this.parentNode)">✎ Редагувати</button>
      </div>
    </div>`).join('') || '<div style="color:var(--c-muted);font-size:12px;padding:8px">Немає записів</div>';
}

function renderCorrective(corrective) {
  document.getElementById('corrBody').innerHTML = corrective.map((r,i)=>{
    const sourceBadge = r.source_problem_id
      ? ` <span class="cd-source-badge" title="Створено з проблеми №${r.source_problem_id}">🔗 з проблеми</span>`
      : '';
    return `<tr>
      <td style="font-family:var(--mono);font-size:11px;color:var(--c-muted)">${r.n||(i+1)}</td>
      <td style="font-size:11px;max-width:120px">${r.description||r.desc||'—'}${sourceBadge}</td>
      ${editCell(i,'corrective','action', r.description||r.action||'', 'Написати дію')}
      ${editCell(i,'corrective','resp',   r.responsible||r.resp||'',   'Відп.')}
      <td style="font-family:var(--mono);font-size:10px;color:var(--c-muted);white-space:nowrap">${r.date}</td>
      <td>${statusSelect(i,'corrective',r.status)}</td>
    </tr>`;
  }).join('') || emptyRow(6,'Немає записів');
}

// ════════════════════════════════════════════════
// МОДАЛЬНА ФОРМА
// ════════════════════════════════════════════════
function openModal() {
  // встановити сьогоднішню дату в полях дат
  const today = new Date().toISOString().slice(0,10);
  ['d_date','p_date','e_date','c_date'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = today;
  });
  document.getElementById('modalBackdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeModal() {
  document.getElementById('modalBackdrop').classList.remove('open');
  document.body.style.overflow = '';
  document.getElementById('formMsg').textContent = '';
}
function closeModalOutside(e) {
  if (e.target === document.getElementById('modalBackdrop')) closeModal();
}

function switchTab(tab, btn) {
  currentTab = tab;
  document.querySelectorAll('.mtab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.form-panel').forEach(p=>p.classList.remove('active'));
  document.getElementById('panel-' + tab).classList.add('active');
  document.getElementById('formMsg').textContent = '';
}

function switchSubtype(type, btn) {
  currentSubtype = type;
  document.querySelectorAll('.stype-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.data-subpanel').forEach(p=>p.style.display='none');
  document.getElementById('sub-' + type).style.display = 'block';
}

async function submitForm() {
  const btn = document.getElementById('submitBtn');
  const msg = document.getElementById('formMsg');
  btn.disabled = true;
  msg.textContent = 'Збереження...';
  msg.className = 'form-msg';

  try {
    let section, data;

    if (currentTab === 'comments') {
      section = 'comments';
      data = {
        text:   document.getElementById('c_text').value.trim(),
        source: document.getElementById('c_source').value.trim(),
        author: document.getElementById('c_author').value.trim(),
        date:   document.getElementById('c_date').value,
        status: document.getElementById('c_status').value,
      };
      if (!data.text) throw new Error('Введіть текст зауваження');
    } else {
      section = currentSubtype;
      if (currentSubtype === 'problem') {
        data = {
          date:   document.getElementById('p_date').value,
          desc:   document.getElementById('p_desc').value.trim(),
          steps:  document.getElementById('p_steps').value.trim(),
          resp:   document.getElementById('p_resp').value.trim(),
          status: document.getElementById('p_status').value,
        };
        section = 'problems';
        if (!data.desc) throw new Error('Введіть опис проблеми');
      } else if (currentSubtype === 'escalation') {
        data = {
          date:   document.getElementById('e_date').value,
          desc:   document.getElementById('e_desc').value.trim(),
          action: document.getElementById('e_action').value.trim(),
          status: document.getElementById('e_status').value,
        };
        section = 'escalations';
        if (!data.desc) throw new Error('Введіть опис ескалації');
      } else if (currentSubtype === 'partner') {
        data = {
          name: document.getElementById('pr_name').value.trim(),
          days: [0,1,2,3,4,5].map(i => document.getElementById('pr_d'+i).checked ? 1 : 0),
          comment: document.getElementById('pr_comment').value.trim(),
        };
        section = 'partners';
        if (!data.name) throw new Error('Введіть назву партнера');
      }
    }

    const team = getSelectedTeam();
    const tableMap2 = {
      problems:    { table: 'problems',    row: d => ({ team, date: d.date, description: d.desc, action: d.action, responsible: d.responsible, status: d.status || 'wip' }) },
      corrective:  { table: 'corrective',  row: d => ({ team, date: d.date, description: d.desc, responsible: d.responsible, deadline: d.deadline, status: d.status || 'wip' }) },
      escalations: { table: 'escalations', row: d => ({ team, date: d.date, description: d.desc, action: d.action, responsible: d.responsible, status: d.status || 'wip' }) },
      comments:    { table: 'comments',    row: d => ({ team, date: d.date, description: d.text || d.desc, author: [d.source, d.author].filter(Boolean).join(' — ') || null, status: d.status || 'open' }) },
    };
    const mapping2 = tableMap2[section];
    if (!mapping2) throw new Error('Невідома секція: ' + section);
    await supaPost(mapping2.table, mapping2.row(data));
    sessionStorage.removeItem('dash_' + team);

    msg.textContent = '✓ Збережено!';
    msg.className = 'form-msg success';
    showToast('Дані збережено', 'success');
    setTimeout(() => { closeModal(); loadData(true); }, 1200);

  } catch(err) {
    msg.textContent = '✕ ' + err.message;
    msg.className = 'form-msg error';
  } finally {
    btn.disabled = false;
  }
}

function getToken() { return ''; }

// ════════════════════════════════════════════════
// УТИЛІТИ
// ════════════════════════════════════════════════
function showToast(msg, type='') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.className = 'toast', 2800);
}
function setText(id, val) { const e=document.getElementById(id); if(e) e.textContent=val; }
function setDelta(id, text, type) {
  const e=document.getElementById(id); if(!e) return;
  e.textContent=text;
  e.className='kpi-delta '+({up:'delta-up',dn:'delta-dn',warn:'delta-warn'}[type]||'delta-warn');
}
function avg(arr) { return arr.length ? arr.reduce((s,v)=>s+(v||0),0)/arr.length : 0; }
function emptyRow(cols, msg) { return `<tr><td colspan="${cols}" style="text-align:center;color:var(--c-muted);padding:12px;font-size:12px">${msg}</td></tr>`; }
function showLoading(show) { document.getElementById('loadingOverlay').classList.toggle('hidden',!show); }
function showError(msg) {
  const b=document.getElementById('errorBanner'); b.style.display='flex';
  document.getElementById('errorText').textContent=msg;
}
function hideError() { document.getElementById('errorBanner').style.display='none'; }
function setUpdateTime(d) { setText('updateTime',`оновлено ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`); }
function setDotOk()    { document.getElementById('statusDot').className='update-dot'; }
function setDotError() { document.getElementById('statusDot').className='update-dot error'; }

// ════════════════════════════════════════════════
// QUICK ADD — додавання з блоків таблиць
// ════════════════════════════════════════════════
let currentQuickSection = null;

const QUICK_FORMS = {
  problem: {
    title: 'Додати проблему',
    section: 'problems',
    fields: () => `
      <div class="form-grid">
        <div class="form-field"><label class="field-label">Дата</label>
          <input class="field-input" type="date" id="qa_date" value="${today()}"></div>
        <div class="form-field"><label class="field-label">Відповідальний</label>
          <input class="field-input" type="text" id="qa_resp" placeholder="Прізвище"></div>
        <div class="form-field full"><label class="field-label">Опис проблеми</label>
          <textarea class="field-input" id="qa_desc" placeholder="Детальний опис..."></textarea></div>
        <div class="form-field full"><label class="field-label">Кроки вирішення</label>
          <textarea class="field-input" id="qa_steps" placeholder="Плановані дії..."></textarea></div>
        <div class="form-field"><label class="field-label">Статус</label>
          <select class="field-input" id="qa_status">
            <option value="wip">В роботі</option><option value="wait">Очікує</option>
            <option value="done">Вирішено</option><option value="over">Прострочено</option>
          </select></div>
      </div>`,
    collect: () => ({
      date: v('qa_date'), desc: v('qa_desc'), steps: v('qa_steps'),
      resp: v('qa_resp'), status: v('qa_status'),
    }),
    validate: d => !d.desc ? 'Введіть опис проблеми' : null,
  },
  escalation: {
    title: 'Додати ескалацію',
    section: 'escalations',
    fields: () => `
      <div class="form-grid">
        <div class="form-field"><label class="field-label">Дата</label>
          <input class="field-input" type="date" id="qa_date" value="${today()}"></div>
        <div class="form-field"><label class="field-label">Статус</label>
          <select class="field-input" id="qa_status">
            <option value="wip">В роботі</option><option value="wait">Очікує</option>
            <option value="done">Вирішено</option><option value="over">Прострочено</option>
          </select></div>
        <div class="form-field full"><label class="field-label">Опис проблеми</label>
          <textarea class="field-input" id="qa_desc" placeholder="Що ескаловано..."></textarea></div>
        <div class="form-field full"><label class="field-label">Дії рівня 2</label>
          <textarea class="field-input" id="qa_action" placeholder="Які дії вжито..."></textarea></div>
      </div>`,
    collect: () => ({
      date: v('qa_date'), desc: v('qa_desc'),
      action: v('qa_action'), status: v('qa_status'),
    }),
    validate: d => !d.desc ? 'Введіть опис ескалації' : null,
  },
  partner: {
    title: 'Додати партнерську угоду',
    section: 'partners',
    fields: () => `
      <div class="form-grid">
        <div class="form-field full"><label class="field-label">Назва партнера / відділу</label>
          <input class="field-input" type="text" id="qa_name" placeholder="Назва партнера"></div>
        <div class="form-field full"><label class="field-label">Статуси по днях (Пн–Сб)</label>
          <div style="display:flex;gap:10px;margin-top:4px">
            ${['Пн','Вт','Ср','Чт','Пт','Сб'].map((d,i)=>`
            <label style="display:flex;flex-direction:column;align-items:center;gap:4px;font-family:var(--mono);font-size:10px;color:var(--c-muted)">
              ${d}<input type="checkbox" id="qa_d${i}" ${i<5?'checked':''} style="width:16px;height:16px">
            </label>`).join('')}
          </div>
        </div>
        <div class="form-field full"><label class="field-label">Коментар</label>
          <input class="field-input" type="text" id="qa_comment" placeholder="Додатково..."></div>
      </div>`,
    collect: () => ({
      name: v('qa_name'),
      days: [0,1,2,3,4,5].map(i => document.getElementById('qa_d'+i)?.checked ? 1 : 0),
      comment: v('qa_comment'),
    }),
    validate: d => !d.name ? 'Введіть назву партнера' : null,
  },
  comment: {
    title: 'Додати зауваження',
    section: 'comments',
    fields: () => `
      <div class="form-grid">
        <div class="form-field"><label class="field-label">Дата</label>
          <input class="field-input" type="date" id="qa_date" value="${today()}"></div>
        <div class="form-field"><label class="field-label">Від кого / Дільниця</label>
          <input class="field-input" type="text" id="qa_source" placeholder="Козловий — Навантажувачі"></div>
        <div class="form-field"><label class="field-label">Автор</label>
          <input class="field-input" type="text" id="qa_author" placeholder="Прізвище"></div>
        <div class="form-field"><label class="field-label">Статус</label>
          <select class="field-input" id="qa_status">
            <option value="wait">Очікує</option><option value="wip">В роботі</option>
            <option value="done">Вирішено</option><option value="over">Прострочено</option>
          </select></div>
        <div class="form-field full"><label class="field-label">Зміст зауваження</label>
          <textarea class="field-input" id="qa_text" style="min-height:80px" placeholder="Детальний опис..."></textarea></div>
      </div>`,
    collect: () => ({
      date: v('qa_date'), source: v('qa_source'),
      author: v('qa_author'), status: v('qa_status'), text: v('qa_text'),
    }),
    validate: d => !d.text ? 'Введіть текст зауваження' : null,
  },
  corrective: {
    title: 'Додати коригуючу дію',
    section: 'corrective',
    fields: () => `
      <div class="form-grid">
        <div class="form-field"><label class="field-label">Дата</label>
          <input class="field-input" type="date" id="qa_date" value="${today()}"></div>
        <div class="form-field"><label class="field-label">Відповідальний</label>
          <input class="field-input" type="text" id="qa_resp" placeholder="Прізвище"></div>
        <div class="form-field full"><label class="field-label">Опис проблеми</label>
          <textarea class="field-input" id="qa_desc" placeholder="Опис..."></textarea></div>
        <div class="form-field full"><label class="field-label">Коригуюча дія</label>
          <textarea class="field-input" id="qa_action" placeholder="Що зробити..."></textarea></div>
        <div class="form-field"><label class="field-label">Статус</label>
          <select class="field-input" id="qa_status">
            <option value="wip">В роботі</option><option value="wait">Очікує</option>
            <option value="done">Вирішено</option><option value="over">Прострочено</option>
          </select></div>
      </div>`,
    collect: () => ({
      date: v('qa_date'), desc: v('qa_desc'),
      action: v('qa_action'), resp: v('qa_resp'), status: v('qa_status'),
    }),
    validate: d => !d.desc ? 'Введіть опис' : null,
  },
};

function v(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}
function today() {
  return new Date().toISOString().slice(0,10);
}

function openQuickAdd(type) {
  const cfg = QUICK_FORMS[type];
  if (!cfg) return;
  currentQuickSection = type;
  setText('quickAddTitle', cfg.title);
  document.getElementById('quickAddBody').innerHTML = `<div class="form-section">${cfg.fields()}</div>`;
  document.getElementById('quickAddMsg').textContent = '';
  document.getElementById('quickAddBackdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
  // Фокус на перше текстове поле
  setTimeout(() => {
    const first = document.querySelector('#quickAddBody input[type=text], #quickAddBody textarea');
    if (first) first.focus();
  }, 100);
}

function closeQuickAdd() {
  document.getElementById('quickAddBackdrop').classList.remove('open');
  document.body.style.overflow = '';
  currentQuickSection = null;
}

function closeQuickAddOutside(e) {
  if (e.target === document.getElementById('quickAddBackdrop')) closeQuickAdd();
}

async function submitQuickAdd() {
  const cfg = QUICK_FORMS[currentQuickSection];
  if (!cfg) return;

  const btn = document.getElementById('quickAddBtn');
  const msg = document.getElementById('quickAddMsg');
  const data = cfg.collect();
  const err  = cfg.validate(data);

  if (err) { msg.textContent = '✕ ' + err; msg.className = 'form-msg error'; return; }

  btn.disabled = true;
  msg.textContent = 'Збереження...';
  msg.className = 'form-msg';

  try {
    const team    = getSelectedTeam();
    const section = cfg.section;

    // Маппінг секцій на таблиці Supabase
    const tableMap = {
      problems:    { table: 'problems',    row: d => ({ team, date: d.date, description: d.desc, action: d.action, responsible: d.responsible, status: d.status || 'wip' }) },
      corrective:  { table: 'corrective',  row: d => ({ team, date: d.date, description: d.desc, responsible: d.responsible, deadline: d.deadline, status: d.status || 'wip' }) },
      escalations: { table: 'escalations', row: d => ({ team, date: d.date, description: d.desc, responsible: d.responsible, status: d.status || 'wip' }) },
      comments:    { table: 'comments',    row: d => ({ team, date: d.date, description: d.text || d.desc, author: [d.source, d.author].filter(Boolean).join(' — ') || null, status: d.status || 'open' }) },
    };

    const mapping = tableMap[section];
    if (!mapping) throw new Error('Невідома секція: ' + section);

    await supaPost(mapping.table, mapping.row(data));
    sessionStorage.removeItem('dash_' + team);

    msg.textContent = '✓ Збережено!';
    msg.className = 'form-msg success';
    showToast('Запис додано', 'success');
    setTimeout(() => { closeQuickAdd(); loadData(true); }, 900);
  } catch(e) {
    msg.textContent = '✕ ' + e.message;
    msg.className = 'form-msg error';
  } finally {
    btn.disabled = false;
  }
}


// ── РЕДАГУВАННЯ МІСІЇ ─────────────────────────
let currentMissionType = 'company';

function openMissionEdit(type) {
  currentMissionType = type;
  const isCompany = type === 'company';
  setText('missionEditTitle', isCompany ? 'Редагувати місію компанії' : 'Редагувати місію команди');

  const meta = fullData?.meta || {};
  document.getElementById('missionEditBody').innerHTML = isCompany ? `
    <div class="form-section">
      <div class="form-grid">
        <div class="form-field full"><label class="field-label">Місія компанії</label>
          <textarea class="field-input" id="me_mission" style="min-height:70px">${meta.companyMission||''}</textarea></div>
        <div class="form-field full"><label class="field-label">Цінності (через кому)</label>
          <input class="field-input" id="me_values" value="${meta.companyValues||''}"></div>
      </div>
    </div>` : `
    <div class="form-section">
      <div class="form-grid">
        <div class="form-field full"><label class="field-label">Місія команди</label>
          <textarea class="field-input" id="me_mission" style="min-height:60px">${meta.teamMission||''}</textarea></div>
        <div class="form-field full"><label class="field-label">Наша мета</label>
          <textarea class="field-input" id="me_goal" style="min-height:60px">${meta.teamGoal||''}</textarea></div>
        <div class="form-field full"><label class="field-label">Цінності команди (через кому)</label>
          <input class="field-input" id="me_values" value="${meta.teamValues||''}"></div>
      </div>
    </div>`;

  document.getElementById('missionEditMsg').textContent = '';
  document.getElementById('missionEditBackdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeMissionEdit() {
  document.getElementById('missionEditBackdrop').classList.remove('open');
  document.body.style.overflow = '';
}

function closeMissionEditOutside(e) {
  if (e.target === document.getElementById('missionEditBackdrop')) closeMissionEdit();
}

async function saveMissionEdit() {
  const msg = document.getElementById('missionEditMsg');
  msg.textContent = 'Збереження...'; msg.className = 'form-msg';

  const isCompany = currentMissionType === 'company';
  const data = isCompany ? {
    companyMission: document.getElementById('me_mission')?.value.trim(),
    companyValues:  document.getElementById('me_values')?.value.trim(),
  } : {
    teamMission: document.getElementById('me_mission')?.value.trim(),
    teamGoal:    document.getElementById('me_goal')?.value.trim(),
    teamValues:  document.getElementById('me_values')?.value.trim(),
  };

  try {
    const team = getSelectedTeam();
    // Зберігаємо кожне поле в team_config
    const rows = Object.entries(data).map(([key, value]) => ({ team, key, value, updated_at: new Date().toISOString() }));
    await supaUpsert('team_config', rows, 'team,key');
    sessionStorage.removeItem('dash_' + team);

    if (fullData?.meta) Object.assign(fullData.meta, data);
    renderMeta(fullData?.meta || {});

    msg.textContent = '✓ Збережено!'; msg.className = 'form-msg success';
    showToast('Місію збережено', 'success');
    // Перезавантажуємо дані з сервера, щоб переконатись що збереглось
    setTimeout(() => { closeMissionEdit(); loadData(true); }, 1200);
  } catch(e) {
    msg.textContent = '✕ ' + e.message; msg.className = 'form-msg error';
    console.error('saveMissionEdit error:', e);
  }
}

document.addEventListener('keydown', e => {
  if(e.key==='Escape') { closeModal(); closeChartSettings(); closeQuickAdd(); closeMissionEdit(); closeRules(); closeCalc(); closeChartEdit(); closeProposalsModal(); closeProposalDetail(); closeWalletModal(); closeSearchModal(); }
});

// БАГ 7: красиві спливаючі підказки (заміна нативного title)
(function initNiceTooltips(){
  let tipEl = null;
  let currentTarget = null;
  document.addEventListener('mouseenter', e => {
    if (!e.target || !e.target.matches) return;
    const el = e.target.closest('[title]');
    if (!el || el === currentTarget) return;
    const text = el.getAttribute('title');
    if (!text) return;
    // Зберігаємо оригінальний title та прибираємо його, щоб не з'явилась нативна підказка
    el.setAttribute('data-tip', text);
    el.removeAttribute('title');
    currentTarget = el;
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'tip-hint';
      document.body.appendChild(tipEl);
    }
    tipEl.textContent = text;
    const r = el.getBoundingClientRect();
    tipEl.style.left = (r.left + window.scrollX) + 'px';
    tipEl.style.top  = (r.top + window.scrollY - tipEl.offsetHeight - 10) + 'px';
    requestAnimationFrame(()=>{
      tipEl.style.top = (r.top + window.scrollY - tipEl.offsetHeight - 10) + 'px';
      tipEl.classList.add('show');
    });
  }, true);
  document.addEventListener('mouseleave', e => {
    if (!e.target || !e.target.matches) return;
    const el = e.target.closest('[data-tip]');
    if (!el) return;
    // Повертаємо title
    const text = el.getAttribute('data-tip');
    if (text) { el.setAttribute('title', text); el.removeAttribute('data-tip'); }
    if (tipEl) tipEl.classList.remove('show');
    currentTarget = null;
  }, true);
})();

// ════════════════════════════════════════════════════════════
// 💡 ПРОПОЗИЦІЇ
// ════════════════════════════════════════════════════════════
let allProposals = [];   // Кеш усіх пропозицій
let currentPropId = null; // ID пропозиції відкритої в міні-модалці

const PROP_STATUS_LABEL = {
  submitted:   'Подана',
  in_review:   'На розгляді',
  in_progress: 'В роботі',
  implemented: 'Впроваджена',
  rejected:    'Відхилена',
};

function propBadge(status) {
  const label = PROP_STATUS_LABEL[status] || status;
  return `<span class="prop-badge ${status}">${label}</span>`;
}

async function openProposalsModal() {
  // Наповнюємо дропдаун команд
  const teamSel = document.getElementById('propFormTeam');
  const filterTeamSel = document.getElementById('propFilterTeam');
  if (teamSel && !teamSel.options.length) {
    TEAMS_LIST.forEach(t => {
      const o = document.createElement('option');
      o.value = t; o.textContent = t;
      teamSel.appendChild(o);
      const o2 = document.createElement('option');
      o2.value = t; o2.textContent = t;
      filterTeamSel.appendChild(o2);
    });
  }
  // За замовчуванням — поточна команда
  teamSel.value = getSelectedTeam();
  await populatePropFormAuthors(teamSel.value);

  // Відкриваємо модалку
  document.getElementById('proposalsModal').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Завантажуємо пропозиції
  await loadProposals();
}

function closeProposalsModal() {
  document.getElementById('proposalsModal').classList.remove('open');
  document.body.style.overflow = '';
}

async function onPropFormTeamChange() {
  const team = document.getElementById('propFormTeam').value;
  await populatePropFormAuthors(team);
}

// Підтягуємо учасників обраної команди в дропдаун автора
async function populatePropFormAuthors(team) {
  const sel = document.getElementById('propFormAuthor');
  sel.innerHTML = '<option value="">-- завантаження --</option>';
  try {
    const rows = await supaGet('team_members', `team=eq.${encodeURIComponent(team)}&select=b24_id,name,position`);
    sel.innerHTML = '';
    if (!rows || !rows.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(немає учасників — спочатку додайте)';
      sel.appendChild(o);
      return;
    }
    const oEmpty = document.createElement('option');
    oEmpty.value = ''; oEmpty.textContent = '-- виберіть --';
    sel.appendChild(oEmpty);
    rows.forEach(r => {
      const o = document.createElement('option');
      o.value = r.b24_id;
      o.dataset.name = r.name;
      o.textContent = r.position ? `${r.name} — ${r.position}` : r.name;
      sel.appendChild(o);
    });
  } catch(e) {
    sel.innerHTML = `<option value="">помилка: ${e.message}</option>`;
  }
}

async function submitProposal() {
  const msg = document.getElementById('propFormMsg');
  const btn = document.getElementById('propSubmitBtn');
  const team = document.getElementById('propFormTeam').value;
  const authorSel = document.getElementById('propFormAuthor');
  const authorId = authorSel.value;
  const authorName = authorId ? (authorSel.options[authorSel.selectedIndex].dataset.name || '') : '';
  const text = document.getElementById('propFormText').value.trim();

  if (!team)  { msg.textContent='✕ Виберіть команду'; msg.style.color='var(--c-red)'; return; }
  if (!text)  { msg.textContent='✕ Введіть текст пропозиції'; msg.style.color='var(--c-red)'; return; }
  if (text.length < 5) { msg.textContent='✕ Текст занадто короткий'; msg.style.color='var(--c-red)'; return; }

  btn.disabled = true; btn.textContent = 'Збереження...';
  msg.textContent = ''; msg.style.color = '';
  try {
    await supaPost('proposals', {
      from_team: team,
      author_id: authorId || null,
      author_name: authorName || null,
      text: text,
      status: 'submitted'
    });
    msg.textContent = '✓ Пропозицію подано'; msg.style.color = 'var(--c-green)';
    document.getElementById('propFormText').value = '';
    await loadProposals();
    setTimeout(()=>{ msg.textContent=''; }, 2500);
  } catch(e) {
    msg.textContent = '✕ ' + e.message; msg.style.color = 'var(--c-red)';
  } finally {
    btn.disabled = false; btn.textContent = 'Подати';
  }
}

async function loadProposals() {
  try {
    const rows = await supaGet('proposals', 'select=*&order=created_at.desc&limit=500');
    allProposals = rows || [];
    renderProposalsTable();
    // Також оновлюємо секцію на дашборді поточної команди
    renderTeamProposals();
  } catch(e) {
    document.getElementById('proposalsTableBody').innerHTML =
      `<tr><td colspan="5" style="text-align:center;color:var(--c-red);padding:14px">Помилка: ${e.message}</td></tr>`;
  }
}

function renderProposalsTable() {
  const body = document.getElementById('proposalsTableBody');
  const filterStatus = document.getElementById('propFilterStatus').value;
  const filterTeam = document.getElementById('propFilterTeam').value;

  let rows = allProposals;
  if (filterStatus) rows = rows.filter(r => r.status === filterStatus);
  if (filterTeam)   rows = rows.filter(r => r.from_team === filterTeam);

  document.getElementById('propTotalCnt').textContent = `(${rows.length})`;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--c-muted);padding:20px">Немає записів</td></tr>';
    return;
  }

  body.innerHTML = rows.map(r => {
    const d = new Date(r.created_at);
    const dStr = isNaN(d) ? '' : `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
    const extra = [];
    if (r.assignee_name) extra.push(`👤 ${escHtml(r.assignee_name)}`);
    if (r.deadline)      extra.push(`⏰ ${escHtml(fmtDDMM(r.deadline))}`);
    const extraLine = extra.length ? `<div style="font-size:10px;color:var(--c-muted);font-family:var(--mono);margin-top:2px">${extra.join(' · ')}</div>` : '';
    const commentLine = r.admin_comment ? `<div style="font-size:11px;color:var(--c-text);background:#fff4c2;padding:4px 8px;border-radius:4px;margin-top:4px;border-left:3px solid #d4a017;white-space:pre-wrap"><b>💬</b> ${escHtml(r.admin_comment)}</div>` : '';
    return `<tr class="prop-row" onclick="openProposalDetail(${r.id})">
      <td style="font-family:var(--mono);font-size:11px">${dStr}</td>
      <td>${escHtml(r.from_team)}</td>
      <td>${escHtml(r.author_name||'—')}</td>
      <td class="prop-text-cell" title="${escHtmlAttr(r.text)}">${escHtml(r.text)}${extraLine}${commentLine}</td>
      <td>${propBadge(r.status)}</td>
    </tr>`;
  }).join('');
}

// Дата у форматі dd.mm.yyyy з YYYY-MM-DD
function fmtDDMM(d) {
  if (!d) return '';
  const s = String(d);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[3]}.${m[2]}.${m[1]}`;
  return s;
}

// Рендер секції на дашборді (пропозиції поточної команди)
function renderTeamProposals() {
  const tbody = document.getElementById('teamProposalsBody');
  if (!tbody) return;
  const team = getSelectedTeam();
  const rows = allProposals.filter(r => r.from_team === team);
  document.getElementById('teamPropCount').textContent = rows.length ? `${rows.length} ${rows.length===1?'пропозиція':rows.length<5?'пропозиції':'пропозицій'}` : '';

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--c-muted);padding:14px">Немає записів</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const d = new Date(r.created_at);
    const dStr = isNaN(d) ? '' : `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
    const extra = [];
    if (r.assignee_name) extra.push(`👤 ${escHtml(r.assignee_name)}`);
    if (r.deadline)      extra.push(`⏰ ${escHtml(fmtDDMM(r.deadline))}`);
    const extraLine = extra.length ? `<div style="font-size:10px;color:var(--c-muted);font-family:var(--mono);margin-top:2px">${extra.join(' · ')}</div>` : '';
    const commentLine = r.admin_comment ? `<div style="font-size:11px;color:var(--c-text);background:#fff4c2;padding:4px 8px;border-radius:4px;margin-top:4px;border-left:3px solid #d4a017;white-space:pre-wrap"><b>💬</b> ${escHtml(r.admin_comment)}</div>` : '';
    return `<tr>
      <td style="font-family:var(--mono);font-size:11px">${dStr}</td>
      <td>${escHtml(r.author_name||'—')}</td>
      <td>${escHtml(r.text)}${extraLine}${commentLine}</td>
      <td>${propBadge(r.status)}</td>
    </tr>`;
  }).join('');
}

function openProposalDetail(id) {
  const p = allProposals.find(r => r.id === id);
  if (!p) return;
  currentPropId = id;
  const d = new Date(p.created_at);
  const dStr = isNaN(d) ? '—' : `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  document.getElementById('pdDate').textContent   = dStr;
  document.getElementById('pdTeam').textContent   = p.from_team;
  document.getElementById('pdAuthor').textContent = p.author_name || '—';
  document.getElementById('pdText').textContent   = p.text;
  document.getElementById('pdStatus').value       = p.status || 'submitted';
  document.getElementById('pdAssignee').value     = p.assignee_name || '';
  document.getElementById('pdDeadline').value     = p.deadline || '';
  document.getElementById('pdComment').value      = p.admin_comment || '';
  document.getElementById('pdMsg').textContent    = '';
  document.getElementById('proposalDetailModal').classList.add('open');
}

function closeProposalDetail() {
  document.getElementById('proposalDetailModal').classList.remove('open');
  currentPropId = null;
}

async function saveProposalStatus() {
  if (!currentPropId) return;
  const newStatus   = document.getElementById('pdStatus').value;
  const assignee    = document.getElementById('pdAssignee').value.trim() || null;
  const deadline    = document.getElementById('pdDeadline').value || null;
  const adminComment = document.getElementById('pdComment').value.trim() || null;
  const msg = document.getElementById('pdMsg');
  const btn = document.getElementById('pdSaveBtn');
  btn.disabled = true; btn.textContent = 'Збереження...';
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/proposals?id=eq.${currentPropId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({
        status: newStatus,
        assignee_name: assignee,
        deadline: deadline,
        admin_comment: adminComment,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status + ': ' + await res.text());
    msg.textContent = '✓ Збережено'; msg.style.color = 'var(--c-green)';
    await loadProposals();
    setTimeout(()=>closeProposalDetail(), 900);
  } catch(e) {
    msg.textContent = '✕ ' + e.message; msg.style.color = 'var(--c-red)';
  } finally {
    btn.disabled = false; btn.textContent = 'Зберегти';
  }
}

async function deleteProposal() {
  if (!currentPropId) return;
  if (!confirm('Видалити цю пропозицію? Дію не можна скасувати.')) return;
  const msg = document.getElementById('pdMsg');
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/proposals?id=eq.${currentPropId}`, {
      method: 'DELETE',
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': 'Bearer ' + SUPA_KEY,
        'Prefer': 'return=minimal',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    msg.textContent = '✓ Видалено'; msg.style.color = 'var(--c-green)';
    await loadProposals();
    setTimeout(()=>closeProposalDetail(), 700);
  } catch(e) {
    msg.textContent = '✕ ' + e.message; msg.style.color = 'var(--c-red)';
  }
}

// ════════════════════════════════════════════════════════════
// 💰 ГАМАНЕЦЬ
// ════════════════════════════════════════════════════════════
let walletSelectedTeam = null;
let walletMembersCache = {}; // team -> [members]

async function openWalletModal() {
  document.getElementById('walletModal').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Переконаємось що дані лідерборду завантажені
  if (!lbRawData) {
    document.getElementById('walletDetails').innerHTML =
      '<div style="text-align:center;color:var(--c-muted);padding:60px 20px">Завантаження даних плюшки...</div>';
    try { await loadLeaderboard(); } catch(e) {}
  }

  // Для першого відкриття — обираємо поточну команду
  walletSelectedTeam = walletSelectedTeam || getSelectedTeam();
  renderWalletTeamList();
  renderWalletDetails(walletSelectedTeam);
}

function closeWalletModal() {
  document.getElementById('walletModal').classList.remove('open');
  document.body.style.overflow = '';
}

// Розраховує накопичувальні бали для команди на основі місць
// Повертає: {totalPoints, totalLikes, totalMoneyPerPerson, wins, history}
function calcTeamWallet(teamName) {
  const raw = lbRawData || [];
  if (!raw.length) return { totalPoints: 0, totalLikes: 0, totalMoneyPerPerson: 0, wins: [], history: [], members: 0 };

  // Групуємо по місяцях
  const byMonth = new Map();
  raw.forEach(r => {
    if (!r.month) return;
    if (!byMonth.has(r.month)) byMonth.set(r.month, []);
    byMonth.get(r.month).push(r);
  });

  let totalPoints = 0;
  let members = 0;
  const history = [];

  // Для кожного місяця — сортуємо, знаходимо місце команди, нараховуємо
  for (const [month, teams] of byMonth) {
    const sorted = [...teams].sort((a, b) => b.totalScore - a.totalScore);
    const idx = sorted.findIndex(t => t.name === teamName);
    if (idx === -1) continue;

    const row = sorted[idx];
    if (row.members > members) members = row.members;

    let percent = 0;
    if (idx === 0) percent = 100;
    else if (idx === 1) percent = 50;

    const earnedPoints = Math.round(row.totalScore * percent / 100 * 10) / 10;
    const earnedLikes  = Math.round(earnedPoints / 10 * 10) / 10;
    // Гроші = бали × 20 (бо 10 балів = 1 лайт = 200 грн ⇒ 1 бал = 20 грн)
    // Нараховується КОЖНОМУ учаснику однаково, не ділиться
    const earnedMoneyPerPerson = Math.round(earnedLikes * 200);

    if (percent > 0) totalPoints += earnedPoints;

    history.push({
      month,
      place: idx + 1,
      teamScore: row.totalScore,
      percent,
      earnedPoints,
      earnedLikes,
      earnedMoneyPerPerson,
      members: row.members,
    });
  }

  const totalLikes = Math.round(totalPoints / 10 * 10) / 10;
  // Гроші на особу = лайти × 200 (кожному однаково, не ділиться)
  const totalMoneyPerPerson = Math.round(totalLikes * 200);
  const wins = history.filter(h => h.percent > 0).length;

  return { totalPoints, totalLikes, totalMoneyPerPerson, wins, history, members };
}

function renderWalletTeamList() {
  const container = document.getElementById('walletTeamList');
  container.innerHTML = TEAMS_LIST.map(team => {
    const w = calcTeamWallet(team);
    const isActive = team === walletSelectedTeam;
    const isZero = w.totalMoneyPerPerson === 0;
    return `<div class="wallet-team-item ${isActive ? 'active' : ''} ${isZero ? 'zero' : ''}" onclick="selectWalletTeam('${escHtmlAttr(team)}')">
      <span>${escHtml(team)}</span>
      <span class="wt-cash">${w.totalMoneyPerPerson > 0 ? '₴'+w.totalMoneyPerPerson : '—'}</span>
    </div>`;
  }).join('');
}

function selectWalletTeam(team) {
  walletSelectedTeam = team;
  renderWalletTeamList();
  renderWalletDetails(team);
}

async function renderWalletDetails(team) {
  const box = document.getElementById('walletDetails');
  box.innerHTML = '<div style="text-align:center;color:var(--c-muted);padding:40px 20px">Завантаження...</div>';

  const w = calcTeamWallet(team);

  // Завантажимо учасників (з кешу або з Supabase)
  let members = walletMembersCache[team];
  if (!members) {
    try {
      const rows = await supaGet('team_members', `team=eq.${encodeURIComponent(team)}&select=b24_id,name,position,photo`);
      members = rows || [];
      walletMembersCache[team] = members;
    } catch(e) {
      members = [];
    }
  }

  // Підсумкові картки
  const summary = `
    <h3 style="margin:0 0 16px;font-size:16px;color:var(--c-text)">${escHtml(team)}</h3>
    <div class="wallet-summary">
      <div class="wallet-sum-card">
        <div class="val">${w.totalPoints}</div>
        <div class="lbl">Бали (накоп.)</div>
      </div>
      <div class="wallet-sum-card">
        <div class="val">${w.totalLikes}</div>
        <div class="lbl">Лайти</div>
      </div>
      <div class="wallet-sum-card">
        <div class="val">₴${w.totalMoneyPerPerson}</div>
        <div class="lbl">₴ на особу</div>
      </div>
      <div class="wallet-sum-card">
        <div class="val">${w.wins}</div>
        <div class="lbl">Перемог місяців</div>
      </div>
    </div>
  `;

  // Учасники
  const perPerson = w.totalMoneyPerPerson;
  // Бали і лайти показуємо однаковими для кожного учасника (не діляться)
  const pointsPerPerson = w.totalPoints;
  const likesPerPerson  = w.totalLikes;

  let membersHtml;
  if (!members.length) {
    membersHtml = '<div style="color:var(--c-muted);font-size:12px;padding:12px;text-align:center">Немає учасників у цій команді. Додайте їх у розділі «Учасники команди» на дашборді.</div>';
  } else {
    membersHtml = `<div class="wallet-member-list">
      ${members.map(m => {
        const initials = (m.name||'').split(' ').map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
        const photo = m.photo ? `<img src="${API_URL}?action=photo&url=${encodeURIComponent(m.photo)}" alt="" onerror="this.style.display='none';this.parentNode.textContent='${initials}'">` : initials;
        return `<div class="wallet-member">
          <div class="wallet-avatar">${photo}</div>
          <div class="m-name">${escHtml(m.name||'—')}</div>
          <div class="m-pos">${escHtml(m.position||'')}</div>
          <div class="m-row"><span>Бали:</span><span>${pointsPerPerson}</span></div>
          <div class="m-row"><span>Лайти:</span><span>${likesPerPerson}</span></div>
          <div class="m-row"><span>Гроші:</span><span class="m-cash">₴${perPerson}</span></div>
        </div>`;
      }).join('')}
    </div>`;
  }

  // Історія по місяцях
  let historyHtml = '';
  if (w.history.length) {
    historyHtml = `
      <div class="wallet-history-block">
        <div class="wh-title">📅 Історія по місяцях</div>
        ${w.history.map(h => {
          const placeText = h.place === 1 ? '🥇 1 місце (100%)' :
                            h.place === 2 ? '🥈 2 місце (50%)' :
                            `${h.place} місце (0%)`;
          const cls = h.percent > 0 ? `place-${h.place}` : 'zero';
          return `<div class="wallet-history-row ${cls}">
            <span class="wh-month">${escHtml(h.month)}</span>
            <span class="wh-place">${placeText}</span>
            <span style="font-family:var(--mono);font-size:11px">${h.teamScore} балів → ${h.earnedPoints}</span>
            <span class="wh-cash">${h.earnedMoneyPerPerson > 0 ? '₴'+h.earnedMoneyPerPerson : '—'}</span>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  box.innerHTML = summary + membersHtml + historyHtml;
}

// ════════════════════════════════════════════════════════════
// 🔍 ПОШУК (Ctrl+K)
// ════════════════════════════════════════════════════════════
let searchDebounceTimer = null;
let searchActiveIndex = -1;
let searchLastResults = [];

function openSearchModal() {
  document.getElementById('searchModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const inp = document.getElementById('searchInput');
  setTimeout(() => { inp.focus(); inp.select && inp.select(); }, 50);
  onSearchInput(); // рендерить пусто або результати
}

function closeSearchModal() {
  document.getElementById('searchModal').classList.remove('open');
  document.body.style.overflow = '';
  searchActiveIndex = -1;
}

function onSearchInput() {
  const q = document.getElementById('searchInput').value.trim();
  const hint = document.getElementById('searchHint');
  const results = document.getElementById('searchResults');
  const stats = document.getElementById('searchStats');

  clearTimeout(searchDebounceTimer);

  if (q.length < 2) {
    hint.textContent = 'від 2 символів';
    hint.style.color = 'var(--c-muted)';
    results.innerHTML = '<div class="search-empty">Введіть запит для пошуку<br><span style="font-size:10px">по проблемах, КД, ескалаціях, угодах, пропозиціях, учасниках, зауваженнях</span></div>';
    stats.textContent = '';
    searchLastResults = [];
    return;
  }

  hint.textContent = 'live-пошук';
  hint.style.color = 'var(--c-blue)';

  searchDebounceTimer = setTimeout(() => {
    doSearch(q);
  }, 200);
}

function doSearch(query) {
  const q = query.toLowerCase();
  const results = [];

  // Хелпер для перевірки збігу
  const match = (str) => str && String(str).toLowerCase().includes(q);
  const highlight = (str) => {
    if (!str) return '';
    const s = String(str);
    const idx = s.toLowerCase().indexOf(q);
    if (idx === -1) return escHtml(s);
    return escHtml(s.slice(0, idx)) + '<mark>' + escHtml(s.slice(idx, idx+query.length)) + '</mark>' + escHtml(s.slice(idx+query.length));
  };

  // 1. Проблеми
  (allProblems || []).forEach((p, i) => {
    const desc = p.description || p.desc || '';
    const action = p.action || p.steps || '';
    const resp = p.responsible || p.resp || '';
    if (match(desc) || match(action) || match(resp)) {
      results.push({
        icon: '🔴',
        group: 'Проблеми',
        title: highlight(desc || '(без опису)'),
        meta: `${p.status || 'wait'} · ${highlight(resp || 'без відп.')} · ${p.date || ''}`,
        target: 'problems',
        idx: i,
        id: p.id,
      });
    }
  });

  // 2. КД
  (allCorrective || []).forEach((r, i) => {
    const desc = r.description || r.desc || '';
    const resp = r.responsible || r.resp || '';
    if (match(desc) || match(resp)) {
      results.push({
        icon: '🔵',
        group: 'Коригуючі дії',
        title: highlight(desc || '(без опису)'),
        meta: `${r.status || 'wait'} · ${highlight(resp || 'без відп.')} · ${r.date || ''}`,
        target: 'corrective',
        idx: i,
        id: r.id,
      });
    }
  });

  // 3. Ескалації
  (allEscalations || []).forEach((e, i) => {
    const desc = e.description || e.desc || '';
    const resp = e.responsible || e.action || '';
    if (match(desc) || match(resp)) {
      results.push({
        icon: '🟠',
        group: 'Ескалації',
        title: highlight(desc || '(без опису)'),
        meta: `${e.status || 'wait'} · ${highlight(resp || '')} · ${e.date || ''}`,
        target: 'escalations',
        idx: i,
        id: e.id,
      });
    }
  });

  // 4. Пропозиції (з поточної команди)
  const currentTeam = getSelectedTeam();
  (allProposals || []).filter(p => p.from_team === currentTeam).forEach(p => {
    const text = p.text || '';
    const author = p.author_name || '';
    if (match(text) || match(author)) {
      results.push({
        icon: '💡',
        group: 'Пропозиції',
        title: highlight(text),
        meta: `${propStatusLabel(p.status)} · ${highlight(author || 'без автора')}`,
        target: 'proposal',
        id: p.id,
      });
    }
  });

  // 5. Учасники команди
  (teamMembers || []).forEach((m, i) => {
    if (match(m.name) || match(m.position)) {
      results.push({
        icon: '👤',
        group: 'Учасники',
        title: highlight(m.name || ''),
        meta: highlight(m.position || 'без посади'),
        target: 'member',
        idx: i,
      });
    }
  });

  // 6. Зауваження
  (allComments || []).forEach((c, i) => {
    const text = c.description || c.text || '';
    const author = c.author || '';
    if (match(text) || match(author)) {
      results.push({
        icon: '💬',
        group: 'Зауваження',
        title: highlight(text || '(без опису)'),
        meta: `${highlight(author || 'без автора')} · ${c.date || ''}`,
        target: 'comments',
        idx: i,
        id: c.id,
      });
    }
  });

  searchLastResults = results;
  searchActiveIndex = results.length > 0 ? 0 : -1;
  renderSearchResults(results);

  const stats = document.getElementById('searchStats');
  stats.textContent = `${results.length} результатів`;
}

function propStatusLabel(s) {
  return (PROP_STATUS_LABEL && PROP_STATUS_LABEL[s]) || s || '';
}

function renderSearchResults(results) {
  const container = document.getElementById('searchResults');
  if (!results.length) {
    container.innerHTML = '<div class="search-empty">Нічого не знайдено</div>';
    return;
  }

  // Групуємо
  const groups = new Map();
  results.forEach(r => {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  });

  let html = '';
  let globalIdx = 0;
  for (const [groupName, items] of groups) {
    html += `<div class="search-group">
      <div class="search-group-header">${groupName} (${items.length})</div>`;
    items.forEach(item => {
      const isActive = globalIdx === searchActiveIndex;
      html += `<div class="search-item ${isActive ? 'active' : ''}" onclick="selectSearchResult(${globalIdx})" data-idx="${globalIdx}">
        <div class="search-item-icon">${item.icon}</div>
        <div class="search-item-body">
          <div class="search-item-title">${item.title}</div>
          <div class="search-item-meta">${item.meta}</div>
        </div>
      </div>`;
      globalIdx++;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
}

function selectSearchResult(idx) {
  const r = searchLastResults[idx];
  if (!r) return;
  closeSearchModal();

  // Знаходимо цільовий елемент і скролимо
  setTimeout(() => {
    let targetEl = null;

    switch (r.target) {
      case 'problems':
        // Скролимо до трекера проблем, знаходимо рядок за id
        targetEl = findRowByRecordId('probBody', r.id);
        break;
      case 'corrective':
        targetEl = findRowByRecordId('corrBody', r.id);
        break;
      case 'escalations':
        targetEl = findRowByRecordId('escalBody', r.id);
        break;
      case 'comments':
        targetEl = findRowByRecordId('commentsBody', r.id);
        break;
      case 'member':
        // Скрол до сітки учасників
        const grid = document.getElementById('membersGrid');
        if (grid) targetEl = grid.children[r.idx];
        break;
      case 'proposal':
        // Відкриваємо детальну модалку
        openProposalDetail(r.id);
        return;
    }

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      targetEl.classList.add('search-highlighted');
      setTimeout(() => targetEl.classList.remove('search-highlighted'), 2000);
    } else {
      // Fallback: скролимо просто до секції
      const sectionMap = {
        problems: 'probBody',
        corrective: 'corrBody',
        escalations: 'escalBody',
        comments: 'commentsBody',
      };
      const section = document.getElementById(sectionMap[r.target]);
      if (section) section.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, 100);
}

// Шукає рядок таблиці за реальним ID запису у масиві-джерелі (не за index)
function findRowByRecordId(tbodyId, recordId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return null;
  const mapping = {
    probBody: allProblems,
    corrBody: allCorrective,
    escalBody: allEscalations,
    commentsBody: allComments,
  };
  const list = mapping[tbodyId] || [];
  const filteredIdx = list.findIndex(r => r.id === recordId);
  if (filteredIdx === -1) return tbody.firstElementChild;
  // Для problems потрібно врахувати фільтр — беремо перший рядок якщо є
  return tbody.children[filteredIdx] || tbody.firstElementChild;
}

// Гарячі клавіші
document.addEventListener('keydown', e => {
  // Ctrl+K або Cmd+K — відкрити пошук
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearchModal();
    return;
  }
  // Клавіатурна навігація в пошуку
  const modal = document.getElementById('searchModal');
  if (!modal || !modal.classList.contains('open')) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    searchActiveIndex = Math.min(searchLastResults.length - 1, searchActiveIndex + 1);
    updateSearchActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    searchActiveIndex = Math.max(0, searchActiveIndex - 1);
    updateSearchActive();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (searchActiveIndex >= 0) selectSearchResult(searchActiveIndex);
  }
});

function updateSearchActive() {
  document.querySelectorAll('.search-item').forEach(el => {
    el.classList.toggle('active', +el.dataset.idx === searchActiveIndex);
  });
  // Скрол до активного елемента
  const activeEl = document.querySelector('.search-item.active');
  if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
}

loadSavedTeam().then(() => loadData()).then(() => {
  // Після завантаження поточної команди — фоново завантажуємо всі інші
  prefetchAllTeams();
  // Завантажуємо пропозиції для секції на дашборді
  loadProposals();
});

// Попереднє завантаження даних для всіх команд у фоні
async function prefetchAllTeams() {
  const currentTeam = getSelectedTeam();
  const CACHE_TTL = 10 * 60 * 1000;

  for (const team of TEAMS_LIST) {
    if (team === currentTeam) continue; // вже завантажено

    const CACHE_KEY = 'dash_' + team;
    try {
      // Пропускаємо якщо кеш свіжий
      const cached = sessionStorage.getItem(CACHE_KEY);
      if (cached) {
        const { ts } = JSON.parse(cached);
        if (Date.now() - ts < CACHE_TTL) continue;
      }
    } catch(e) {}

    // Пауза між запитами щоб не перевантажувати
    await new Promise(r => setTimeout(r, 800));

    try {
      // prefetch через Supabase
      const enc2 = encodeURIComponent(team);
      const [cfg2, charts2, probs2, corr2, esc2, com2, agCfg2, ag2] = await Promise.all([supaGet('team_config',`team=eq.${enc2}&select=key,value`),supaGet('chart_data',`team=eq.${enc2}&select=chart_idx,label,value,plan&order=created_at.asc`),supaGet('problems',`team=eq.${enc2}&select=*`),supaGet('corrective',`team=eq.${enc2}&select=*`),supaGet('escalations',`team=eq.${enc2}&select=*`),supaGet('comments',`team=eq.${enc2}&select=*`),supaGet('charts_config',`team=eq.${enc2}&select=config`),supaGet('agreements',`or=(team_a.eq.${enc2},team_b.eq.${enc2})&select=*`)]);
      const cfgMap2 = {}; (cfg2||[]).forEach(r=>cfgMap2[r.key]=r.value);
      const prefData = {team,meta:{teamName:cfgMap2.teamName||team,companyMission:cfgMap2.companyMission||'',companyValues:cfgMap2.companyValues||'',teamMission:cfgMap2.teamMission||'',teamGoal:cfgMap2.teamGoal||'',teamValues:cfgMap2.teamValues||''},monthly:[],daily:[],weekly:[],problems:(probs2||[]),corrective:(corr2||[]),escalations:(esc2||[]),partners:[],comments:(com2||[]),charts:[0,1,2,3,4].map(i=>(charts2||[]).filter(r=>r.chart_idx===i).map(r=>({label:fmtLabel(r.label),value:r.value,plan:r.plan}))),agreements:{active:0,inactive:0,problem:[],configured:true},chartsConfig:agCfg2?.[0]?.config||null,updatedAt:new Date().toISOString()};
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ data: prefData, ts: Date.now() }));
    } catch(e) {
      // Тихо ігноруємо помилки prefetch
    }
  }
}

// Якщо прийшли з agreements.html з флагом openPlushka
if (sessionStorage.getItem('openPlushka') === '1') {
  sessionStorage.removeItem('openPlushka');
  setTimeout(() => toggleLeaderboard(), 500);
}
