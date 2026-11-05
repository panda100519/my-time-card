const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

process.env.TZ = 'Asia/Tokyo';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.nodeType = 1;
    this.id = '';
    this.className = '';
    this.dataset = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = new Map();
    this.attributes = {};
    this.value = '';
    this.textContent = '';
    this.classList = {
      add: name => this.setClass(name, true),
      remove: name => this.setClass(name, false),
      toggle: (name, force) => {
        const enabled = force === undefined ? !this.className.split(/\s+/).includes(name) : Boolean(force);
        this.setClass(name, enabled);
        return enabled;
      }
    };
  }
  setClass(name, enabled) {
    const classes = new Set(this.className.split(/\s+/).filter(Boolean));
    if (enabled) classes.add(name); else classes.delete(name);
    this.className = [...classes].join(' ');
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler); this.listeners.set(type, handlers);
  }
  append(...items) {
    for (const item of items) { item.parentElement = this; this.children.push(item); }
  }
  replaceChildren(...items) {
    this.children = [];
    this.append(...items);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('[data-') && selector.endsWith(']')) {
      const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return Object.prototype.hasOwnProperty.call(this.dataset, key);
    }
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector === '.rate-item input') {
      let parent = this.parentElement;
      while (parent && !parent.matches('.rate-item')) parent = parent.parentElement;
      return this.tagName === 'INPUT' && Boolean(parent);
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  closest(selector) {
    let current = this;
    while (current) { if (current.matches(selector)) return current; current = current.parentElement; }
    return null;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const found = [];
    const walk = element => {
      for (const child of element.children) {
        if (child.matches(selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
}

class FakeDocument {
  constructor() {
    this.listeners = new Map();
    this.elements = new Map();
    this.documentElement = new FakeElement('html');
    this.themeButtons = ['dark', 'light'].map(theme => {
      const button = new FakeElement('button'); button.dataset.theme = theme; return button;
    });
    for (const id of [
      'today-date','current-time','work-status','timer-label','elapsed-time','punch-actions','rate-warning-home',
      'month-days','month-hours','month-pay','all-hours','home-breakdown','display-name','month-select','entry-form',
      'restore-file','entry-dialog','rates-list','rate-warning','add-rate','save-rates','toast'
    ]) {
      const tag = ['display-name','month-select','restore-file'].includes(id) ? 'input' : 'div';
      const element = new FakeElement(tag); element.id = id; this.elements.set(id, element);
    }
    this.elements.get('month-select').value = '2026-11';
    this.themeColor = new FakeElement('meta');
  }
  querySelector(selector) {
    if (selector === 'meta[name="theme-color"]') return this.themeColor;
    if (selector.startsWith('#')) return this.elements.get(selector.slice(1)) || null;
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.rate-item') return this.elements.get('rates-list').children;
    if (selector === '.theme-switch button') return this.themeButtons;
    return [];
  }
  createElement(tagName) { return new FakeElement(tagName); }
  addEventListener(type, handler, options = false) {
    const handlers = this.listeners.get(type) || [];
    handlers.push({ handler, capture: options === true || Boolean(options && options.capture) });
    this.listeners.set(type, handlers);
  }
  async dispatch(type, target) {
    const path = [];
    let current = target;
    while (current) { path.push(current); current = current.parentElement; }
    const event = { type, target, composedPath: () => [...path, this], preventDefault() {} };
    for (const entry of this.listeners.get(type) || []) if (entry.capture) await entry.handler(event);
    for (const node of path) for (const handler of node.listeners.get(type) || []) await handler(event);
    for (const entry of this.listeners.get(type) || []) if (!entry.capture) await entry.handler(event);
  }
  click(element) { return this.dispatch('click', element); }
  input(element) { return this.dispatch('input', element); }
}

function makeApp({ indexedDBEnabled = false, withDOM = false, values = new Map() } = {}) {
  const appPath = path.join(__dirname, '..', 'app.js');
  let source = fs.readFileSync(appPath, 'utf8');
  source = source.replace(/\n  init\(\)\.catch\(error => \{[\s\S]*?\n  \}\);\n\}\)\(\);\s*$/, `
  window.__test = {
    calculateRecord, aggregate, validateSchedule, buildReportText, formatDurationClock, transitionPunch, roundToNearestQuarter,
    bindEvents, renderHome, renderSettings,
    normalizeState, setState: value => { state = normalizeState(value); },
    getState: () => state, saveState, loadState, createCsv, formatHours
  };
})();`);
  assert.match(source, /window\.__test/, 'app bootstrap test hook was not installed');
  const document = withDOM ? new FakeDocument() : undefined;
  const dbValues = new Map();
  const stores = new Set();
  const fakeDB = {
    objectStoreNames: { contains: name => stores.has(name) },
    createObjectStore: name => stores.add(name),
    transaction() {
      const tx = {};
      tx.objectStore = () => ({
        get: key => {
          const request = {};
          queueMicrotask(() => { request.result = dbValues.get(key); request.onsuccess?.(); });
          return request;
        },
        put: (value, key) => queueMicrotask(() => { dbValues.set(key, value); tx.oncomplete?.(); })
      });
      return tx;
    }
  };
  const indexedDB = indexedDBEnabled ? {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = fakeDB;
        if (!stores.has('app-data')) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  } : undefined;
  const context = {
    window: { ...(indexedDB ? { indexedDB } : {}), confirm: () => true, scrollTo() {}, setInterval() {} },
    indexedDB,
    document,
    navigator: {},
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value))
    },
    console: { warn() {}, error: console.error },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON
  };
  vm.runInNewContext(source, context, { filename: appPath });
  return { api: context.window.__test, values, document };
}

const stamp = value => new Date(`2026-11-05T${value}:00+09:00`).getTime();
const midnightStamp = (day, value) => new Date(`2026-11-${day}T${value}:00+09:00`).getTime();
const datedStamp = (date, value) => new Date(`${date}T${value}:00+09:00`).getTime();

test('default hourly schedule covers 24 hours without overlap', () => {
  const { api } = makeApp();
  const result = api.validateSchedule(api.getState().rates);
  assert.equal(result.gaps, 0);
  assert.equal(result.overlaps, 0);
  assert.equal(result.message, '');
});

test('17:00 to 23:00 splits at 22:00 and calculates 7,400 yen', () => {
  const { api } = makeApp();
  const record = api.calculateRecord(stamp('17:00'), stamp('23:00'), [], api.getState().rates);
  assert.equal(record.totalMinutes, 360);
  assert.equal(record.amount, 7400);
  assert.deepEqual(JSON.parse(JSON.stringify(record.segments.map(segment => [segment.minutes, segment.rate]))), [[300, 1200], [60, 1400]]);
});

test('one minute is calculated at the minute-level rate before display rounding', () => {
  const { api } = makeApp();
  const record = api.calculateRecord(stamp('22:00'), stamp('22:01'), [], api.getState().rates);
  assert.equal(record.totalMinutes, 1);
  assert.equal(record.amount, 23.33);
});

test('break time is deducted minute by minute', () => {
  const { api } = makeApp();
  const record = api.calculateRecord(stamp('09:00'), stamp('17:00'), [{ start: stamp('12:00'), end: stamp('13:00') }], api.getState().rates);
  assert.equal(record.totalMinutes, 420);
  assert.equal(record.amount, 7700);
});

test('live timer subtracts an active break and displays seconds', () => {
  const { api } = makeApp();
  const start = stamp('09:00');
  const elapsed = api.formatDurationClock(start, stamp('12:30'), [{ start: stamp('10:00'), end: stamp('11:30') }]);
  assert.equal(elapsed, '02:00:00');
});

test('punch transitions record attendance, breaks and a single confirmed shift', () => {
  const { api } = makeApp();
  const rates = api.getState().rates;
  const start = api.transitionPunch(null, [], 'clock-in', stamp('17:00'), rates);
  assert.equal(start.current.start, stamp('17:00'));
  assert.equal(start.changed, true);
  const duplicate = api.transitionPunch(start.current, [], 'clock-in', stamp('17:05'), rates);
  assert.equal(duplicate.changed, false);
  const breakStart = api.transitionPunch(start.current, [], 'break-start', stamp('18:00'), rates);
  assert.equal(breakStart.current.breakStart, stamp('18:00'));
  const breakEnd = api.transitionPunch(breakStart.current, [], 'break-end', stamp('18:30'), rates);
  assert.equal(breakEnd.current.breaks.length, 1);
  const clockOut = api.transitionPunch(breakEnd.current, [], 'clock-out', stamp('20:00'), rates);
  assert.equal(clockOut.current, null);
  assert.equal(clockOut.records.length, 1);
  assert.equal(clockOut.records[0].totalMinutes, 150);
  assert.equal(clockOut.records[0].amount, 3000);
});

test('punch times round to the nearest 15 minutes, including the requested boundary cases', () => {
  const { api } = makeApp();
  const cases = [
    ['16:52', '17:00'], ['16:55', '17:00'], ['17:02', '17:00'],
    ['17:05', '17:00'], ['17:08', '17:15'], ['17:23', '17:15'], ['17:24', '17:30']
  ];
  for (const [pressed, expected] of cases) {
    const result = api.transitionPunch(null, [], 'clock-in', stamp(pressed), api.getState().rates);
    assert.equal(result.current.start, stamp(expected), `${pressed} should round to ${expected}`);
  }
});

test('clock-in, break start/end and clock-out all save rounded times and calculate from them', () => {
  const { api } = makeApp();
  const rates = api.getState().rates;
  const start = api.transitionPunch(null, [], 'clock-in', stamp('16:55'), rates);
  const breakStart = api.transitionPunch(start.current, [], 'break-start', stamp('18:08'), rates);
  const breakEnd = api.transitionPunch(breakStart.current, [], 'break-end', stamp('18:24'), rates);
  const clockOut = api.transitionPunch(breakEnd.current, [], 'clock-out', stamp('20:08'), rates);
  const [record] = clockOut.records;
  assert.equal(record.start, stamp('17:00'));
  assert.equal(record.breaks[0].start, stamp('18:15'));
  assert.equal(record.breaks[0].end, stamp('18:30'));
  assert.equal(record.end, stamp('20:15'));
  assert.equal(record.totalMinutes, 180);
  assert.equal(record.amount, 3600);
  assert.equal(api.buildReportText('ゆうた', [record], '2026-11'),
    'ゆうた\n11/5  17:00～18:15 1.25h\n      18:30～20:15 1.75h\n前3h 後0h');
});

test('rounded punch records remain correct across midnight', () => {
  const { api } = makeApp();
  const rates = api.getState().rates;
  const start = api.transitionPunch(null, [], 'clock-in', datedStamp('2026-11-05', '23:46'), rates);
  const clockOut = api.transitionPunch(start.current, [], 'clock-out', datedStamp('2026-11-06', '00:08'), rates);
  const [record] = clockOut.records;
  assert.equal(record.start, datedStamp('2026-11-05', '23:45'));
  assert.equal(record.end, datedStamp('2026-11-06', '00:15'));
  assert.equal(record.totalMinutes, 30);
  assert.equal(record.amount, 700);
});

test('bound punch buttons process clock-in, break and clock-out clicks', async () => {
  const { api, document, values } = makeApp({ withDOM: true });
  api.bindEvents();
  api.renderHome();
  const actions = document.querySelector('#punch-actions');
  await document.click(actions.children[0]);
  assert.equal(document.querySelector('#work-status').textContent, '勤務中');

  await document.click(actions.children[0]);
  assert.equal(document.querySelector('#work-status').textContent, '休憩中');
  let current = api.getState().current;
  api.setState({ ...api.getState(), current: { ...current, start: current.start - 120000, breakStart: current.start - 60000 } });
  api.renderHome();

  await document.click(actions.children[0]);
  assert.equal(document.querySelector('#work-status').textContent, '勤務中');
  assert.equal(api.getState().current.breaks.length, 1);
  await document.click(actions.children[1]);

  assert.equal(api.getState().current, null);
  assert.equal(api.getState().records.length, 1);
  const saved = JSON.parse(values.get('my-time-card'));
  assert.equal(saved.current, null);
  assert.equal(saved.records.length, 1);
});

test('settings buttons add, save and reload rate changes through real handlers', async () => {
  const { api, document, values } = makeApp({ withDOM: true });
  api.bindEvents();
  api.renderSettings();
  const ratesList = document.querySelector('#rates-list');
  await document.click(document.querySelector('#add-rate'));
  assert.equal(ratesList.children.length, 5);

  const eveningWage = ratesList.children[1].querySelector('.rate-price');
  eveningWage.value = '1250';
  await document.input(eveningWage);
  await document.click(document.querySelector('#save-rates'));

  const saved = JSON.parse(values.get('my-time-card'));
  assert.equal(saved.rates.length, 5);
  assert.equal(saved.rates[1].wage, 1250);
  const reloaded = makeApp({ values }).api;
  const restored = await reloaded.loadState();
  assert.equal(restored.rates.length, 5);
  assert.equal(restored.rates[1].wage, 1250);
});

test('clocking out during a break closes and deducts the open break', () => {
  const { api } = makeApp();
  const rates = api.getState().rates;
  const start = api.transitionPunch(null, [], 'clock-in', stamp('17:00'), rates);
  const onBreak = api.transitionPunch(start.current, [], 'break-start', stamp('17:30'), rates);
  const clockOut = api.transitionPunch(onBreak.current, [], 'clock-out', stamp('18:00'), rates);
  assert.equal(clockOut.records[0].totalMinutes, 30);
  assert.equal(clockOut.records[0].amount, 600);
});

test('overnight work uses the after-midnight rate band', () => {
  const { api } = makeApp();
  const record = api.calculateRecord(midnightStamp('05', '23:00'), midnightStamp('06', '01:00'), [], api.getState().rates);
  assert.equal(record.totalMinutes, 120);
  assert.equal(record.amount, 2800);
  assert.deepEqual(JSON.parse(JSON.stringify(record.segments.map(segment => segment.minutes))), [120]);
});

test('rate changes do not change a confirmed record snapshot', () => {
  const { api } = makeApp();
  const oldRates = api.getState().rates;
  const record = api.calculateRecord(stamp('17:00'), stamp('18:00'), [], oldRates);
  const newRates = oldRates.map(rate => rate.id === 'evening' ? { ...rate, wage: 1800 } : rate);
  const changed = api.calculateRecord(stamp('17:00'), stamp('18:00'), [], newRates);
  assert.equal(record.amount, 1200);
  assert.equal(changed.amount, 1800);
  assert.equal(record.ratesSnapshot.find(rate => rate.id === 'evening').wage, 1200);
});

test('schedule reports overlapping and unconfigured minutes', () => {
  const { api } = makeApp();
  const result = api.validateSchedule([
    { id: 'a', name: 'A', start: '09:00', end: '12:00', wage: 1000 },
    { id: 'b', name: 'B', start: '11:00', end: '13:00', wage: 1200 }
  ]);
  assert.equal(result.overlaps, 60);
  assert.equal(result.gaps, 1200);
  assert.match(result.message, /重複/);
  assert.match(result.message, /未設定/);
});

test('LINE report splits at 22:00 and totals before/after independently of rate names', () => {
  const { api } = makeApp();
  const renamedRates = [{ id: 'all', name: '任意の名前', start: '00:00', end: '00:00', wage: 1300 }];
  const record = api.calculateRecord(stamp('17:00'), stamp('23:00'), [], renamedRates);
  const report = api.buildReportText('あや', [record], '2026-11');
  assert.equal(report, 'あや\n11/5  17:00～22:00 5h\n      22:00～23:00 1h\n前5h 後1h');
});

test('LINE report aligns same-day shifts and omits the date from continuation rows', () => {
  const { api } = makeApp();
  const rates = api.getState().rates;
  const first = api.calculateRecord(stamp('11:00'), stamp('14:00'), [], rates);
  const second = api.calculateRecord(stamp('17:00'), stamp('20:00'), [], rates);
  const report = api.buildReportText('ゆうた', [first, second], '2026-11');
  assert.equal(report, 'ゆうた\n11/5  11:00～14:00 3h\n      17:00～20:00 3h\n前6h 後0h');
});

test('LINE report deducts breaks and divides multiple days at the exact 22:00 boundary', () => {
  const { api } = makeApp();
  const rates = [{ id: 'all', name: '変更可能な区分名', start: '00:00', end: '00:00', wage: 1000 }];
  const withBreak = api.calculateRecord(stamp('17:00'), stamp('23:00'), [{ start: stamp('19:00'), end: stamp('19:30') }], rates);
  const nextDay = api.calculateRecord(datedStamp('2026-11-06', '22:00'), datedStamp('2026-11-06', '23:00'), [], rates);
  const overnight = api.calculateRecord(datedStamp('2026-11-07', '23:00'), datedStamp('2026-11-08', '01:00'), [], rates);
  const report = api.buildReportText('ゆうた', [withBreak, nextDay, overnight], '2026-11');
  assert.equal(report,
    'ゆうた\n11/5  17:00～19:00 2h\n      19:30～22:00 2.5h\n      22:00～23:00 1h\n11/6  22:00～23:00 1h\n11/7  23:00～00:00 1h\n11/8  00:00～01:00 1h\n前5.5h 後3h');
});

test('LINE monthly totals reset and exclude other months', () => {
  const { api } = makeApp();
  const rates = api.getState().rates;
  const october = api.calculateRecord(datedStamp('2026-10-31', '17:00'), datedStamp('2026-10-31', '23:00'), [], rates);
  const november = api.calculateRecord(datedStamp('2026-11-01', '21:00'), datedStamp('2026-11-01', '23:00'), [], rates);
  const report = api.buildReportText('ゆうた', [october, november], '2026-11');
  assert.equal(report, 'ゆうた\n11/1  21:00～22:00 1h\n      22:00～23:00 1h\n前1h 後1h');
});

test('theme, name, rate and records persist and can be restored from JSON', async () => {
  const { api, values } = makeApp();
  const record = api.calculateRecord(stamp('17:00'), stamp('18:00'), [], api.getState().rates);
  const saved = { ...api.getState(), theme: 'light', name: 'あや', records: [record] };
  api.setState(saved);
  await api.saveState();
  assert.ok(values.has('my-time-card'));
  api.setState({ ...api.getState(), theme: 'dark', name: '仮', records: [] });
  const loaded = await api.loadState();
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.name, 'あや');
  assert.equal(loaded.records[0].amount, 1200);
  const restored = api.normalizeState(JSON.parse(JSON.stringify({ state: loaded })).state);
  assert.equal(restored.theme, 'light');
  assert.equal(restored.records.length, 1);
});

test('IndexedDB path persists state across reloads', async () => {
  const { api } = makeApp({ indexedDBEnabled: true });
  await api.loadState();
  const record = api.calculateRecord(stamp('17:00'), stamp('18:00'), [], api.getState().rates);
  api.setState({ ...api.getState(), theme: 'light', name: 'IndexedDB test', records: [record] });
  await api.saveState();
  api.setState({ ...api.getState(), theme: 'dark', name: 'temporary', records: [] });
  const loaded = await api.loadState();
  assert.equal(loaded.theme, 'light');
  assert.equal(loaded.name, 'IndexedDB test');
  assert.equal(loaded.records[0].amount, 1200);
});

test('CSV export escapes quotes and includes the confirmed total', () => {
  const { api } = makeApp();
  const record = api.calculateRecord(stamp('17:00'), stamp('18:00'), [], [{ id: 'x', name: '夕方, A "test"', start: '17:00', end: '22:00', wage: 1200 }]);
  const csv = api.createCsv([record]);
  assert.ok(csv.startsWith('\ufeff"出勤日時"'));
  assert.match(csv, /"夕方, A ""test"":1h:1200円"/);
});
