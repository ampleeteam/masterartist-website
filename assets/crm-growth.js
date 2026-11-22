/* CRM growth helpers: score, tasks, lists, deals, email.
   Loaded only by admin.html. The public site does not use this file. */
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

  /* Mirrors public.contact_lead_scores. Reasons are codes, never message text. */
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
      if (clause.field === 'is_organiser') return !!c.is_organiser;
      if (clause.field === 'birthday_enquiry') return !!c.birthday_enquiry;
      if (clause.field === 'asked_price') return !!c.asked_price;
      return false;
    });
  }

  function renderTasks(tasks) {
    var rows = tasks || [];
    if (!rows.length) return '<div class="empty">No open tasks. Automatic reminders appear when a lead waits 24 hours, a booking stays unpaid, a workshop was yesterday, or 45 days pass with no new booking.</div>';
    return '<div class="bk-wrap"><table class="bk"><tr><th>Due</th><th>Task</th><th>Customer</th><th>Kind</th><th></th></tr>'
      + rows.map(function (t) {
        return '<tr><td>' + esc(t.due_on || '') + '</td><td><b>' + esc(t.title) + '</b><br><small>' + esc(t.detail || '') + '</small></td><td>'
          + esc(t.contact_name || '') + '</td><td><small>' + esc(t.kind) + '</small></td><td>'
          + '<button class="btn sm" type="button" onclick="taskDone(\'' + esc(t.id) + '\')">Done</button></td></tr>';
      }).join('') + '</table></div>';
  }

  function renderSegments(segments) {
    var rows = segments || [];
    if (!rows.length) return '<div class="empty">No saved lists yet.</div>';
    return rows.map(function (s) {
      var n = s.count == null ? '' : ' · ' + s.count + ' people';
      return '<div class="card"><div class="card-h"><span class="grip">' + esc(s.name) + esc(n) + '</span>'
        + '<button class="btn sm" type="button" onclick="segmentExport(\'' + esc(s.id) + '\')">Download</button>'
        + '<button class="btn sm" type="button" onclick="segmentQueue(\'' + esc(s.id) + '\')">Queue WhatsApp template</button></div>'
        + '<div class="card-b"><p class="help">Opt-in only. Queuing does not send. WhatsApp is not connected.</p></div></div>';
    }).join('');
  }

  var STAGES = ['enquiry', 'proposal_sent', 'negotiating', 'won', 'lost'];
  var STAGE_LABEL = { enquiry: 'Enquiry', proposal_sent: 'Proposal sent', negotiating: 'Negotiating', won: 'Won', lost: 'Lost' };

  function renderDeals(deals) {
    var rows = deals || [];
    return '<div class="kanban">' + STAGES.map(function (stage) {
      var mine = rows.filter(function (d) { return d.stage === stage; });
      return '<section class="kanban-col"><h3>' + esc(STAGE_LABEL[stage]) + ' <small>' + mine.length + '</small></h3>'
        + (mine.length ? mine.map(function (d) {
          return '<article class="deal"><b>' + esc(d.title) + '</b><p>RM' + esc(d.value_rm || 0) + ' · ' + esc(d.headcount || '—') + ' people</p><p class="help">'
            + esc(d.kind) + (d.expected_on ? ' · ' + esc(d.expected_on) : '') + '</p>'
            + '<select onchange="dealStage(\'' + esc(d.id) + '\', this.value)">'
            + STAGES.map(function (s) { return '<option value="' + s + '"' + (s === d.stage ? ' selected' : '') + '>' + esc(STAGE_LABEL[s]) + '</option>'; }).join('')
            + '</select></article>';
        }).join('') : '<p class="help">Empty</p>')
        + '</section>';
    }).join('') + '</div>';
  }

  function renderEmail(campaigns, flows) {
    var list = (campaigns || []).map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td><td>' + esc(c.status) + '</td><td>' + esc(c.scheduled_at || '') + '</td><td>'
        + (c.revenue_rm != null ? 'RM' + esc(c.revenue_rm) : '') + '</td></tr>';
    }).join('');
    var flowRows = (flows || []).map(function (f) {
      return '<li>' + esc(f.name) + ' · ' + esc(f.trigger) + (f.active ? '' : ' · paused') + '</li>';
    }).join('');
    return '<div class="card"><div class="card-h"><span class="grip">Campaigns</span></div><div class="card-b">'
      + (list ? '<div class="bk-wrap"><table class="bk"><tr><th>Name</th><th>Status</th><th>Scheduled</th><th>Attributed revenue</th></tr>' + list + '</table></div>'
        : '<div class="empty">No campaigns yet. Pick a saved list and a template. Nothing is sent until Resend DNS is in place.</div>')
      + '</div></div><div class="card"><div class="card-h"><span class="grip">Flows</span></div><div class="card-b"><ul>'
      + (flowRows || '<li>No flows.</li>') + '</ul><p class="help">Welcome, before and after a workshop, a review request, a 45-day win-back, and a birthday note. They queue only. They do not send.</p></div></div>';
  }

  return {
    esc: esc,
    leadScore: leadScore,
    reasonText: reasonText,
    emailSendable: emailSendable,
    segmentMatch: segmentMatch,
    renderTasks: renderTasks,
    renderSegments: renderSegments,
    renderDeals: renderDeals,
    renderEmail: renderEmail,
    STAGES: STAGES
  };
});
