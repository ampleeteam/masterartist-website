/* Shared-inbox helpers for the admin. Not loaded by the public site.
   Also runs under Node for tests. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaInbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

  function klParts(date) {
    var fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });
    var parts = {};
    fmt.formatToParts(date).forEach(function (p) { parts[p.type] = p.value; });
    return { dow: DAY[parts.weekday], minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  }

  function weekKey(dow, minutes) { return dow * 1440 + minutes; }

  /* Fixed weekly window in Asia/Kuala_Lumpur. Default Friday 19:00 to Saturday 19:30.
     The end minute is exclusive. A window that passes Saturday wraps into Sunday. */
  function inSabbathWindow(date, settings) {
    var s = settings || {};
    var p = klParts(date instanceof Date ? date : new Date(date));
    var now = weekKey(p.dow, p.minutes);
    var start = weekKey(s.startDow == null ? 5 : s.startDow, s.startMin == null ? 19 * 60 : s.startMin);
    var end = weekKey(s.endDow == null ? 6 : s.endDow, s.endMin == null ? 19 * 60 + 30 : s.endMin);
    if (start === end) return false;
    if (start < end) return now >= start && now < end;
    return now >= start || now < end;
  }

  function whatsappWindow(lastInboundIso, now, fromAd) {
    var at = now instanceof Date ? now.getTime() : new Date(now || Date.now()).getTime();
    if (!lastInboundIso) {
      return { open: false, msLeft: 0, expiresAt: null, fromAd: !!fromAd, label: 'No customer message yet',
        note: fromAd ? 'This conversation may have come from a click-to-WhatsApp ad. Meta sometimes keeps that window open longer. This screen still uses 24 hours.' : '' };
    }
    var end = new Date(lastInboundIso).getTime() + 24 * 60 * 60 * 1000;
    var ms = end - at;
    var open = ms > 0;
    return {
      open: open,
      msLeft: Math.max(0, ms),
      expiresAt: new Date(end).toISOString(),
      fromAd: !!fromAd,
      label: open ? formatCountdown(ms) : '24-hour window closed',
      note: fromAd ? 'This conversation may have come from a click-to-WhatsApp ad. Meta sometimes keeps that window open longer. This countdown uses 24 hours.' : ''
    };
  }

  function formatCountdown(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return h + 'h ' + String(m).padStart(2, '0') + 'm left in the 24-hour window';
  }

  function fillTemplate(body, vars) {
    return String(body || '').replace(/\{([a-z0-9_]+)\}/gi, function (_, key) {
      var v = vars && Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '';
      return v == null ? '' : String(v);
    });
  }

  function slashQuery(text) {
    var m = String(text || '').match(/(?:^|\s)\/([^\s/]*)$/);
    return m ? m[1] : null;
  }

  function matchReplies(replies, query) {
    var q = String(query || '').toLowerCase();
    return (replies || []).filter(function (r) {
      return String(r.title || '').toLowerCase().indexOf(q) !== -1
        || String(r.shortcut || '').toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);
  }

  function copyAllowed(text) {
    return !/sip and paint|cheaper than|\bhrdc\b|plant-based|plant based/i.test(String(text || ''));
  }

  function mentionsIn(text, staff) {
    var body = String(text || '').toLowerCase();
    return (staff || []).filter(function (s) {
      var name = String(s.full_name || '').trim().toLowerCase();
      return name && body.indexOf('@' + name) !== -1;
    });
  }

  /* Payload the future 360dialog worker will send. This does not call the network. */
  function providerPayload(job) {
    if (job && job.template_name) {
      return { type: 'template', to: job.phone_e164 || null, name: job.template_name, language: job.language || 'en', variables: job.variables || {}, buttons: job.buttons || [] };
    }
    return { type: 'session', to: job && job.phone_e164 || null, body: job && job.body || '', buttons: job && job.buttons || [] };
  }

  function duePayloads(rows) {
    return (rows || []).map(providerPayload);
  }

  var whatsappProvider = {
    name: '360dialog',
    send: function (job) {
      return Promise.resolve({ ok: false, connected: false, reason: '360dialog is not connected yet.', payload: providerPayload(job) });
    },
    /* Turns fetch_due_outbound rows into 360dialog payloads. The network call lives in supabase/functions/whatsapp-send and stays off until D360_SEND_ENABLED=true. */
    sendDue: function (rows) {
      return Promise.resolve({ ok: false, connected: false, sent: 0, payloads: duePayloads(rows) });
    }
  };

  return {
    inSabbathWindow: inSabbathWindow,
    whatsappWindow: whatsappWindow,
    formatCountdown: formatCountdown,
    fillTemplate: fillTemplate,
    slashQuery: slashQuery,
    matchReplies: matchReplies,
    copyAllowed: copyAllowed,
    mentionsIn: mentionsIn,
    providerPayload: providerPayload,
    duePayloads: duePayloads,
    whatsappProvider: whatsappProvider
  };
});
