/* Events list, per-session profit and loss, and the add-cost form.
   The profit figures are only drawn when the caller already knows the viewer may see finance. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaEvents = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function money(n) { return 'RM' + Number(n || 0).toLocaleString('en-MY', { maximumFractionDigits: 0 }); }
  var CATEGORIES = ['materials', 'instructor', 'venue', 'overhead', 'food', 'printing', 'other'];

  function pnlCard(row) {
    var r = row || {};
    var tiles = [
      ['Ad spend', money(r.ad_spend_rm)],
      ['Cost / chat', r.cost_per_conversation_rm == null ? '—' : money(r.cost_per_conversation_rm)],
      ['CPA', r.cpa_rm == null ? '—' : money(r.cpa_rm)],
      ['Net revenue', money(r.net_revenue_rm)],
      ['ROAS', r.roas == null ? '—' : String(r.roas)],
      ['Gross profit', money(r.gross_profit_rm)],
      ['Margin', r.margin == null ? '—' : Math.round(Number(r.margin) * 1000) / 10 + '%'],
      ['Fill', r.fill_rate == null ? '—' : Math.round(Number(r.fill_rate) * 1000) / 10 + '%']
    ];
    return '<article class="em-tile" style="grid-column:1/-1"><h3>' + esc(r.title || r.session_id) + '</h3>'
      + '<div class="em-tiles">' + tiles.map(function (t) {
        return '<div class="em-tile"><span>' + esc(t[0]) + '</span><b>' + esc(t[1]) + '</b></div>';
      }).join('') + '</div>'
      + '<p class="help">Materials ' + money(r.cost_materials_rm) + ' · Instructor ' + money(r.cost_instructor_rm)
      + ' · Venue ' + money(r.cost_venue_rm) + ' · Overhead ' + money(r.cost_overhead_rm)
      + ' · Food ' + money(r.cost_food_rm) + ' · Printing ' + money(r.cost_printing_rm)
      + ' · Other ' + money(r.cost_other_rm) + '</p></article>';
  }

  function addCostForm(sessions) {
    var opts = (sessions || []).map(function (s) {
      return '<option value="' + esc(s.id) + '">' + esc(s.title || s.id) + '</option>';
    }).join('');
    var cats = CATEGORIES.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
    return '<form class="rec-form" id="costForm" onsubmit="return false">'
      + '<div class="f"><label>Session</label><select id="costSession">' + opts + '</select></div>'
      + '<div class="f"><label>Category</label><select id="costCategory">' + cats + '</select></div>'
      + '<div class="f"><label>Amount (RM)</label><input id="costAmount" type="number" min="0" step="0.01" inputmode="decimal"></div>'
      + '<div class="f"><label>What was it</label><input id="costNote" placeholder="Flowers, paint, instructor fee"></div>'
      + '<div class="f"><label>Receipt photo</label><input id="costReceipt" type="file" accept="image/*" capture="environment"></div>'
      + '<p><button type="button" class="ix-btn primary" onclick="eventCostSave()">Add cost</button></p>'
      + '</form>';
  }

  function ageLabel(years) {
    if (years == null || years === '' || Number(years) >= 18) return 'Adult';
    return Number(years) + ' yrs';
  }

  function historyStrip(stat, showMoney) {
    var s = stat || {};
    var tiles = [
      ['Lifetime spend', showMoney && s.lifetime_spend_rm != null ? money(s.lifetime_spend_rm) : '—'],
      ['Workshops attended', s.attended_count == null ? '—' : String(s.attended_count)],
      ['Upcoming', s.upcoming_count == null ? '—' : String(s.upcoming_count)],
      ['Last visit', s.last_attended_at || '—'],
      ['First booking', s.first_booking_at || '—'],
      ['Average spend', showMoney && s.avg_spend != null ? money(s.avg_spend) : '—']
    ];
    return '<div class="em-tiles">' + tiles.map(function (t) {
      return '<div class="em-tile"><span>' + esc(t[0]) + '</span><b>' + esc(t[1]) + '</b></div>';
    }).join('') + '</div>';
  }

  function historyList(rows, showMoney) {
    if (!rows || !rows.length) return '<p class="help">No workshops yet.</p>';
    return '<div class="bk-wrap"><table class="bk"><tr><th>Workshop</th><th>When</th><th>Attendees</th><th>Status</th>' + (showMoney ? '<th>Paid</th>' : '') + '</tr>'
      + rows.map(function (r) {
        return '<tr class="click" onclick="goNav(\'bookings\')"><td>' + esc(r.title) + '</td><td>' + esc(r.when_label || '') + '</td><td>' + esc(r.attendees || '') + '</td><td>' + esc(r.status_chip || '') + '</td>'
          + (showMoney ? '<td>' + (r.amount_paid_rm == null ? '—' : money(r.amount_paid_rm)) + '</td>' : '') + '</tr>';
      }).join('') + '</table></div>';
  }

  var ROSTER_FILTERS = ['All', 'Paid', 'Pending', 'Waitlist'];

  function rosterHtml(opts) {
    var o = opts || {};
    var rows = (o.rows || []).slice();
    var filter = o.filter || 'All';
    if (filter === 'Paid') rows = rows.filter(function (r) { return r.status === 'paid' || r.status === 'attended'; });
    if (filter === 'Pending') rows = rows.filter(function (r) { return r.status === 'pending payment' || r.status === 'confirmed'; });
    if (filter === 'Waitlist') rows = rows.filter(function (r) { return r.status === 'waitlist'; });
    rows.sort(function (a, b) {
      if (o.sort === 'status') return String(a.status).localeCompare(String(b.status)) || String(a.name).localeCompare(String(b.name));
      return String(a.name).localeCompare(String(b.name));
    });
    var taken = (o.rows || []).filter(function (r) { return r.status !== 'cancelled' && r.status !== 'refunded' && r.status !== 'waitlist'; }).length;
    var wait = (o.rows || []).filter(function (r) { return r.status === 'waitlist'; }).length;
    var paid = 0;
    var outstanding = 0;
    (o.rows || []).forEach(function (r) {
      if (!o.showMoney || r.amount_paid_rm == null) return;
      if (r.status === 'paid' || r.status === 'attended') paid += Number(r.amount_paid_rm);
      else if (r.status !== 'cancelled' && r.status !== 'refunded') outstanding += Number(r.amount_due_rm || 0);
    });
    var head = '<div class="card-h"><span class="grip">Signed up</span><span>' + taken + (o.capacity ? ' / ' + o.capacity : '') + ' seats'
      + (wait ? ' · ' + wait + ' waitlist' : '') + '</span></div>';
    var chips = ROSTER_FILTERS.map(function (name) {
      return '<button type="button" class="iv-chip' + (filter === name ? ' on' : '') + '" onclick="rosterFilter(\'' + name + '\')">' + name + '</button>';
    }).join('') + '<button type="button" class="iv-chip" onclick="rosterSort()">Sort ' + (o.sort === 'status' ? 'by name' : 'by status') + '</button>'
      + '<button type="button" class="iv-chip" onclick="rosterCsv()">Export CSV</button>';
    var body = rows.map(function (r) {
      var parent = r.child && r.booker_name
        ? '<div class="help">' + esc(r.booker_name) + (r.booker_phone ? ' · <a href="https://wa.me/' + esc(String(r.booker_phone).replace(/\D/g, '')) + '">WhatsApp</a>' : '') + '</div>'
        : '';
      var moneyCell = o.showMoney
        ? '<div>' + (r.amount_paid_rm == null ? '—' : money(r.amount_paid_rm)) + (r.split_note ? '<div class="help">' + esc(r.split_note) + '</div>' : '') + '</div>'
        : '';
      var flag = r.health_flag && o.showHealth ? '<span title="Health note on file" aria-label="Health note on file">⚑</span> ' : '';
      var mark = o.canMark && r.participant_id
        ? '<button type="button" class="ix-btn" onclick="rosterMark(\'' + esc(r.booking_id) + '\',\'' + esc(r.participant_id) + '\',\'attended\')">Attended</button> <button type="button" class="ix-btn" onclick="rosterMark(\'' + esc(r.booking_id) + '\',\'' + esc(r.participant_id) + '\',\'no_show\')">No-show</button>'
        : '';
      return '<article class="iv-card"><b>' + flag + esc(r.name) + '</b> · ' + esc(ageLabel(r.age_at_session))
        + ' <span class="ix-pill">' + esc(r.status) + '</span>' + parent + moneyCell + mark + '</article>';
    }).join('') || '<p class="help">No one on this list.</p>';
    var foot = '<p class="help">' + (o.rows || []).length + ' attendees'
      + (o.showMoney ? ' · paid ' + money(paid) + ' · outstanding ' + money(outstanding) : '') + '</p>';
    return '<div class="card">' + head + '<div class="card-b"><div class="iv-chips">' + chips + '</div>' + body + foot + '</div></div>';
  }

  function rosterCsv(rows, showMoney) {
    var cols = ['name', 'age', 'booker', 'status'];
    if (showMoney) cols.push('amount_paid_rm');
    var lines = [cols.join(',')];
    (rows || []).forEach(function (r) {
      var cells = [r.name, ageLabel(r.age_at_session), r.booker_name || '', r.status];
      if (showMoney) cells.push(r.amount_paid_rm == null ? '' : r.amount_paid_rm);
      lines.push(cells.map(function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; }).join(','));
    });
    return lines.join('\n');
  }

  return {
    esc: esc, money: money, CATEGORIES: CATEGORIES, pnlCard: pnlCard, addCostForm: addCostForm,
    ageLabel: ageLabel, historyStrip: historyStrip, historyList: historyList, rosterHtml: rosterHtml, rosterCsv: rosterCsv
  };
});
