/* CRM list views, record frame, and the marketing-email screens.
   Loaded only by admin.html. The public site does not use this file.
   Lead score, send rules, and list matching stay in this file so tests can
   run them without a browser. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaGrowth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var REASON = {
    ad_click: 'Ad click',
    replied: 'Replied',
    asked_price: 'Asked about price',
    booked: 'Booked before',
    opened_link: 'Opened a link',
    recent: 'Recent'
  };

  function leadScore(input) {
    var reasons = [];
    var points = 0;
    var src = input || {};
    if (src.adClick) { points += 10; reasons.push('ad_click'); }
    if (src.replied) { points += 15; reasons.push('replied'); }
    if (src.askedPrice) { points += 10; reasons.push('asked_price'); }
    if (src.booked) { points += 25; reasons.push('booked'); }
    if (src.openedLink) { points += 5; reasons.push('opened_link'); }
    if (src.recencyDays != null && src.recencyDays <= 45) {
      points += src.recencyDays <= 14 ? 10 : 5;
      reasons.push('recent');
    }
    return { points: points, reasons: reasons };
  }

  function reasonText(codes) {
    return (codes || []).map(function (c) { return REASON[c] || c; }).join(', ');
  }

  function emailSendable(contact, suppressed) {
    var c = contact || {};
    if (!c.email) return 'no email';
    if (!c.email_consent) return 'no consent';
    if (c.unsubscribed) return 'unsubscribed';
    if (c.do_not_contact) return 'do not contact';
    if (suppressed) return 'suppressed';
    return null;
  }

  function segmentMatch(contact, clauses) {
    return (clauses || []).every(function (clause) {
      var c = contact || {};
      var val = clause.value;
      if (clause.field === 'whatsapp_opt_in') return !!(c.whatsapp_consent && !c.unsubscribed && !c.do_not_contact);
      if (clause.field === 'email_opt_in') return !!(c.email_consent && !c.unsubscribed && !c.do_not_contact);
      if (clause.field === 'has_child') return !!(c.has_child || (c.children && c.children.length));
      if (clause.field === 'formats_attended') return (c.formats_attended || []).indexOf(val) !== -1;
      if (clause.field === 'interests') return (c.interests || []).indexOf(val) !== -1;
      if (clause.field === 'tags') return (c.tags || []).indexOf(val) !== -1;
      if (clause.field === 'days_since_last_booking') {
        return c.days_since_last_booking != null && Number(c.days_since_last_booking) >= Number(val);
      }
      if (clause.field === 'lifecycle_stage') return c.lifecycle_stage === val;
      if (clause.field === 'contact_type') return c.contact_type === val;
      if (clause.field === 'is_organiser') return !!c.is_organiser;
      if (clause.field === 'birthday_enquiry') return !!c.birthday_enquiry;
      if (clause.field === 'asked_price') return !!c.asked_price;
      return false;
    });
  }

  function pill(text, tone) {
    if (text == null || text === '') return '';
    return '<span class="ix-pill ' + esc(tone || '') + '">' + esc(text) + '</span>';
  }

  function sortValue(row, key) {
    if (row.sort && row.sort[key] != null && row.sort[key] !== '') return row.sort[key];
    if (row.cells && row.cells[key] != null) return row.cells[key];
    return '';
  }

  function sortRows(rows, key, dir) {
    var m = dir === 'desc' ? -1 : 1;
    return (rows || []).slice().sort(function (a, b) {
      var av = sortValue(a, key);
      var bv = sortValue(b, key);
      var an = Number(av);
      var bn = Number(bv);
      if (av !== '' && bv !== '' && !isNaN(an) && !isNaN(bn) && String(av).match(/^-?\d+(\.\d+)?$/)) {
        return (an - bn) * m;
      }
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * m;
    });
  }

  function pageWindow(total, page, size) {
    var n = Math.max(0, total || 0);
    var take = size > 0 ? size : 25;
    var pages = Math.max(1, Math.ceil(n / take));
    var p = Math.min(Math.max(0, page || 0), pages - 1);
    return {
      page: p,
      pages: pages,
      from: n ? p * take + 1 : 0,
      to: Math.min(n, (p + 1) * take),
      start: p * take,
      end: (p + 1) * take
    };
  }

  function taskBucket(due, today) {
    if (!due) return 'upcoming';
    if (due < today) return 'overdue';
    if (due === today) return 'today';
    return 'upcoming';
  }

  function taskPriority(due, today) {
    var bucket = taskBucket(due, today);
    if (bucket === 'overdue') return { label: 'High', tone: 'bad' };
    if (bucket === 'today') return { label: 'Medium', tone: 'warn' };
    return { label: 'Low', tone: 'muted' };
  }

  function cellHtml(row, key) {
    if (row.html && row.html[key] != null) return row.html[key];
    var value = row.cells ? row.cells[key] : '';
    return esc(value == null ? '' : value);
  }

  function indexHtml(o) {
    var opt = o || {};
    var scope = opt.scope || 'list';
    var columns = opt.columns || [];
    var sorted = opt.sort && opt.sort.key ? sortRows(opt.rows || [], opt.sort.key, opt.sort.dir) : (opt.rows || []).slice();
    var win = pageWindow(sorted.length, opt.page, opt.pageSize || 25);
    var pageRows = sorted.slice(win.start, win.end);
    var pick = opt.selectable !== false;
    var selected = opt.selected || {};
    var selectedCount = pageRows.filter(function (r) { return selected[r.id]; }).length;
    var allOnPage = pageRows.length > 0 && selectedCount === pageRows.length;
    var tabs = (opt.tabs || []).map(function (tab) {
      return '<button type="button" class="ix-tab' + (tab.id === opt.tab ? ' on' : '') + '" onclick="ixTab(\'' + esc(scope) + '\',\'' + esc(tab.id) + '\')">' + esc(tab.label) + '</button>';
    }).join('');
    var chips = (opt.chips || []).map(function (chip) {
      return '<button type="button" class="ix-chip" onclick="ixChip(\'' + esc(scope) + '\',\'' + esc(chip.id) + '\')">' + esc(chip.label) + ' <span aria-hidden="true">×</span></button>';
    }).join('');
    var filters = (opt.filters || []).map(function (f) {
      if (f.type === 'check') {
        return '<label class="ix-check"><input type="checkbox" ' + (f.value ? 'checked' : '') + ' onchange="ixFilter(\'' + esc(scope) + '\',\'' + esc(f.key) + '\',this.checked)"> ' + esc(f.label) + '</label>';
      }
      var options = (f.options || []).map(function (item) {
        var value = typeof item === 'object' ? item.value : item;
        var label = typeof item === 'object' ? item.label : (item || 'Any');
        return '<option value="' + esc(value) + '"' + (String(value) === String(f.value || '') ? ' selected' : '') + '>' + esc(label) + '</option>';
      }).join('');
      return '<label class="ix-field">' + esc(f.label) + '<select onchange="ixFilter(\'' + esc(scope) + '\',\'' + esc(f.key) + '\',this.value)"><option value="">Any</option>' + options + '</select></label>';
    }).join('');
    var chooser = (opt.allColumns || []).map(function (col) {
      var on = columns.some(function (c) { return c.key === col.key; });
      return '<label class="ix-check"><input type="checkbox" ' + (on ? 'checked' : '') + ' onchange="ixCol(\'' + esc(scope) + '\',\'' + esc(col.key) + '\',this.checked)"> ' + esc(col.label) + '</label>';
    }).join('');
    var head = (pick ? '<th class="ix-checkcol ix-sticky"><input type="checkbox" aria-label="Select rows on this page" ' + (allOnPage ? 'checked' : '') + ' onchange="ixPagePick(\'' + esc(scope) + '\',this.checked)"></th>' : '')
      + columns.map(function (col, i) {
        var arrow = opt.sort && opt.sort.key === col.key ? (opt.sort.dir === 'desc' ? ' ↓' : ' ↑') : '';
        return '<th class="' + (pick && i === 0 ? 'ix-sticky' : '') + '"><button type="button" class="ix-sort" onclick="ixSort(\'' + esc(scope) + '\',\'' + esc(col.key) + '\')">' + esc(col.label) + arrow + '</button></th>';
      }).join('');
    var body = pageRows.map(function (row) {
      var on = selected[row.id] ? ' on' : '';
      return '<tr class="ix-row' + on + '" onclick="ixPreview(\'' + esc(scope) + '\',\'' + esc(row.id) + '\')">'
        + (pick ? '<td class="ix-checkcol ix-sticky" onclick="event.stopPropagation()"><input type="checkbox" aria-label="Select row" ' + (selected[row.id] ? 'checked' : '') + ' onchange="ixPick(\'' + esc(scope) + '\',\'' + esc(row.id) + '\',this.checked)"></td>' : '')
        + columns.map(function (col, i) {
          return '<td class="' + (pick && i === 0 ? 'ix-sticky' : '') + '">' + cellHtml(row, col.key) + '</td>';
        }).join('') + '</tr>';
    }).join('');
    if (!pageRows.length) {
      body = '<tr><td class="ix-empty" colspan="' + (columns.length + (pick ? 1 : 0)) + '">' + esc(opt.empty || 'No records in this view.') + '</td></tr>';
    }
    var bulkCount = Object.keys(selected).filter(function (id) { return selected[id]; }).length;
    var bulk = '';
    if (bulkCount && opt.bulk && opt.bulk.length) {
      bulk = '<div class="ix-bulk"><b>' + bulkCount + ' selected</b>'
        + (opt.bulkExtra || '')
        + opt.bulk.map(function (action) {
          return '<button type="button" class="ix-btn" onclick="ixBulk(\'' + esc(scope) + '\',\'' + esc(action.id) + '\')">' + esc(action.label) + '</button>';
        }).join('') + '</div>';
    }
    var toggle = '';
    if (opt.modes && opt.modes.length) {
      toggle = '<div class="ix-modes">' + opt.modes.map(function (mode) {
        return '<button type="button" class="ix-btn' + (mode.id === opt.mode ? ' on' : '') + '" onclick="ixMode(\'' + esc(scope) + '\',\'' + esc(mode.id) + '\')">' + esc(mode.label) + '</button>';
      }).join('') + '</div>';
    }
    var mobile = '<div class="ix-mlist">' + (pageRows.length ? pageRows.map(function (row) {
      var nameKey = (columns[0] && columns[0].key) || '';
      var name = esc(row.cells && row.cells[nameKey] != null ? row.cells[nameKey] : '');
      var pill = row.mobilePill || '';
      if (!pill && row.html) {
        ['lifecycle', 'stage', 'status', 'priority'].some(function (key) {
          if (row.html[key]) { pill = row.html[key]; return true; }
          return false;
        });
      }
      var sub = row.mobileSub != null ? esc(row.mobileSub) : '';
      if (!sub) {
        var subKey = columns.slice(1).map(function (col) { return col.key; }).filter(function (key) {
          return ['lifecycle', 'stage', 'status', 'priority'].indexOf(key) === -1;
        })[0];
        sub = subKey ? cellHtml(row, subKey) : '';
      }
      return '<button type="button" class="ix-mrow' + (selected[row.id] ? ' on' : '') + '" onclick="ixPreview(\'' + esc(scope) + '\',\'' + esc(row.id) + '\')"><span class="ix-mname">' + name + '</span>' + (pill ? '<span class="ix-mpill">' + pill + '</span>' : '') + (sub ? '<small class="ix-msub">' + sub + '</small>' : '') + '</button>';
    }).join('') : '<p class="ix-empty">' + esc(opt.empty || 'No records in this view.') + '</p>') + '</div>';
    var sorts = '<div class="ix-sorts"><p class="ix-kicker">Sort</p>' + columns.map(function (col) {
      return '<button type="button" class="ix-btn" onclick="ixSort(\'' + esc(scope) + '\',\'' + esc(col.key) + '\')">' + esc(col.label) + '</button>';
    }).join('') + '</div>';
    var table = opt.board
      ? opt.board
      : '<div class="ix-scroll"><table class="ix-table"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>' + mobile;
    var preview = '';
    if (opt.preview) {
      var lines = (opt.preview.lines || []).map(function (line) {
        return '<div class="ix-pv-row"><span>' + esc(line[0]) + '</span><b>' + esc(line[1] || '—') + '</b></div>';
      }).join('');
      preview = '<aside class="ix-preview"><div class="ix-pv-h"><b>' + esc(opt.preview.title || 'Record') + '</b><button type="button" class="ix-btn" onclick="ixPreview(\'' + esc(scope) + '\',\'\')">Close</button></div>'
        + lines
        + (opt.preview.action ? '<p><button type="button" class="ix-btn primary" onclick="' + opt.preview.action + '">' + esc(opt.preview.actionLabel || 'Open record') + '</button></p>' : '')
        + '</aside>';
    }
    return '<div class="ix">'
      + (tabs ? '<div class="ix-tabs" role="tablist">' + tabs + '</div>' : '')
      + '<div class="ix-tools">'
      + '<input class="ix-search" type="search" placeholder="' + esc(opt.placeholder || 'Search') + '" value="' + esc(opt.query || '') + '" oninput="ixSearch(\'' + esc(scope) + '\',this.value)">'
      + toggle
      + '<button type="button" class="ix-btn ix-filter-btn" onclick="ixSheet(true)">Sort and filter</button>'
      + (chooser ? '<details class="ix-cols"><summary>Edit columns</summary>' + chooser + '</details>' : '')
      + '<span class="ix-count">' + (sorted.length ? (win.from + '–' + win.to + ' of ' + sorted.length) : '0') + '</span>'
      + '</div>'
      + (opt.note ? '<p class="ix-note">' + opt.note + '</p>' : '')
      + (chips ? '<div class="ix-chips">' + chips + '</div>' : '')
      + (opt.tools || '')
      + bulk
      + '<div class="ix-sheet" hidden><div class="ix-sheet-card"><div class="ix-sheet-bar"><b>Sort and filter</b><button type="button" class="ix-btn" onclick="ixSheet(false)">Done</button></div>' + sorts + (filters ? '<div class="ix-sheet-filters"><p class="ix-kicker">Filters</p>' + filters + '</div>' : '') + '</div></div>'
      + '<div class="ix-body">'
      + (filters ? '<aside class="ix-side"><p class="ix-kicker">Filters</p>' + filters + '</aside>' : '')
      + table
      + preview
      + '</div>'
      + '<div class="ix-pager"><button type="button" class="ix-btn" ' + (win.page <= 0 ? 'disabled' : '') + ' onclick="ixPage(\'' + esc(scope) + '\',' + (win.page - 1) + ')">Previous</button><span>Page ' + (win.page + 1) + ' of ' + win.pages + '</span><button type="button" class="ix-btn" ' + (win.page + 1 >= win.pages ? 'disabled' : '') + ' onclick="ixPage(\'' + esc(scope) + '\',' + (win.page + 1) + ')">Next</button></div>'
      + '</div>';
  }

  function recordFrame(parts) {
    var p = parts || {};
    return '<div class="rec-page"><div class="rec-top">' + (p.top || '') + '</div><div class="rec">'
      + '<section class="rec-col rec-l"><p class="rec-kicker">About</p>' + (p.left || '') + '</section>'
      + '<section class="rec-col rec-m"><p class="rec-kicker">Timeline</p>' + (p.middle || '') + '</section>'
      + '<section class="rec-col rec-r"><p class="rec-kicker">Associations</p>' + (p.right || '') + '</section>'
      + '</div></div>';
  }

  var STAGES = ['enquiry', 'qualified', 'proposal_sent', 'negotiating', 'won', 'lost'];
  var STAGE_LABEL = {
    enquiry: 'New enquiry', qualified: 'Qualified', proposal_sent: 'Proposal sent',
    negotiating: 'Negotiating', won: 'Booked', lost: 'Lost'
  };
  var STAGE_TONE = { enquiry: 'muted', qualified: 'info', proposal_sent: 'warn', negotiating: 'info', won: 'ok', lost: 'bad' };
  var STAGE_WEIGHT = { enquiry: 0.2, qualified: 0.4, proposal_sent: 0.6, negotiating: 0.8, won: 1, lost: 0 };
  var STAGE_BAR = {
    enquiry: '#E6B44C', qualified: '#C6B7E2', proposal_sent: '#7E5A10',
    negotiating: '#3B1C5A', won: '#2E6B4A', lost: '#A3401E'
  };
  var KIND_LABEL = { school: 'School', team_building: 'Team building', birthday: 'Birthday', other: 'Other' };

  function stagePill(stage) {
    return pill(STAGE_LABEL[stage] || stage || '—', STAGE_TONE[stage] || 'muted');
  }

  function rm(n) {
    return 'RM' + Number(n || 0).toLocaleString('en-MY', { maximumFractionDigits: 0 });
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '·';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  function idleDays(deal, today) {
    var from = (deal.updated_at || deal.created_at || '').slice(0, 10);
    if (!from || !today) return 0;
    return Math.floor((Date.parse(today) - Date.parse(from)) / 86400000);
  }

  function activityState(deal, today) {
    if (!deal.next_due) return { cls: 'act-none', label: 'No next activity' };
    if (deal.next_due < today) return { cls: 'act-over', label: 'Overdue' };
    if (deal.next_due === today) return { cls: 'act-soon', label: 'Due today' };
    return { cls: 'act-soon', label: 'Upcoming task' };
  }

  function dealCard(d, opts) {
    var today = opts.today;
    var owner = (opts.owners && opts.owners[d.owner]) || '';
    var idle = idleDays(d, today);
    var rotten = d.stage !== 'won' && d.stage !== 'lost' && idle >= (opts.rotDays || 7);
    var act = activityState(d, today);
    var when = (d.expected_on || '').slice(0, 10);
    return '<article class="pipe-card' + (rotten ? ' rotten' : '') + '" draggable="true" data-id="' + esc(d.id) + '" ondragstart="dealDrag(event,\'' + esc(d.id) + '\')" onclick="ixPreview(\'deals\',\'' + esc(d.id) + '\')">'
      + '<b>' + esc(d.title) + '</b>'
      + '<p class="pipe-who">' + esc(d.company || d.contact_name || 'No contact yet') + '</p>'
      + '<p class="pipe-val">' + esc(rm(d.value_rm)) + ' · ' + esc(d.headcount || '—') + ' people</p>'
      + '<p class="pipe-meta"><span class="pipe-date">' + esc(when || 'No date') + '</span>'
      + '<span class="pipe-kind kind-' + esc(d.kind || 'other') + '">' + esc(KIND_LABEL[d.kind] || d.kind || 'Other') + '</span></p>'
      + '<footer><span class="pipe-av" title="' + esc(owner || 'Unassigned') + '">' + esc(initials(owner)) + '</span>'
      + '<span class="pipe-act ' + act.cls + '" title="' + esc(act.label) + '">◷</span>'
      + (rotten ? '<span class="pipe-rot">' + idle + 'd idle</span>' : '')
      + '<button type="button" class="pipe-move" onclick="event.stopPropagation();dealMoveOpen(\'' + esc(d.id) + '\')">Move</button>'
      + '</footer></article>';
  }

  function dealBoard(deals, opts) {
    var o = opts || {};
    var rows = deals || [];
    var stages = STAGES.filter(function (stage) { return stage !== 'lost' || o.showLost; });
    return '<div class="pipe">' + stages.map(function (stage) {
      var mine = rows.filter(function (d) { return d.stage === stage; });
      var sum = mine.reduce(function (n, d) { return n + Number(d.value_rm || 0); }, 0);
      return '<section class="pipe-col" style="--stage:' + STAGE_BAR[stage] + '" ondragover="event.preventDefault()" ondrop="dealDrop(event,\'' + stage + '\')">'
        + '<header><b>' + esc(STAGE_LABEL[stage]) + '</b><span>' + mine.length + ' · ' + esc(rm(sum)) + '</span></header>'
        + '<div class="pipe-cards">' + (mine.length ? mine.map(function (d) { return dealCard(d, o); }).join('') : '<p class="pipe-empty">No deals yet. Drag one here.</p>') + '</div>'
        + '</section>';
    }).join('') + '</div>';
  }

  function dealSummary(deals, today) {
    var open = (deals || []).filter(function (d) { return d.stage !== 'won' && d.stage !== 'lost'; });
    var openValue = open.reduce(function (n, d) { return n + Number(d.value_rm || 0); }, 0);
    var weighted = open.reduce(function (n, d) { return n + Number(d.value_rm || 0) * (STAGE_WEIGHT[d.stage] || 0); }, 0);
    var month = (today || '').slice(0, 7);
    var won = (deals || []).filter(function (d) {
      return d.stage === 'won' && ((d.updated_at || d.expected_on || '').slice(0, 7) === month);
    }).reduce(function (n, d) { return n + Number(d.value_rm || 0); }, 0);
    return { openValue: openValue, weighted: Math.round(weighted), won: won };
  }

  function checklistState(draft) {
    var d = draft || {};
    return {
      to: !!d.to,
      from: !!(d.fromName && d.fromEmail && String(d.fromEmail).indexOf('@') !== -1),
      subject: !!(d.subject && String(d.subject).trim()),
      send: d.when === 'now' || (d.when === 'later' && !!d.date),
      content: !!(d.templateId || (d.blocks && d.blocks.length))
    };
  }

  function checkRow(key, label, done, open, body) {
    return '<section class="em-step' + (open ? ' open' : '') + '" data-step="' + key + '"><button type="button" class="em-step-h" onclick="emSection(\'' + key + '\')"><span class="em-tick' + (done ? ' on' : '') + '" aria-hidden="true">' + (done ? '✓' : '') + '</span><span>' + esc(label) + '</span></button>'
      + (open ? '<div class="em-step-b">' + body + '</div>' : '') + '</section>';
  }

  function checklistHtml(draft, open, lists) {
    var d = draft || {};
    var state = checklistState(d);
    var listOptions = '<option value="">Choose a list</option>' + (lists || []).map(function (list) {
      return '<option value="' + esc(list.id) + '"' + (list.id === d.to ? ' selected' : '') + '>' + esc(list.name) + '</option>';
    }).join('');
    return '<div class="em-check"><p class="ix-note">Work through the list in any order. A tick means that part is filled in. Nothing is sent from this page.</p>'
      + '<label class="ix-field" style="padding:12px 16px 0">Campaign name<input id="emName" value="' + esc(d.name || '') + '" oninput="emRead()"></label>'
      + checkRow('to', 'To', state.to, open === 'to', '<label class="ix-field">Audience<select id="emTo" onchange="emRead()">' + listOptions + '</select></label>')
      + checkRow('from', 'From', state.from, open === 'from', '<div class="em-grid"><label class="ix-field">From name<input id="emFromName" value="' + esc(d.fromName || 'Master Artist') + '" oninput="emRead()"></label><label class="ix-field">From email<input id="emFromEmail" value="' + esc(d.fromEmail || 'news@masterartist.co') + '" oninput="emRead()"></label></div><p class="help">Marketing mail uses news@masterartist.co. Booking receipts stay on bookings@masterartist.co.</p>')
      + checkRow('subject', 'Subject', state.subject, open === 'subject', '<label class="ix-field">Subject<input id="emSubject" value="' + esc(d.subject || '') + '" oninput="emRead()" maxlength="160"></label><label class="ix-field">Preview text<input id="emPreviewText" value="' + esc(d.preview || '') + '" oninput="emRead()" maxlength="140"></label>')
      + checkRow('send', 'Send time', state.send, open === 'send', '<label class="ix-check"><input type="radio" name="emWhen" value="now" ' + (d.when !== 'later' ? 'checked' : '') + ' onchange="emRead()"> Save as a draft queue for now</label><label class="ix-check"><input type="radio" name="emWhen" value="later" ' + (d.when === 'later' ? 'checked' : '') + ' onchange="emRead()"> Schedule</label><label class="ix-field">Date<input id="emDate" type="date" value="' + esc(d.date || '') + '" oninput="emRead()"></label><p class="help">Scheduling only queues the campaign. Resend is not called.</p>')
      + checkRow('content', 'Content', state.content, open === 'content', '<p class="help">Pick a template or add blocks in the editor. The live preview is sample copy for Aina.</p><p><button type="button" class="ix-btn primary" onclick="emGo(\'editor\')">Edit content</button> <button type="button" class="ix-btn" onclick="emGo(\'templates\')">Template gallery</button></p>')
      + '<p class="em-actions"><button type="button" class="ix-btn" onclick="emGo(\'campaigns\')">Back to campaigns</button><button type="button" class="ix-btn primary" onclick="emailSaveDraft()">Save draft</button></p></div>';
  }

  function blockPreview(block) {
    if (!block) return '';
    if (block.type === 'heading') return '<h2>' + esc(block.text || '') + '</h2>';
    if (block.type === 'button') return '<p><span class="em-cta">' + esc(block.text || 'Book') + '</span></p>';
    if (block.type === 'image') return '<p class="em-ph">Image · ' + esc(block.text || 'Studio photo') + '</p>';
    if (block.type === 'divider') return '<hr>';
    return '<p>' + esc(block.text || '') + '</p>';
  }

  function editorHtml(draft, device) {
    var blocks = (draft && draft.blocks) || [];
    var palette = ['heading', 'text', 'image', 'button', 'divider'].map(function (type) {
      return '<button type="button" class="ix-btn" onclick="emAdd(\'' + type + '\')">' + esc(type[0].toUpperCase() + type.slice(1)) + '</button>';
    }).join('');
    var list = blocks.map(function (block, i) {
      return '<article class="em-block" draggable="true" ondragstart="emDrag(event,' + i + ')" ondragover="emOver(event)" ondrop="emDrop(event,' + i + ')">'
        + '<header><span class="em-handle" title="Drag to reorder">↕</span><b>' + esc(block.type) + '</b><button type="button" class="ix-btn" onclick="emRemove(' + i + ')">Remove</button></header>'
        + (block.type === 'divider' ? '' : '<textarea oninput="emBlock(' + i + ',this.value)">' + esc(block.text || '') + '</textarea>')
        + '</article>';
    }).join('') || '<p class="help">Add a block. Drag a block onto another to reorder it.</p>';
    var preview = blocks.map(blockPreview).join('') || '<p>Your sections show up here.</p>';
    return '<div class="em-editor"><div class="em-pal"><p class="ix-kicker">Blocks</p>' + palette + '<p><button type="button" class="ix-btn" onclick="emGo(\'checklist\')">Back to checklist</button></p></div>'
      + '<div class="em-canvas">' + list + '</div>'
      + '<div class="em-stage"><div class="ix-modes"><button type="button" class="ix-btn' + (device !== 'mobile' ? ' on' : '') + '" onclick="emDevice(\'desktop\')">Desktop</button><button type="button" class="ix-btn' + (device === 'mobile' ? ' on' : '') + '" onclick="emDevice(\'mobile\')">Mobile</button></div>'
      + '<div class="em-preview ' + (device === 'mobile' ? 'mobile' : 'desktop') + '"><p class="em-from">Master Artist</p><div id="emLive">' + preview + '</div><p class="em-foot">Master Artist, 38-2, Jalan 28/70A, Desa Sri Hartamas, 50480 Kuala Lumpur<br>Unsubscribe</p></div>'
      + '<p class="help">Preview for Aina. No email was sent.</p></div></div>';
  }

  function galleryHtml(templates) {
    var cards = (templates || []).map(function (tpl) {
      return '<article class="em-card"><p class="ix-kicker">Template</p><h3>' + esc(tpl.name) + '</h3><p>' + esc(tpl.subject || '') + '</p><button type="button" class="ix-btn primary" onclick="emUseTemplate(\'' + esc(tpl.id) + '\')">Use this</button></article>';
    }).join('');
    return '<div class="em-gallery">' + (cards || '<p class="ix-empty">No templates yet.</p>') + '</div>';
  }

  function rate(part, whole) {
    if (!whole) return '—';
    return Math.round((Number(part) / Number(whole)) * 1000) / 10 + '%';
  }

  function reportHtml(stats) {
    var s = stats || {};
    var recipients = Number(s.recipients || 0);
    var tiles = [
      ['Recipients', recipients || '0'],
      ['Open rate', rate(s.opens, recipients)],
      ['Click rate', rate(s.clicks, recipients)],
      ['Unsubscribed', s.unsubscribes || 0],
      ['Bounced', s.bounces || 0],
      ['Revenue', 'RM' + Number(s.revenue || 0)]
    ].map(function (tile) {
      return '<div class="em-tile"><span>' + esc(tile[0]) + '</span><b>' + esc(tile[1]) + '</b></div>';
    }).join('');
    var links = (s.links || []).map(function (link) {
      return '<tr><td>' + esc(link.url) + '</td><td>' + esc(link.clicks) + '</td></tr>';
    }).join('');
    return '<div class="em-report"><p><button type="button" class="ix-btn" onclick="emGo(\'campaigns\')">All campaigns</button></p>'
      + (s.sample ? '<p class="em-sample">Sample figures for a fake campaign. No email was sent.</p>' : '')
      + '<h2>' + esc(s.name || 'Campaign') + '</h2><p class="ix-note">' + esc(s.audience || '') + (s.subject ? ' · ' + esc(s.subject) : '') + '</p>'
      + '<div class="em-tiles">' + tiles + '</div>'
      + '<h3>Top links</h3><div class="ix-scroll"><table class="ix-table"><thead><tr><th>Link</th><th>Clicks</th></tr></thead><tbody>'
      + (links || '<tr><td colspan="2" class="ix-empty">No clicks yet.</td></tr>')
      + '</tbody></table></div></div>';
  }

  var ICONS = {
    inbox: '<path d="M4 6h16v10H4z"/><path d="M4 7l8 6 8-6"/>',
    customers: '<circle cx="9" cy="8" r="3"/><path d="M3.5 18c.6-2.6 2.8-4 5.5-4s4.9 1.4 5.5 4"/><circle cx="17" cy="9" r="2"/><path d="M16 14.2c1.8.3 3.2 1.4 3.8 3.3"/>',
    tasks: '<path d="M8 6h11M8 12h11M8 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    lists: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h2v2H4zM4 11h2v2H4zM4 16h2v2H4z"/>',
    deals: '<path d="M4 19V5M4 19h16"/><path d="M8 15v-3M12 15V8M16 15v-5"/>',
    email: '<path d="M4 7h16v10H4z"/><path d="M4 8l8 6 8-6"/>',
    reports: '<path d="M5 19V10M10 19V5M15 19v-6M20 19V8"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4"/>',
    website: '<path d="M4 6h16v12H4z"/><path d="M4 10h16"/>'
  };

  function icon(name) {
    return '<svg class="nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' + (ICONS[name] || ICONS.lists) + '</svg>';
  }

  function appNav(groups, active) {
    return (groups || []).map(function (group) {
      var items = (group.items || []).map(function (item) {
        var childOn = (item.children || []).some(function (child) { return child.id === active; });
        var on = item.id === active || childOn;
        var badge = item.badge ? '<span class="n">' + esc(item.badge) + '</span>' : '';
        var row = '<button type="button" class="snav' + (on ? ' on' : '') + '" onclick="' + item.go + '"><span class="nav-ic">' + icon(item.icon) + '</span><span class="nav-lb">' + esc(item.label) + '</span>' + badge + '</button>';
        var kids = (item.children || []).map(function (child) {
          return '<button type="button" class="snav sub' + (child.id === active ? ' on' : '') + '" onclick="' + child.go + '"><span class="nav-lb">' + esc(child.label) + '</span></button>';
        }).join('');
        return row + kids;
      }).join('');
      return '<p class="nav-group">' + esc(group.label) + '</p>' + items;
    }).join('');
  }

  function folds(sections) {
    return (sections || []).map(function (section, i) {
      var open = section.open || i === 0;
      return '<details class="fold"' + (open ? ' open' : '') + '><summary>' + esc(section.title) + '</summary><div class="fold-b">' + (section.body || '') + '</div></details>';
    }).join('');
  }

  function clauseText(definition) {
    var clauses = (definition && definition.clauses) || [];
    if (!clauses.length) return 'No filters';
    return clauses.map(function (c) { return (c.field || '') + ' ' + (c.op || 'eq') + ' ' + c.value; }).join(' · ');
  }

  return {
    esc: esc,
    leadScore: leadScore,
    reasonText: reasonText,
    emailSendable: emailSendable,
    segmentMatch: segmentMatch,
    pill: pill,
    sortRows: sortRows,
    pageWindow: pageWindow,
    taskBucket: taskBucket,
    taskPriority: taskPriority,
    indexHtml: indexHtml,
    recordFrame: recordFrame,
    stagePill: stagePill,
    dealBoard: dealBoard,
    checklistState: checklistState,
    checklistHtml: checklistHtml,
    editorHtml: editorHtml,
    galleryHtml: galleryHtml,
    reportHtml: reportHtml,
    rate: rate,
    clauseText: clauseText,
    appNav: appNav,
    folds: folds,
    icon: icon,
    STAGES: STAGES,
    STAGE_LABEL: STAGE_LABEL,
    KIND_LABEL: KIND_LABEL,
    dealSummary: dealSummary,
    rm: rm
  };
});
