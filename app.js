(() => {
  'use strict';

  const DB_NAME = 'my-time-card';
  const DB_VERSION = 1;
  const DB_STORE = 'app-data';
  const DEFAULT_STATE = {
    version: 1,
    theme: 'dark',
    name: 'ゆうた',
    rates: [
      { id: 'day', name: '通常', start: '09:00', end: '17:00', wage: 1100 },
      { id: 'evening', name: '夕方', start: '17:00', end: '22:00', wage: 1200 },
      { id: 'night', name: '深夜', start: '22:00', end: '05:00', wage: 1400 },
      { id: 'early', name: '早朝', start: '05:00', end: '09:00', wage: 1100 }
    ],
    records: [],
    current: null
  };

  let state = null;
  let db = null;
  let toastTimer = 0;
  let dirtyRates = false;
  let displayedReportMonth = '';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  function clone(value) {
    if (typeof structuredClone === 'function') {
      try { return structuredClone(value); } catch (_) { /* JSON互換データへフォールバック */ }
    }
    return JSON.parse(JSON.stringify(value));
  }

  state = clone(DEFAULT_STATE);

  function eventClosest(event, selector) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      if (node && node.nodeType === 1 && typeof node.matches === 'function' && node.matches(selector)) return node;
    }
    let target = event.target;
    if (target && target.nodeType !== 1) target = target.parentElement;
    return target && typeof target.closest === 'function' ? target.closest(selector) : null;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDBを利用できません'));
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) request.result.createObjectStore(DB_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('データベースを開けません'));
    });
  }

  function idbGet(key) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbSet(key, value) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('保存できませんでした'));
    });
  }

  async function loadState() {
    try {
      db = await openDatabase();
      const stored = await idbGet('state');
      if (stored) return normalizeState(stored);
      try {
        const old = localStorage.getItem(DB_NAME);
        if (old) return normalizeState(JSON.parse(old));
      } catch (_) { /* ローカルストレージ未使用 */ }
      return clone(DEFAULT_STATE);
    } catch (error) {
      console.warn('IndexedDBが使えないため、ローカル保存に切り替えます。', error);
      try {
        const stored = localStorage.getItem(DB_NAME);
        return stored ? normalizeState(JSON.parse(stored)) : clone(DEFAULT_STATE);
      } catch (_) {
        return clone(DEFAULT_STATE);
      }
    }
  }

  function normalizeState(input) {
    const clean = { ...clone(DEFAULT_STATE), ...input };
    clean.version = 1;
    clean.theme = clean.theme === 'light' ? 'light' : 'dark';
    clean.name = typeof clean.name === 'string' ? clean.name.slice(0, 40) : 'ゆうた';
    clean.rates = Array.isArray(clean.rates) ? clean.rates.map((r, i) => ({
      id: String(r.id || `rate-${i + 1}`), name: String(r.name || `時給区分${i + 1}`).slice(0, 24),
      start: validTime(r.start) ? r.start : '09:00', end: validTime(r.end) ? r.end : '17:00',
      wage: Math.max(0, Number(r.wage) || 0)
    })) : clone(DEFAULT_STATE.rates);
    clean.records = Array.isArray(clean.records) ? clean.records.filter(r => r && r.start && r.end).map(r => ({
      ...r, id: String(r.id || makeId()), start: Number(r.start), end: Number(r.end),
      breaks: Array.isArray(r.breaks) ? r.breaks.map(b => ({ start: Number(b.start), end: Number(b.end) })).filter(b => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start) : [],
      ratesSnapshot: Array.isArray(r.ratesSnapshot) ? r.ratesSnapshot : clone(DEFAULT_STATE.rates),
      segments: Array.isArray(r.segments) ? r.segments : [], totalMinutes: Number(r.totalMinutes) || 0,
      amount: Number(r.amount) || 0
    })) : [];
    if (clean.current && clean.current.start) {
      const start = Number(clean.current.start);
      const breakStart = clean.current.breakStart ? Number(clean.current.breakStart) : null;
      clean.current = {
        start,
        startedAt: Number.isFinite(Number(clean.current.startedAt)) ? Number(clean.current.startedAt) : start,
        breaks: Array.isArray(clean.current.breaks) ? clean.current.breaks : [],
        breakStart,
        breakStartedAt: breakStart === null ? null : (Number.isFinite(Number(clean.current.breakStartedAt)) ? Number(clean.current.breakStartedAt) : breakStart)
      };
    } else clean.current = null;
    return clean;
  }

  async function saveState() {
    try {
      if (db) await idbSet('state', state);
      else localStorage.setItem(DB_NAME, JSON.stringify(state));
    } catch (error) {
      try { localStorage.setItem(DB_NAME, JSON.stringify(state)); }
      catch (_) { showToast('保存に失敗しました。端末の空き容量を確認してください。'); }
      console.warn('データ保存に失敗しました。', error);
    }
  }

  function validTime(value) { return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value); }
  function minutesAtTime(value) { const [h, m] = value.split(':').map(Number); return h * 60 + m; }
  function makeId() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
  function roundToNearestQuarter(timestamp) {
    const date = new Date(Number(timestamp));
    const minute = date.getMinutes();
    if (minute >= 52) date.setHours(date.getHours() + 1, 0, 0, 0);
    else if (minute < 8) date.setMinutes(0, 0, 0);
    else if (minute < 24) date.setMinutes(15, 0, 0);
    else if (minute < 38) date.setMinutes(30, 0, 0);
    else date.setMinutes(45, 0, 0);
    return date.getTime();
  }
  function localDateTime(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(value) { const d = new Date(value); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function monthKey(value) { const d = new Date(value); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; }
  function dateLabel(value, includeYear = false) {
    const d = new Date(value);
    return includeYear ? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日` : `${d.getMonth() + 1}/${d.getDate()}`;
  }
  function timeLabel(value) { const d = new Date(value); return `${d.getHours()}:${pad(d.getMinutes())}`; }
  function formatHours(minutes) {
    const hours = Number((minutes / 60).toFixed(2));
    return `${hours}h`;
  }
  function formatDurationClock(start, end, breaks = []) {
    let elapsed = Math.max(0, end - start);
    for (const b of breaks || []) elapsed -= Math.max(0, Math.min(end, b.end) - Math.max(start, b.start));
    return formatElapsedMilliseconds(elapsed);
  }
  function formatElapsedMilliseconds(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60), s = seconds % 60;
    return `${pad(h)}:${pad(m)}:${pad(s)}`;
  }
  function timerSnapshot(current, now) {
    const start = Number.isFinite(Number(current.startedAt)) ? Number(current.startedAt) : Number(current.start);
    const elapsed = Math.max(0, Number(now) - start);
    let breakMilliseconds = 0;
    for (const item of current.breaks || []) {
      breakMilliseconds += Math.max(0, Math.min(Number(now), item.end) - Math.max(start, item.start));
    }
    if (current.breakStart) {
      const breakStart = Number.isFinite(Number(current.breakStartedAt)) ? Number(current.breakStartedAt) : Number(current.breakStart);
      breakMilliseconds += Math.max(0, Number(now) - Math.max(start, breakStart));
    }
    breakMilliseconds = Math.min(elapsed, breakMilliseconds);
    return { elapsed, breakMilliseconds, workMilliseconds: Math.max(0, elapsed - breakMilliseconds) };
  }
  function netMinutes(start, end, breaks) {
    let total = Math.max(0, Math.floor((end - start) / 60000));
    for (const b of breaks || []) {
      const overlap = Math.max(0, Math.min(end, b.end) - Math.max(start, b.start));
      total -= Math.floor(overlap / 60000);
    }
    return Math.max(0, total);
  }
  function yen(value) { return `¥${Math.round(value || 0).toLocaleString('ja-JP')}`; }
  function displayName(name) { return String(name || '').trim() || '時給未設定'; }

  function normalizedRates(rates) {
    return rates.map((r, i) => ({
      id: String(r.id || `rate-${i}`), name: displayName(r.name), start: r.start, end: r.end,
      wage: Math.max(0, Number(r.wage) || 0)
    })).filter(r => validTime(r.start) && validTime(r.end));
  }

  function rateMatchesMinute(rate, minuteOfDay) {
    const start = minutesAtTime(rate.start), end = minutesAtTime(rate.end);
    if (start === end) return true;
    if (start < end) return minuteOfDay >= start && minuteOfDay < end;
    return minuteOfDay >= start || minuteOfDay < end;
  }

  function validateSchedule(rates) {
    const normalized = normalizedRates(rates);
    let gaps = 0, overlaps = 0;
    for (let minute = 0; minute < 1440; minute++) {
      const matches = normalized.filter(r => rateMatchesMinute(r, minute)).length;
      if (!matches) gaps++;
      if (matches > 1) overlaps++;
    }
    const issues = [];
    if (overlaps) issues.push(`時給区分が重複している時間が${formatMinutes(overlaps)}あります。先頭の区分を計算に使います。`);
    if (gaps) issues.push(`時給未設定の時間が${formatMinutes(gaps)}あります。この時間の給与は0円で記録します。`);
    const empty = rates.some(r => !String(r.name || '').trim() || !validTime(r.start) || !validTime(r.end) || Number(r.wage) < 0);
    if (empty) issues.push('未入力または不正な時給区分があります。開始・終了時刻と時給を確認してください。');
    return { gaps, overlaps, message: issues.join(' ') };
  }

  function formatMinutes(minutes) {
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60}時間`;
    if (minutes >= 60) return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
    return `${minutes}分`;
  }

  function calculateRecord(start, end, breaks, ratesSnapshot, id = makeId()) {
    start = Math.floor(Number(start) / 60000) * 60000;
    end = Math.floor(Number(end) / 60000) * 60000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('退勤は出勤より後の日時を指定してください。');
    if (end - start > 45 * 86400000) throw new Error('1回の勤務は45日以内で入力してください。');
    const cleanBreaks = (breaks || []).map(b => ({
      start: Math.max(start, Math.floor(Number(b.start) / 60000) * 60000),
      end: Math.min(end, Math.floor(Number(b.end) / 60000) * 60000)
    })).filter(b => b.end > b.start).sort((a, b) => a.start - b.start);
    const rates = normalizedRates(ratesSnapshot);
    const segments = [];
    let totalMinutes = 0;
    for (let cursor = start; cursor < end; cursor += 60000) {
      if (cleanBreaks.some(b => cursor >= b.start && cursor < b.end)) continue;
      totalMinutes++;
      const date = new Date(cursor);
      const minuteOfDay = date.getHours() * 60 + date.getMinutes();
      const band = rates.find(r => rateMatchesMinute(r, minuteOfDay));
      const bandId = band ? band.id : 'unassigned';
      const previous = segments[segments.length - 1];
      if (previous && previous.bandId === bandId && previous.end === cursor) {
        previous.end += 60000;
        previous.minutes++;
      } else {
        segments.push({ bandId, bandName: band ? band.name : '時給未設定', rate: band ? band.wage : 0, start: cursor, end: cursor + 60000, minutes: 1 });
      }
    }
    const amount = segments.reduce((sum, s) => sum + s.minutes * s.rate / 60, 0);
    return {
      id, start, end, breaks: cleanBreaks, ratesSnapshot: clone(ratesSnapshot),
      segments, totalMinutes, amount: Number(amount.toFixed(2)), dayKey: dateKey(start),
      updatedAt: Date.now()
    };
  }

  function transitionPunch(current, records, action, timestamp, ratesSnapshot) {
    const now = roundToNearestQuarter(timestamp);
    if (action === 'clock-in') {
      if (current) return { current, records, changed: false, message: 'すでに勤務中です' };
      return { current: { start: now, startedAt: Number(timestamp), breaks: [], breakStart: null, breakStartedAt: null }, records, changed: true, message: '出勤時刻を記録しました' };
    }
    if (!current) return { current: null, records, changed: false, message: '' };
    if (action === 'break-start') {
      if (current.breakStart) return { current, records, changed: false, message: '' };
      return { current: { ...current, breakStart: now, breakStartedAt: Number(timestamp) }, records, changed: true, message: '休憩を開始しました' };
    }
    if (action === 'break-end') {
      if (!current.breakStart) return { current, records, changed: false, message: '' };
      if (now <= current.breakStart) return { current, records, changed: false, error: '休憩終了時刻を確認してください' };
      return { current: { ...current, breaks: [...(current.breaks || []), { start: current.breakStart, end: now }], breakStart: null, breakStartedAt: null }, records, changed: true, message: '休憩時間を記録しました' };
    }
    if (action === 'clock-out') {
      const startedAt = Number.isFinite(Number(current.startedAt)) ? Number(current.startedAt) : Number(current.start);
      if (Number(timestamp) - startedAt < 15 * 60000) {
        return { current: null, records, changed: true, cancelled: true, message: '15分未満のため勤務を取り消しました' };
      }
      const breaks = [...(current.breaks || [])];
      if (current.breakStart && now > current.breakStart) breaks.push({ start: current.breakStart, end: now });
      const record = calculateRecord(current.start, now, breaks, ratesSnapshot);
      return { current: null, records: [...records, record], changed: true, record, message: `退勤を記録しました · ${yen(record.amount)}` };
    }
    return { current, records, changed: false, message: '' };
  }

  function aggregate(records) {
    const map = new Map();
    for (const record of records) for (const segment of record.segments || []) {
      const key = segment.bandName || '時給未設定';
      const entry = map.get(key) || { name: key, minutes: 0, amount: 0 };
      entry.minutes += Number(segment.minutes) || 0;
      entry.amount += (Number(segment.minutes) || 0) * (Number(segment.rate) || 0) / 60;
      map.set(key, entry);
    }
    return [...map.values()];
  }

  function totalMinutes(records) { return records.reduce((sum, r) => sum + (Number(r.totalMinutes) || 0), 0); }
  function totalPay(records) { return records.reduce((sum, r) => sum + (Number(r.amount) || 0), 0); }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function navigate(view) {
    $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
    $$('.tab').forEach(el => el.classList.toggle('active', el.dataset.nav === view));
    renderView(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderView(view) {
    if (view === 'home') renderHome();
    else if (view === 'history') renderHistory();
    else if (view === 'report') renderReport();
    else if (view === 'settings') renderSettings();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    const theme = $('meta[name="theme-color"]');
    if (theme) theme.content = state.theme === 'dark' ? '#111318' : '#f5f6f8';
  }

  function refreshCurrentTimer(current, now) {
    const timer = timerSnapshot(current, now);
    $('#elapsed-time').textContent = formatElapsedMilliseconds(timer.elapsed);
    $('#elapsed-details').textContent = `実働 ${formatElapsedMilliseconds(timer.workMilliseconds)} · 休憩 ${formatElapsedMilliseconds(timer.breakMilliseconds)}`;
  }

  function refreshClock(now = Date.now()) {
    const date = new Date(now);
    $('#current-time').textContent = `${date.getHours()}:${pad(date.getMinutes())}`;
    $('#today-date').textContent = `${dateLabel(date, true)}（${'日月火水木金土'[date.getDay()]}）`;
    if (state.current) refreshCurrentTimer(state.current, now);
    if (displayedReportMonth && monthKey(date) !== displayedReportMonth) renderReport();
  }

  function startClock() {
    refreshClock();
    window.setInterval(refreshClock, 1000);
  }

  function renderHome() {
    const now = Date.now();
    refreshClock(now);
    const current = state.current;
    const status = $('#work-status');
    const actions = $('#punch-actions');
    actions.replaceChildren();
    status.className = 'status-pill';
    if (!current) {
      status.textContent = '未出勤';
      $('#timer-label').textContent = '今日もおつかれさまです';
      $('#elapsed-time').classList.add('hidden');
      $('#elapsed-details').classList.add('hidden');
      addPunchButton(actions, '出勤する', 'primary punch-button', 'clock-in');
    } else {
      const breaking = Boolean(current.breakStart);
      status.textContent = breaking ? '休憩中' : '勤務中';
      status.classList.add(breaking ? 'breaking' : 'working');
      $('#timer-label').textContent = breaking ? `休憩中 · 出勤 ${timeLabel(current.start)}` : `出勤 ${timeLabel(current.start)} · 勤務経過時間`;
      $('#elapsed-time').classList.remove('hidden');
      $('#elapsed-details').classList.remove('hidden');
      refreshCurrentTimer(current, now);
      if (breaking) addPunchButton(actions, '休憩を終了', 'primary punch-button', 'break-end');
      else {
        addPunchButton(actions, '休憩を開始', 'secondary punch-secondary', 'break-start');
        addPunchButton(actions, '退勤する', 'primary punch-secondary', 'clock-out');
      }
    }
    const validation = validateSchedule(state.rates);
    const warning = $('#rate-warning-home');
    warning.textContent = validation.message;
    warning.classList.toggle('hidden', !validation.message);
    const currentMonth = monthKey(now);
    const monthRecords = state.records.filter(r => monthKey(r.start) === currentMonth);
    const monthDays = new Set(monthRecords.map(r => dateKey(r.start)));
    $('#month-days').textContent = String(monthDays.size);
    $('#month-hours').textContent = formatHours(totalMinutes(monthRecords));
    $('#month-pay').textContent = yen(totalPay(monthRecords));
    $('#all-hours').textContent = formatHours(totalMinutes(state.records));
    renderBreakdown($('#home-breakdown'), aggregate(state.records), true);
  }

  function addPunchButton(parent, label, className, action) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = className; button.textContent = label; button.dataset.action = action;
    button.addEventListener('click', () => { void clockAction(action); });
    parent.append(button);
  }

  function renderBreakdown(parent, groups, showPay) {
    parent.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement('div'); empty.className = 'empty-note'; empty.textContent = '勤務を記録すると、ここに集計が表示されます。'; parent.append(empty); return;
    }
    for (const group of groups) {
      const row = document.createElement('div'); row.className = 'breakdown-row';
      const left = document.createElement('div');
      const name = document.createElement('div'); name.className = 'breakdown-name'; name.textContent = group.name;
      const detail = document.createElement('div'); detail.className = 'breakdown-detail'; detail.textContent = showPay ? yen(group.amount) : '';
      left.append(name, detail);
      const value = document.createElement('div'); value.className = 'breakdown-value'; value.textContent = formatHours(group.minutes);
      row.append(left, value); parent.append(row);
    }
  }

  function renderHistory() {
    const monthInput = $('#month-select');
    if (!monthInput.value) monthInput.value = monthKey(Date.now());
    const selectedMonth = monthInput.value;
    const records = state.records.filter(r => monthKey(r.start) === selectedMonth).sort((a, b) => b.start - a.start);
    const days = new Set(records.map(r => dateKey(r.start)));
    const summary = $('#month-summary'); summary.replaceChildren();
    const grid = document.createElement('div'); grid.className = 'month-summary-grid';
    const stats = [
      ['勤務日数', `${days.size}日`], ['勤務時間', formatHours(totalMinutes(records))], ['給与合計', yen(totalPay(records))]
    ];
    for (const [label, value] of stats) {
      const item = document.createElement('div');
      const l = document.createElement('div'); l.className = 'stat-label'; l.textContent = label;
      const v = document.createElement('div'); v.className = 'stat-value'; v.textContent = value;
      item.append(l, v); grid.append(item);
    }
    summary.append(grid);
    const list = $('#history-list'); list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div'); empty.className = 'empty-state card'; empty.textContent = 'この月の勤務記録はありません。\n右上の「手動で追加」から登録できます。'; list.append(empty);
      return;
    }
    for (const record of records) list.append(createHistoryItem(record));
  }

  function createHistoryItem(record) {
    const card = document.createElement('article'); card.className = 'history-item card';
    const head = document.createElement('div'); head.className = 'history-item-head';
    const left = document.createElement('div');
    const date = document.createElement('div'); date.className = 'history-date'; date.textContent = dateLabel(record.start, true);
    const times = document.createElement('div'); times.className = 'history-time'; times.textContent = `${timeLabel(record.start)} ～ ${timeLabel(record.end)} · 実働 ${formatHours(record.totalMinutes)}`;
    left.append(date, times);
    const right = document.createElement('div'); right.className = 'history-total';
    right.textContent = `${record.totalMinutes}分`;
    const pay = document.createElement('div'); pay.className = 'history-pay'; pay.textContent = yen(record.amount); right.append(pay);
    head.append(left, right); card.append(head);
    const details = document.createElement('div'); details.className = 'history-breakdown';
    const byBand = aggregate([record]);
    details.textContent = byBand.map(g => `${g.name} ${formatHours(g.minutes)} · ${yen(g.amount)}`).join('　 /　') || '勤務時間なし';
    card.append(details);
    const actions = document.createElement('div'); actions.className = 'history-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary'; edit.textContent = '編集'; edit.dataset.edit = record.id;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger-button'; remove.textContent = '削除'; remove.dataset.delete = record.id;
    actions.append(edit, remove); card.append(actions);
    return card;
  }

  function renderReport() {
    const currentMonth = monthKey(Date.now());
    displayedReportMonth = currentMonth;
    const records = state.records
      .filter(record => monthKey(record.start) === currentMonth)
      .sort((a, b) => a.start - b.start);
    $('#report-text').value = buildReportText(state.name, records, currentMonth);
    const groups = aggregate(records);
    $('#report-total').replaceChildren();
    const label = document.createElement('span'); label.textContent = `${records.length}回の勤務 · ${groups.length}区分`;
    const amount = document.createElement('strong'); amount.textContent = `${formatHours(totalMinutes(records))}　${yen(totalPay(records))}`;
    $('#report-total').append(label, amount);
    $('#share-hint').textContent = navigator.share ? '共有メニューからLINEを選べます。' : 'コピーした文章をLINEに貼り付けてください。';
  }

  function reportIntervals(record) {
    const start = Number(record.start), end = Number(record.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

    const breaks = (record.breaks || [])
      .map(item => ({ start: Math.max(start, Number(item.start)), end: Math.min(end, Number(item.end)) }))
      .filter(item => Number.isFinite(item.start) && Number.isFinite(item.end) && item.end > item.start)
      .sort((a, b) => a.start - b.start);
    const mergedBreaks = [];
    for (const item of breaks) {
      const previous = mergedBreaks[mergedBreaks.length - 1];
      if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
      else mergedBreaks.push({ ...item });
    }

    const workedRanges = [];
    let cursor = start;
    for (const item of mergedBreaks) {
      if (item.start > cursor) workedRanges.push({ start: cursor, end: item.start });
      cursor = Math.max(cursor, item.end);
    }
    if (cursor < end) workedRanges.push({ start: cursor, end });

    const intervals = [];
    for (const range of workedRanges) {
      cursor = range.start;
      while (cursor < range.end) {
        const date = new Date(cursor);
        const minuteOfDay = date.getHours() * 60 + date.getMinutes();
        const boundary = new Date(cursor);
        if (minuteOfDay < 22 * 60) boundary.setHours(22, 0, 0, 0);
        else boundary.setHours(24, 0, 0, 0);
        const next = Math.min(range.end, boundary.getTime());
        if (next <= cursor) break;
        intervals.push({ start: cursor, end: next, minutes: Math.round((next - cursor) / 60000), dayKey: dateKey(cursor) });
        cursor = next;
      }
    }
    return intervals;
  }

  function buildReportText(name, records, targetMonth = monthKey(Date.now())) {
    const lines = [String(name || '').trim() || 'ゆうた'];
    const intervals = records
      .filter(record => monthKey(record.start) === targetMonth)
      .sort((a, b) => a.start - b.start)
      .flatMap(reportIntervals)
      .sort((a, b) => a.start - b.start);
    let previousDay = '';
    let beforeMinutes = 0, afterMinutes = 0;
    for (const interval of intervals) {
      const after = new Date(interval.start).getHours() >= 22;
      if (after) afterMinutes += interval.minutes;
      else beforeMinutes += interval.minutes;
      const dateColumn = interval.dayKey === previousDay
        ? ' '.repeat(6)
        : `${dateLabel(interval.start).padEnd(5, ' ')} `;
      lines.push(`${dateColumn}${timeLabel(interval.start)}～${timeLabel(interval.end)} ${formatHours(interval.minutes)}`);
      previousDay = interval.dayKey;
    }
    lines.push(`前${formatHours(beforeMinutes)} 後${formatHours(afterMinutes)}`);
    return lines.join('\n');
  }

  function renderSettings() {
    $$('.theme-switch button').forEach(button => button.classList.toggle('selected', button.dataset.theme === state.theme));
    $('#display-name').value = state.name;
    if (!dirtyRates) renderRates();
    renderRateWarning();
  }

  function renderRateWarning() {
    const result = validateSchedule(getRateInputs());
    const warning = $('#rate-warning');
    warning.textContent = result.message;
    warning.classList.toggle('hidden', !result.message);
  }

  function getRateInputs() {
    return $$('.rate-item').map(item => ({
      id: item.dataset.id,
      name: $('.rate-name', item).value.trim(),
      wage: Number($('.rate-price', item).value),
      start: $('.rate-start', item).value,
      end: $('.rate-end', item).value
    }));
  }

  function renderRates(rates = state.rates) {
    const list = $('#rates-list'); list.replaceChildren();
    for (const rate of rates) {
      const item = document.createElement('div'); item.className = 'rate-item'; item.dataset.id = rate.id;
      const head = document.createElement('div'); head.className = 'rate-head';
      const name = document.createElement('input'); name.className = 'rate-name'; name.value = rate.name; name.maxLength = 24; name.placeholder = '区分名'; name.setAttribute('aria-label', '時給区分名');
      const price = document.createElement('input'); price.className = 'rate-price'; price.type = 'number'; price.min = '0'; price.step = '1'; price.inputMode = 'numeric'; price.value = String(rate.wage); price.setAttribute('aria-label', '時給（円）');
      const priceLabel = document.createElement('span'); priceLabel.className = 'rate-price-label'; priceLabel.textContent = '円';
      const del = document.createElement('button'); del.type = 'button'; del.className = 'rate-delete'; del.textContent = '×'; del.title = 'この区分を削除'; del.dataset.removeRate = rate.id;
      head.append(name, price, priceLabel, del);
      const times = document.createElement('div'); times.className = 'rate-times';
      for (const [labelText, className, value] of [['開始', 'rate-start', rate.start], ['終了', 'rate-end', rate.end]]) {
        const label = document.createElement('label'); label.textContent = labelText;
        const input = document.createElement('input'); input.type = 'time'; input.className = className; input.value = value; input.setAttribute('aria-label', `${rate.name} ${labelText}時刻`);
        label.append(input); times.append(label);
      }
      item.append(head, times); list.append(item);
    }
    dirtyRates = false;
  }

  function parseBreaks(text) {
    const result = [];
    for (const line of text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)) {
      const pair = line.split(/\s*\/\s*/);
      if (pair.length !== 2) throw new Error('休憩は「開始 / 終了」の形式で入力してください。');
      const start = new Date(pair[0]).getTime(), end = new Date(pair[1]).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error('休憩の日時を確認してください。');
      result.push({ start, end });
    }
    return result;
  }

  function openEntryDialog(record = null) {
    $('#entry-form').reset();
    $('#entry-id').value = record ? record.id : '';
    $('#dialog-title').textContent = record ? '勤務を編集' : '勤務を追加';
    if (record) {
      $('#entry-start').value = localDateTime(record.start);
      $('#entry-end').value = localDateTime(record.end);
      $('#entry-breaks').value = (record.breaks || []).map(b => `${localDateTime(b.start)} / ${localDateTime(b.end)}`).join('\n');
    } else {
      const selectedMonth = $('#month-select').value;
      const now = new Date();
      const today = selectedMonth && selectedMonth !== monthKey(now)
        ? new Date(Number(selectedMonth.slice(0, 4)), Number(selectedMonth.slice(5, 7)) - 1, 1)
        : now;
      const start = new Date(today); start.setHours(9, 0, 0, 0);
      const end = new Date(today); end.setHours(17, 0, 0, 0);
      $('#entry-start').value = localDateTime(start);
      $('#entry-end').value = localDateTime(end);
      $('#entry-breaks').value = '';
    }
    $('#entry-dialog').showModal();
  }

  async function submitEntry(event) {
    event.preventDefault();
    try {
      const id = $('#entry-id').value;
      const start = new Date($('#entry-start').value).getTime();
      const end = new Date($('#entry-end').value).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('出勤・退勤の日時を確認してください。');
      const breaks = parseBreaks($('#entry-breaks').value);
      const original = id ? state.records.find(r => r.id === id) : null;
      const snapshot = original ? original.ratesSnapshot : clone(state.rates);
      const updated = calculateRecord(start, end, breaks, snapshot, id || makeId());
      if (original) state.records = state.records.map(r => r.id === id ? updated : r);
      else state.records.push(updated);
      await saveState();
      $('#entry-dialog').close();
      renderHistory(); renderHome();
      showToast(original ? '勤務記録を更新しました' : '勤務記録を追加しました');
    } catch (error) { showToast(error.message || '入力内容を確認してください'); }
  }

  async function clockAction(action, timestamp = Date.now()) {
    try {
      const result = transitionPunch(state.current, state.records, action, timestamp, clone(state.rates));
      if (result.error) return showToast(result.error);
      if (!result.changed) { if (result.message) showToast(result.message); return; }
      state.current = result.current;
      state.records = result.records;
      renderHome(); showToast(result.message);
      await saveState();
    } catch (error) { showToast(error.message); }
  }

  async function saveRates() {
    const inputs = getRateInputs();
    const invalid = inputs.find(r => !r.name || !validTime(r.start) || !validTime(r.end) || !Number.isFinite(r.wage) || r.wage < 0);
    if (!inputs.length) return showToast('時給区分を1つ以上登録してください');
    if (invalid) return showToast('区分名、時刻、時給を確認してください');
    state.rates = inputs;
    dirtyRates = false;
    renderRates(); renderRateWarning(); renderHome();
    showToast('時給設定を保存しました');
    await saveState();
  }

  function addRate() {
    const id = makeId();
    const rates = getRateInputs();
    rates.push({ id, name: `時給区分${rates.length + 1}`, start: '09:00', end: '17:00', wage: 1100 });
    renderRates(rates); dirtyRates = true; renderRateWarning();
  }

  async function setTheme(theme) {
    state.theme = theme === 'light' ? 'light' : 'dark';
    applyTheme(); renderSettings();
    await saveState();
  }

  function createCsv(records) {
    const rows = [['出勤日時', '退勤日時', '休憩', '実働分', '実働時間', '給与(円)', '時給区分内訳']];
    for (const record of [...records].sort((a, b) => a.start - b.start)) {
      const breaks = (record.breaks || []).map(b => `${localDateTime(b.start)}-${localDateTime(b.end)}`).join(' / ');
      const breakdown = aggregate([record]).map(g => `${g.name}:${formatHours(g.minutes)}:${Math.round(g.amount)}円`).join(' / ');
      rows.push([localDateTime(record.start), localDateTime(record.end), breaks, record.totalMinutes, formatHours(record.totalMinutes), record.amount, breakdown]);
    }
    return '\ufeff' + rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\n');
  }

  function download(filename, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function bindEvents() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refreshClock();
    });
    document.addEventListener('click', async event => {
      const nav = eventClosest(event, '[data-nav]');
      if (nav) return navigate(nav.dataset.nav);
      const removeRate = eventClosest(event, '[data-remove-rate]');
      if (removeRate) {
        const rates = getRateInputs();
        if (rates.length <= 1) return showToast('時給区分は1つ以上必要です');
        renderRates(rates.filter(r => r.id !== removeRate.dataset.removeRate)); dirtyRates = true; renderRateWarning(); return;
      }
      const edit = eventClosest(event, '[data-edit]');
      if (edit) return openEntryDialog(state.records.find(r => r.id === edit.dataset.edit));
      const del = eventClosest(event, '[data-delete]');
      if (del) {
        const record = state.records.find(r => r.id === del.dataset.delete);
        if (record && window.confirm(`${dateLabel(record.start, true)}の勤務記録を削除しますか？`)) {
          state.records = state.records.filter(r => r.id !== record.id); await saveState(); renderHistory(); renderHome(); showToast('勤務記録を削除しました');
        }
        return;
      }
      if (eventClosest(event, '#add-entry')) return openEntryDialog();
      if (eventClosest(event, '.close-dialog')) { $('#entry-dialog').close(); return; }
      if (eventClosest(event, '#copy-report')) {
        try { await navigator.clipboard.writeText($('#report-text').value); showToast('報告文をコピーしました'); }
        catch (_) { $('#report-text').focus(); $('#report-text').select(); document.execCommand('copy'); showToast('報告文をコピーしました'); }
        return;
      }
      if (eventClosest(event, '#share-report')) {
        const text = $('#report-text').value;
        if (navigator.share) {
          try { await navigator.share({ text, title: '勤務報告' }); } catch (error) { if (error.name !== 'AbortError') showToast('共有を開始できませんでした'); }
        } else {
          try { await navigator.clipboard.writeText(text); showToast('共有に対応していないため文章をコピーしました'); }
          catch (_) { showToast('「文章をコピー」からコピーしてください'); }
        }
        return;
      }
      if (eventClosest(event, '#export-csv')) {
        const month = $('#month-select').value;
        const records = state.records.filter(r => monthKey(r.start) === month);
        download(`MY_TIME_CARD_${month || 'all'}.csv`, createCsv(records), 'text/csv;charset=utf-8');
        showToast('CSVを書き出しました'); return;
      }
      if (eventClosest(event, '#backup-data')) {
        download(`MY_TIME_CARD_backup_${dateKey(Date.now())}.json`, JSON.stringify({ app: 'MY TIME CARD', version: 1, exportedAt: new Date().toISOString(), state }, null, 2), 'application/json');
        showToast('バックアップを保存しました'); return;
      }
      if (eventClosest(event, '#restore-data')) { $('#restore-file').click(); return; }
    }, true);

    $('#add-rate').addEventListener('click', addRate);
    $('#save-rates').addEventListener('click', () => { void saveRates(); });
    $$('.theme-switch button').forEach(button => button.addEventListener('click', () => { void setTheme(button.dataset.theme); }));
    $('#display-name').addEventListener('input', event => {
      if (event.target.matches('#display-name')) {
        state.name = event.target.value.slice(0, 40);
        saveState();
      }
    });
    $('#rates-list').addEventListener('input', event => {
      if (eventClosest(event, '.rate-item input')) { dirtyRates = true; renderRateWarning(); }
    });
    $('#display-name').addEventListener('change', () => renderReport());
    $('#month-select').addEventListener('change', renderHistory);
    $('#entry-form').addEventListener('submit', submitEntry);
    $('#restore-file').addEventListener('change', async event => {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const incoming = parsed.state || parsed;
        if (!incoming || !Array.isArray(incoming.records) || !Array.isArray(incoming.rates)) throw new Error('MY TIME CARDのバックアップJSONではありません。');
        if (!window.confirm('現在の勤務履歴・設定をバックアップの内容に置き換えますか？')) return;
        state = normalizeState(incoming); dirtyRates = false;
        await saveState(); applyTheme(); renderView('settings'); renderHome(); renderReport(); showToast('バックアップを復元しました');
      } catch (error) { showToast(error.message || 'JSONファイルを読み込めませんでした'); }
      finally { event.target.value = ''; }
    });
    $('#entry-dialog').addEventListener('click', event => {
      if (event.target === $('#entry-dialog')) $('#entry-dialog').close();
    });
  }

  async function init() {
    state = await loadState();
    applyTheme();
    bindEvents();
    renderHome();
    $('#month-select').value = monthKey(Date.now());
    renderHistory(); renderReport(); renderSettings();
    startClock();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      const workerUrl = new URL('./sw.js?v=2.3.0', document.baseURI);
      navigator.serviceWorker.register(workerUrl.href)
        .then(registration => registration.update())
        .catch(error => console.warn('Service Workerの登録に失敗しました。', error));
    }
  }

  init().catch(error => {
    console.error(error);
    document.body.insertAdjacentHTML('beforeend', '<p style="padding:24px;color:#f88">アプリを起動できませんでした。ページを再読み込みしてください。</p>');
  });
})();
