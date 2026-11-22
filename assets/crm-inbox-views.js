/* Inbox views and filters. Pure functions, also used by the tests.
   Saved-view seeds stay in the browser. Nothing here writes to the database. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaInboxViews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VIEWS = [
    { id: 'newest', label: 'Newest' },
    { id: 'event', label: 'By event' },
    { id: 'needs', label: 'Needs reply' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'mine', label: 'Mine' }
  ];
  var STAGES = ['enquired', 'interested', 'enrolled', 'paid', 'attended'];
  var GROUP_STAGES = ['enquired', 'interested', 'enrolled', 'paid'];
  var CATEGORIES = ['kids', 'adults', 'baking', 'corporate'];
  var SOURCES = [
    { id: 'ad', label: 'Meta ad' },
    { id: 'instagram', label: 'Instagram' },
    { id: 'website', label: 'Website' },
    { id: 'referral', label: 'Referral' },
    { id: 'ref', label: 'wa.me ref code' }
  ];
  var SCORE_BANDS = [
    { id: 'low', label: 'Score under 30' },
    { id: 'mid', label: 'Score 30–59' },
    { id: 'high', label: 'Score 60+' }
  ];
  var SPEND_BANDS = [
    { id: 'none', label: 'No spend yet' },
    { id: 'under500', label: 'Spend under RM500' },
    { id: 'over500', label: 'Spend RM500 or more' }
  ];

  function emptyFilters() {
    return {
      channels: [], sessionId: '', categories: [], stages: [], statuses: [],
      assignee: '', unassigned: false, unread: false, tags: [], sources: [], adName: '',
      customer: '', scoreBand: '', spendBand: '', waWindow: '', receivedFrom: '', receivedTo: '',
      weekendSessions: false
    };
  }

  function klDate(value) {
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kuala_Lumpur', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(d);
  }

  function klWeekday(value) {
    var d = value instanceof Date ? value : new Date(value);
    var parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short' }).formatToParts(d);
    var hit = parts.filter(function (p) { return p.type === 'weekday'; })[0];
    return hit ? hit.value : '';
  }

  function shiftDate(ymd, days) {
    var p = ymd.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function weekRange(now) {
    var today = klDate(now);
    var names = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    var wd = names[klWeekday(now)];
    if (wd == null) wd = 0;
    return { from: shiftDate(today, -wd), to: shiftDate(today, 6 - wd) };
  }

  function weekendDates(now) {
    var week = weekRange(now);
    return { sat: shiftDate(week.from, 5), sun: shiftDate(week.from, 6) };
  }

  function seedViews(now) {
    var week = weekRange(now || new Date());
    return [
      {
        id: 'seed-kids-ads',
        name: 'Kids enquiries from ads this week',
        seed: true,
        shared: false,
        definition: {
          view: 'event',
          filters: Object.assign(emptyFilters(), {
            categories: ['kids'], stages: ['enquired'], sources: ['ad'],
            receivedFrom: week.from, receivedTo: week.to
          })
        }
      },
      {
        id: 'seed-unpaid-weekend',
        name: 'Unpaid this weekend',
        seed: true,
        shared: false,
        definition: {
          view: 'event',
          filters: Object.assign(emptyFilters(), {
            stages: ['enquired', 'interested', 'enrolled'],
            weekendSessions: true
          })
        }
      }
    ];
  }

  function hasList(list) { return Array.isArray(list) && list.length > 0; }

  function includes(list, value) {
    return (list || []).some(function (item) { return String(item).toLowerCase() === String(value || '').toLowerCase(); });
  }

  function windowState(row, now) {
    if (!row || row.channel !== 'whatsapp') return { applies: false, open: false, msLeft: 0, closing: false };
    if (!row.last_inbound_at) return { applies: true, open: false, msLeft: 0, closing: false };
    var ms = new Date(row.last_inbound_at).getTime() + 24 * 60 * 60 * 1000 - now.getTime();
    return { applies: true, open: ms > 0, msLeft: Math.max(0, ms), closing: ms > 0 && ms <= 4 * 60 * 60 * 1000 };
  }

  function waitingLabel(iso, now) {
    if (!iso) return '';
    var mins = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return mins + 'm';
    var hours = Math.floor(mins / 60);
    if (hours < 48) return hours + 'h';
    return Math.floor(hours / 24) + 'd';
  }

  function scoreOf(row) {
    if (row.score != null && row.score !== '') return Number(row.score);
    if (row.lead_score != null) return Number(row.lead_score);
    return null;
  }

  function spendOf(row) {
    if (row.lifetime_spend_rm == null || row.lifetime_spend_rm === '') return null;
    return Number(row.lifetime_spend_rm);
  }

  function sourceHit(row, id, filters) {
    var kind = row.entry_kind || '';
    var channel = row.channel || '';
    if (id === 'ad') {
      var ad = kind === 'ad' || !!(row.ctwa_clid || row.meta_ad_id || row.source_id);
      if (!ad) return false;
      if (filters.adName) {
        var hay = [row.headline, row.entry_label, row.campaign_name, row.ad_name].join(' ').toLowerCase();
        return hay.indexOf(String(filters.adName).toLowerCase()) !== -1;
      }
      return true;
    }
    if (id === 'instagram') return channel === 'instagram' || kind === 'instagram';
    if (id === 'website') return channel === 'website';
    if (id === 'referral') return kind === 'referral' || kind === 'ref';
    if (id === 'ref') return !!row.ref_code;
    return false;
  }

  function categoryHit(row, category) {
    var bag = [row.category, row.format, row.session_title, row.sessionTitle].concat(row.tags || []).join(' ').toLowerCase();
    if (category === 'kids') return /kid|child|children/.test(bag);
    if (category === 'adults') return /adult/.test(bag);
    if (category === 'baking') return /bak/.test(bag);
    if (category === 'corporate') return /corporate|company|team/.test(bag);
    return bag.indexOf(category) !== -1;
  }

  function passes(row, filters, now) {
    var f = filters || emptyFilters();
    if (hasList(f.channels) && !includes(f.channels, row.channel)) return false;
    if (f.sessionId && row.session_id !== f.sessionId) return false;
    if (hasList(f.categories) && !f.categories.some(function (c) { return categoryHit(row, c); })) return false;
    if (hasList(f.stages) && !includes(f.stages, row.stage)) return false;
    if (hasList(f.statuses) && !includes(f.statuses, row.status)) return false;
    if (f.unassigned && row.assigned_to) return false;
    if (f.assignee && row.assigned_to !== f.assignee) return false;
    if (f.unread && !(Number(row.unread_count) > 0)) return false;
    if (hasList(f.tags) && !f.tags.some(function (tag) { return includes(row.tags || [], tag); })) return false;
    if (hasList(f.sources) && !f.sources.some(function (src) { return sourceHit(row, src, f); })) return false;
    else if (f.adName && !sourceHit(row, 'ad', f)) return false;
    if (f.customer === 'new' && Number(row.bookings_count || 0) > 0) return false;
    if (f.customer === 'returning' && !(Number(row.bookings_count || 0) > 0)) return false;
    var score = scoreOf(row);
    if (f.scoreBand === 'low' && !(score != null && score < 30)) return false;
    if (f.scoreBand === 'mid' && !(score != null && score >= 30 && score < 60)) return false;
    if (f.scoreBand === 'high' && !(score != null && score >= 60)) return false;
    var spend = spendOf(row);
    if (f.spendBand === 'none' && !(spend == null || spend === 0)) return false;
    if (f.spendBand === 'under500' && !(spend != null && spend > 0 && spend < 500)) return false;
    if (f.spendBand === 'over500' && !(spend != null && spend >= 500)) return false;
    var win = windowState(row, now);
    if (f.waWindow === 'open' && !win.open) return false;
    if (f.waWindow === 'closed' && !(win.applies && !win.open)) return false;
    var received = klDate(row.last_message_at || row.last_inbound_at || '');
    if (f.receivedFrom && (!received || received < f.receivedFrom)) return false;
    if (f.receivedTo && (!received || received > f.receivedTo)) return false;
    if (f.weekendSessions) {
      var when = klDate(row.starts_at || row.session_date || '');
      var end = weekendDates(now);
      if (when !== end.sat && when !== end.sun) return false;
    }
    return true;
  }

  function byTime(a, b, key, dir) {
    var av = new Date(a[key] || 0).getTime();
    var bv = new Date(b[key] || 0).getTime();
    return dir === 'asc' ? av - bv : bv - av;
  }

  function seatsLeft(session, rows) {
    if (!session || session.capacity == null) return null;
    var taken = (rows || []).filter(function (row) {
      return row.session_id === session.id && ['enrolled', 'paid', 'attended'].indexOf(row.stage) !== -1;
    }).length;
    return Math.max(0, Number(session.capacity) - taken);
  }

  function eventTitle(session, left) {
    var when = session.starts_at || session.session_date;
    var date = when ? new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short'
    }).format(new Date(when)) : 'Date to be set';
    var seats = left == null ? '' : ' · ' + left + ' seat' + (left === 1 ? '' : 's') + ' left';
    return date + ' · ' + (session.title || session.id) + seats;
  }

  function arrange(rows, state, sessions, now) {
    var view = (state && state.view) || 'newest';
    var filters = (state && state.filters) || emptyFilters();
    var meId = state && state.meId;
    var matched = (rows || []).filter(function (row) { return passes(row, filters, now); });
    if (view === 'mine') matched = matched.filter(function (row) { return row.assigned_to && row.assigned_to === meId; });
    if (view === 'needs') {
      matched = matched.filter(function (row) { return row.last_direction === 'in' && row.status !== 'closed'; });
      matched.sort(function (a, b) {
        var aw = windowState(a, now).closing ? 0 : 1;
        var bw = windowState(b, now).closing ? 0 : 1;
        if (aw !== bw) return aw - bw;
        if (aw === 0) return windowState(a, now).msLeft - windowState(b, now).msLeft;
        return byTime(a, b, 'last_inbound_at', 'asc');
      });
      return { view: view, rows: matched };
    }
    if (view === 'event') {
      var linked = {};
      matched.forEach(function (row) {
        var key = row.session_id || '';
        if (!linked[key]) linked[key] = [];
        linked[key].push(row);
      });
      var groups = (sessions || []).filter(function (session) { return linked[session.id]; }).map(function (session) {
        var people = linked[session.id] || [];
        var past = session.starts_at ? new Date(session.starts_at).getTime() < now.getTime() : false;
        return {
          id: session.id,
          title: eventTitle(session, seatsLeft(session, matched)),
          past: past,
          sections: GROUP_STAGES.map(function (stage) {
            return { stage: stage, rows: people.filter(function (row) { return row.stage === stage; }) };
          }).filter(function (section) { return section.rows.length; })
        };
      }).sort(function (a, b) {
        var as = (sessions.find(function (s) { return s.id === a.id; }) || {}).starts_at || '';
        var bs = (sessions.find(function (s) { return s.id === b.id; }) || {}).starts_at || '';
        return String(as).localeCompare(String(bs));
      });
      Object.keys(linked).filter(function (id) {
        return id && !(sessions || []).some(function (session) { return session.id === id; });
      }).forEach(function (id) {
        var people = linked[id];
        groups.push({
          id: id,
          title: eventTitle({ id: id, title: people[0].session_title || id, starts_at: people[0].starts_at, capacity: null }, null),
          past: people[0].starts_at ? new Date(people[0].starts_at).getTime() < now.getTime() : false,
          sections: GROUP_STAGES.map(function (stage) {
            return { stage: stage, rows: people.filter(function (row) { return row.stage === stage; }) };
          }).filter(function (section) { return section.rows.length; })
        });
      });
      var loose = linked[''] || [];
      if (loose.length) {
        groups.push({
          id: '',
          title: 'No event linked',
          past: false,
          sections: [{ stage: '', rows: loose }]
        });
      }
      return { view: view, groups: groups, rows: matched };
    }
    if (view === 'pipeline') {
      var columns = STAGES.map(function (stage) {
        return { stage: stage, rows: matched.filter(function (row) { return row.stage === stage; }) };
      });
      var none = matched.filter(function (row) { return STAGES.indexOf(row.stage) === -1; });
      if (none.length) columns.push({ stage: '', label: 'No event', rows: none });
      return { view: view, columns: columns, rows: matched };
    }
    matched.sort(function (a, b) { return byTime(a, b, 'last_message_at', 'desc'); });
    return { view: view, rows: matched };
  }

  function chips(filters) {
    var f = filters || emptyFilters();
    var out = [];
    function add(id, label) { if (label) out.push({ id: id, label: label }); }
    (f.channels || []).forEach(function (c) { add('channel:' + c, c); });
    if (f.sessionId) add('session', f.sessionId);
    (f.categories || []).forEach(function (c) { add('category:' + c, c); });
    (f.stages || []).forEach(function (c) { add('stage:' + c, c); });
    (f.statuses || []).forEach(function (c) { add('status:' + c, c); });
    if (f.unassigned) add('unassigned', 'Unassigned');
    if (f.assignee) add('assignee', 'Assignee');
    if (f.unread) add('unread', 'Unread');
    (f.tags || []).forEach(function (c) { add('tag:' + c, c); });
    (f.sources || []).forEach(function (c) {
      var known = SOURCES.filter(function (s) { return s.id === c; })[0];
      add('source:' + c, known ? known.label : c);
    });
    if (f.adName) add('adName', 'Ad: ' + f.adName);
    if (f.customer) add('customer', f.customer === 'new' ? 'New' : 'Returning');
    if (f.scoreBand) add('score', (SCORE_BANDS.filter(function (b) { return b.id === f.scoreBand; })[0] || {}).label || f.scoreBand);
    if (f.spendBand) add('spend', (SPEND_BANDS.filter(function (b) { return b.id === f.spendBand; })[0] || {}).label || f.spendBand);
    if (f.waWindow) add('window', f.waWindow === 'open' ? 'Window open' : 'Window closed');
    if (f.receivedFrom || f.receivedTo) add('received', (f.receivedFrom || '…') + ' – ' + (f.receivedTo || '…'));
    if (f.weekendSessions) add('weekend', 'This weekend');
    return out;
  }

  function dropChip(filters, id) {
    var next = Object.assign(emptyFilters(), filters || {});
    next.channels = (next.channels || []).slice();
    next.categories = (next.categories || []).slice();
    next.stages = (next.stages || []).slice();
    next.statuses = (next.statuses || []).slice();
    next.tags = (next.tags || []).slice();
    next.sources = (next.sources || []).slice();
    var pair = String(id).split(':');
    var key = pair[0];
    var value = pair.slice(1).join(':');
    if (key === 'channel') next.channels = next.channels.filter(function (c) { return c !== value; });
    else if (key === 'category') next.categories = next.categories.filter(function (c) { return c !== value; });
    else if (key === 'stage') next.stages = next.stages.filter(function (c) { return c !== value; });
    else if (key === 'status') next.statuses = next.statuses.filter(function (c) { return c !== value; });
    else if (key === 'tag') next.tags = next.tags.filter(function (c) { return c !== value; });
    else if (key === 'source') next.sources = next.sources.filter(function (c) { return c !== value; });
    else if (key === 'session') next.sessionId = '';
    else if (key === 'unassigned') next.unassigned = false;
    else if (key === 'assignee') next.assignee = '';
    else if (key === 'unread') next.unread = false;
    else if (key === 'adName') next.adName = '';
    else if (key === 'customer') next.customer = '';
    else if (key === 'score') next.scoreBand = '';
    else if (key === 'spend') next.spendBand = '';
    else if (key === 'window') next.waWindow = '';
    else if (key === 'received') { next.receivedFrom = ''; next.receivedTo = ''; }
    else if (key === 'weekend') next.weekendSessions = false;
    return next;
  }

  function readState(search) {
    var q = new URLSearchParams(search || '');
    var filters = emptyFilters();
    function list(key) {
      var raw = q.get(key);
      return raw ? raw.split(',').filter(Boolean) : [];
    }
    filters.channels = list('ivch');
    filters.sessionId = q.get('ivses') || '';
    filters.categories = list('ivcat');
    filters.stages = list('ivst');
    filters.statuses = list('ivstat');
    filters.assignee = q.get('ivwho') || '';
    filters.unassigned = q.get('ivun') === '1';
    filters.unread = q.get('ivur') === '1';
    filters.tags = list('ivtag');
    filters.sources = list('ivsrc');
    filters.adName = q.get('ivad') || '';
    filters.customer = q.get('ivcus') || '';
    filters.scoreBand = q.get('ivsc') || '';
    filters.spendBand = q.get('ivsp') || '';
    filters.waWindow = q.get('ivwin') || '';
    filters.receivedFrom = q.get('ivfrom') || '';
    filters.receivedTo = q.get('ivto') || '';
    filters.weekendSessions = q.get('ivwe') === '1';
    return { view: q.get('iv') || 'newest', saved: q.get('ivs') || '', filters: filters };
  }

  function writeState(current, search) {
    var q = new URLSearchParams(search || '');
    ['iv', 'ivs', 'ivch', 'ivses', 'ivcat', 'ivst', 'ivstat', 'ivwho', 'ivun', 'ivur', 'ivtag', 'ivsrc', 'ivad', 'ivcus', 'ivsc', 'ivsp', 'ivwin', 'ivfrom', 'ivto', 'ivwe'].forEach(function (key) {
      q.delete(key);
    });
    var state = current || {};
    var f = state.filters || emptyFilters();
    if (state.view && state.view !== 'newest') q.set('iv', state.view);
    if (state.saved) q.set('ivs', state.saved);
    function put(key, list) { if (list && list.length) q.set(key, list.join(',')); }
    put('ivch', f.channels);
    if (f.sessionId) q.set('ivses', f.sessionId);
    put('ivcat', f.categories);
    put('ivst', f.stages);
    put('ivstat', f.statuses);
    if (f.assignee) q.set('ivwho', f.assignee);
    if (f.unassigned) q.set('ivun', '1');
    if (f.unread) q.set('ivur', '1');
    put('ivtag', f.tags);
    put('ivsrc', f.sources);
    if (f.adName) q.set('ivad', f.adName);
    if (f.customer) q.set('ivcus', f.customer);
    if (f.scoreBand) q.set('ivsc', f.scoreBand);
    if (f.spendBand) q.set('ivsp', f.spendBand);
    if (f.waWindow) q.set('ivwin', f.waWindow);
    if (f.receivedFrom) q.set('ivfrom', f.receivedFrom);
    if (f.receivedTo) q.set('ivto', f.receivedTo);
    if (f.weekendSessions) q.set('ivwe', '1');
    var text = q.toString();
    return text ? '?' + text : locationPath(search);
  }

  function locationPath() { return ''; }

  function pickAssignee(rules, duty, lastId, input) {
    var on = {};
    (duty || []).forEach(function (row) { if (row.on_duty !== false && row.onDuty !== false) on[row.staff_id || row.staffId] = true; });
    var category = (input && input.category || '').toLowerCase();
    var source = (input && input.source || '').toLowerCase();
    var match = (rules || []).filter(function (rule) {
      var id = rule.staff_id || rule.staffId;
      if (!on[id]) return false;
      if (rule.kind === 'category' && String(rule.match || '').toLowerCase() === category) return true;
      if (rule.kind === 'source' && String(rule.match || '').toLowerCase() === source) return true;
      return false;
    })[0];
    if (match) return match.staff_id || match.staffId;
    var pool = Object.keys(on).sort();
    if (!pool.length) return null;
    var index = pool.indexOf(lastId);
    return pool[(index + 1) % pool.length];
  }

  return {
    VIEWS: VIEWS,
    STAGES: STAGES,
    GROUP_STAGES: GROUP_STAGES,
    CATEGORIES: CATEGORIES,
    SOURCES: SOURCES,
    SCORE_BANDS: SCORE_BANDS,
    SPEND_BANDS: SPEND_BANDS,
    emptyFilters: emptyFilters,
    seedViews: seedViews,
    weekRange: weekRange,
    windowState: windowState,
    waitingLabel: waitingLabel,
    passes: passes,
    arrange: arrange,
    chips: chips,
    dropChip: dropChip,
    seatsLeft: seatsLeft,
    eventTitle: eventTitle,
    readState: readState,
    writeState: writeState,
    klDate: klDate,
    pickAssignee: pickAssignee
  };
});
