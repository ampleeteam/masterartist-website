/* Finish-line helpers: reply variables, duplicates, booking cards, knowledge drafts.
   Nothing here sends a message. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaFinish = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var VARS = ['first_name', 'child_name', 'next_workshop', 'workshop_date', 'price', 'seats_left', 'booking_link'];

  function fillReply(body, vars) {
    return String(body || '').replace(/\{([a-z0-9_]+)\}/gi, function (_, key) {
      var value = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
      return value == null ? '' : String(value);
    });
  }

  function replyVars(contact, session) {
    var person = contact || {};
    var workshop = session || {};
    var child = (person.children && person.children[0] && person.children[0].name) || person.child_name || '';
    var seats = workshop.capacity == null ? '' : Math.max(0, Number(workshop.capacity) - Number(workshop.taken || 0));
    var id = workshop.id || '';
    return {
      first_name: person.preferred_name || person.first_name || '',
      child_name: child,
      next_workshop: workshop.title || workshop.session_name || '',
      workshop_date: workshop.when || workshop.session_when || '',
      price: workshop.price_rm == null ? '' : 'RM' + workshop.price_rm,
      seats_left: seats === '' ? '' : String(seats),
      booking_link: id ? 'https://masterartist.co/workshops/' + id : ''
    };
  }

  function bookingCard(session) {
    var v = replyVars({}, session);
    return [
      v.next_workshop,
      v.workshop_date,
      v.price ? v.price + ', all in' : '',
      v.seats_left ? v.seats_left + ' seats left' : '',
      v.booking_link
    ].filter(Boolean).join('\n');
  }

  function needsHuman(body) {
    return /\b(human|staff|person|manager|complaint|refund|book|enrol|price|how much)\b/i.test(String(body || ''));
  }

  function pauseUntil(now, minutes) {
    var mins = Number(minutes);
    if (!mins || mins < 0) mins = 30;
    return new Date(now.getTime() + mins * 60 * 1000).toISOString();
  }

  function reminderLabel(iso, now) {
    if (!iso) return '';
    var when = new Date(iso);
    if (when.getTime() <= now.getTime()) return 'Reminder due';
    return 'Remind ' + when.toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function normPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.charAt(0) === '0') digits = '6' + digits;
    return digits;
  }

  function duplicateGroups(contacts) {
    var buckets = {};
    (contacts || []).forEach(function (person) {
      var phone = normPhone(person.whatsapp_e164 || person.phone || person.phone_e164);
      var email = String(person.email || '').trim().toLowerCase();
      var name = String((person.first_name || '') + ' ' + (person.last_name || '')).trim().toLowerCase();
      [phone && 'p:' + phone, email && 'e:' + email, name.length > 4 && 'n:' + name].filter(Boolean).forEach(function (key) {
        buckets[key] = buckets[key] || [];
        buckets[key].push(person);
      });
    });
    var seen = {};
    var groups = [];
    Object.keys(buckets).forEach(function (key) {
      var rows = buckets[key];
      if (rows.length < 2) return;
      var ids = rows.map(function (r) { return r.id; }).sort().join(',');
      if (seen[ids]) return;
      seen[ids] = true;
      groups.push({ reason: key.slice(0, 2) === 'p:' ? 'Same phone' : key.slice(0, 2) === 'e:' ? 'Same email' : 'Similar name', contacts: rows });
    });
    return groups;
  }

  function searchHits(messages, query) {
    var q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    return (messages || []).filter(function (row) {
      return String(row.body || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 20);
  }

  function knowledgeAnswer(articles, question) {
    var q = String(question || '').toLowerCase();
    var words = q.split(/[^a-z0-9]+/).filter(function (w) { return w.length > 3; });
    var best = null;
    (articles || []).forEach(function (article) {
      var hay = (article.title + ' ' + article.body + ' ' + (article.keywords || '')).toLowerCase();
      var hits = words.filter(function (w) { return hay.indexOf(w) !== -1; }).length;
      if (!hits) return;
      if (!best || hits > best.hits) best = { article: article, hits: hits };
    });
    if (!best) return { ok: false, gap: question };
    return { ok: true, draft: best.article.body, title: best.article.title };
  }

  function channelDot(channel) {
    var map = { whatsapp: 'wa', instagram: 'ig', facebook: 'ms', email: 'em', website: 'web', call: 'call', sms: 'sms' };
    return '<span class="mc-dot dot-' + (map[channel] || 'web') + '" title="' + String(channel || '') + '"></span>';
  }

  return {
    VARS: VARS, fillReply: fillReply, replyVars: replyVars, bookingCard: bookingCard,
    needsHuman: needsHuman, pauseUntil: pauseUntil, reminderLabel: reminderLabel,
    duplicateGroups: duplicateGroups, searchHits: searchHits, knowledgeAnswer: knowledgeAnswer,
    channelDot: channelDot
  };
});
