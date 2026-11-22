/* WhatsApp "Export chat" parser and the customer timeline markup.
   Loaded by admin.html. Also runs under Node (module.exports) for tests.
   The public website does not use this file. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaCrm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normaliseMyPhone(input) {
    if (input == null) return '';
    var d = String(input).trim().replace(/[^\d+]/g, '');
    if (!d || d === '+') return '';
    if (d.charAt(0) === '+') d = d.slice(1);
    if (d.slice(0, 2) === '00') d = d.slice(2);
    if (d.charAt(0) === '0') d = '60' + d.slice(1);
    if (/^1\d{8,9}$/.test(d)) d = '60' + d;
    if (!/^\d{8,15}$/.test(d)) return '';
    return '+' + d;
  }

  function isStudioSender(sender, ourName) {
    var a = String(sender || '').trim().toLowerCase();
    var b = String(ourName || '').trim().toLowerCase();
    return a === 'you' || (!!b && a === b);
  }

  var HEADER = /^(?:\[)?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)\s*\]?\s*(?:-\s*)?([\s\S]+)$/i;

  function cleanLine(line) {
    return String(line || '').replace(/^[\u200e\u200f\u202a\u202b\u202c\u202d\u202e\ufeff\s]+/, '').replace(/\s+$/, '');
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function parseWhen(dateStr, timeStr) {
    var bits = dateStr.split(/[\/.-]/).map(function (x) { return parseInt(x, 10); });
    var a = bits[0], b = bits[1], year = bits[2];
    if (!a || !b || !year) return null;
    var day = a, month = b;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else if (b > 12 && a <= 12) { day = b; month = a; }
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    var tm = timeStr.trim().toUpperCase();
    var ampm = tm.match(/\s*([AP]M)$/);
    var clock = tm.replace(/\s*[AP]M$/, '');
    var parts = clock.split(':').map(function (x) { return parseInt(x, 10); });
    var h = parts[0], m = parts[1], s = parts[2] || 0;
    if (isNaN(h) || isNaN(m) || h > 23 || m > 59 || s > 59) return null;
    if (ampm) {
      if (h > 12) return null;
      if (ampm[1] === 'PM' && h < 12) h += 12;
      if (ampm[1] === 'AM' && h === 12) h = 0;
    }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    var iso = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(h) + ':' + pad(m) + ':' + pad(s) + '+08:00';
    var dt = new Date(iso);
    if (isNaN(dt.getTime())) return null;
    return dt.toISOString();
  }

  function isSkippableSystem(text) {
    return /end-to-end encrypted|messages and calls are end-to-end|this message was deleted|you deleted this message|message was edited|missed voice call|missed video call|security code changed|changed their phone number|waiting for this message|disappearing messages|changed the subject|changed this group'?s icon|created group|created this group|added you|you were added|left$/i.test(text);
  }

  function mediaFromBody(body) {
    var text = body || '';
    var media = [];
    if (/<media omitted>/i.test(text)) media.push({ kind: 'omitted' });
    if (/\bimage omitted\b/i.test(text)) media.push({ kind: 'image' });
    if (/\bvideo omitted\b/i.test(text)) media.push({ kind: 'video' });
    if (/\baudio omitted\b/i.test(text)) media.push({ kind: 'audio' });
    if (/\bdocument omitted\b/i.test(text)) media.push({ kind: 'document' });
    if (/\bsticker omitted\b/i.test(text)) media.push({ kind: 'sticker' });
    var files = text.match(/[^\s:]+\.(?:jpg|jpeg|png|webp|mp4|opus|ogg|pdf|vcf)\s+\(file attached\)/gi) || [];
    files.forEach(function (f) {
      media.push({ kind: 'file', name: f.replace(/\s+\(file attached\)/i, '') });
    });
    return media;
  }

  function pushMessage(messages, current) {
    if (!current) return;
    var body = current.body.replace(/^\n+|\n+$/g, '');
    if (!body && !(current.media && current.media.length)) return;
    messages.push({
      occurredAt: current.occurredAt,
      sender: current.sender,
      body: body,
      media: current.media && current.media.length ? current.media : mediaFromBody(body),
      system: !!current.system
    });
  }

  /* Parse a WhatsApp Export chat .txt (Without media). Times are read as
     Asia/Kuala_Lumpur. Day/month/year when the date is ambiguous, which is
     what Malaysian phones write. Returns { messages, skipped }. */
  function parseWhatsAppExport(text) {
    var messages = [];
    var skipped = 0;
    var current = null;
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var line = cleanLine(raw);
      if (!line) return;
      var match = line.match(HEADER);
      if (!match) {
        if (current) current.body += '\n' + line;
        return;
      }
      var when = parseWhen(match[1], match[2]);
      var rest = match[3].trim();
      if (!when) { skipped += 1; return; }
      var colon = rest.indexOf(': ');
      if (colon === -1) {
        pushMessage(messages, current);
        current = null;
        if (isSkippableSystem(rest)) { skipped += 1; return; }
        current = { occurredAt: when, sender: '', body: rest, media: mediaFromBody(rest), system: true };
        return;
      }
      var sender = rest.slice(0, colon).replace(/^~\s*/, '').trim();
      var body = rest.slice(colon + 2);
      if (isSkippableSystem(body) && !sender) { skipped += 1; current = null; return; }
      pushMessage(messages, current);
      current = { occurredAt: when, sender: sender, body: body, media: [], system: false };
    });
    pushMessage(messages, current);
    return { messages: messages, skipped: skipped };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  var BOOKING_LABEL = {
    requested: 'Booking requested',
    confirmed: 'Booking confirmed',
    paid: 'Booking paid',
    cancelled: 'Booking cancelled',
    refunded: 'Booking refunded',
    expired: 'Payment expired',
    pending: 'Sent to payment page',
    no_show: 'No-show'
  };

  var SOURCE_LABEL = {
    history_sync: 'history sync',
    export_import: 'imported chat',
    manual: 'staff note'
  };

  function whenLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-MY', {
      timeZone: 'Asia/Kuala_Lumpur',
      day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
  }

  function mediaLabel(media) {
    if (!media || !media.length) return '';
    return media.map(function (m) {
      if (m.kind === 'file' && m.name) return 'File: ' + m.name;
      if (m.kind === 'omitted') return 'Photo, video, or file (not in the export)';
      return (m.kind || 'file') + ' (not stored)';
    }).join(' · ');
  }

  function rowsToTimeline(rows) {
    return (rows || []).map(function (row) {
      return {
        occurredAt: row.occurred_at,
        kind: row.kind,
        channel: row.channel,
        direction: row.direction,
        senderType: row.sender_type,
        senderName: row.sender_name || '',
        body: row.body || '',
        status: row.status || '',
        source: row.source || '',
        bookingEvent: row.booking_event || '',
        media: row.media || [],
        buttons: row.buttons || []
      };
    }).filter(function (row) { return row.occurredAt; })
      .sort(function (a, b) {
        var d = new Date(a.occurredAt) - new Date(b.occurredAt);
        if (d) return d;
        if (a.kind !== b.kind) return a.kind === 'booking' ? 1 : -1;
        return 0;
      });
  }

  function filterTimeline(items, key) {
    if (key === 'whatsapp') return items.filter(function (i) { return i.channel === 'whatsapp'; });
    if (key === 'notes') return items.filter(function (i) { return i.channel === 'note'; });
    if (key === 'auto') return items.filter(function (i) { return i.senderType === 'bot'; });
    if (key === 'bookings') return items.filter(function (i) { return i.kind === 'booking'; });
    return items;
  }

  function whoLabel(item) {
    if (item.kind === 'booking') return '';
    if (item.senderType === 'bot') return '\u2699 Automated';
    if (item.senderType === 'system') return 'WhatsApp';
    if (item.senderType === 'staff') return item.senderName || 'Staff';
    return item.senderName || 'Customer';
  }

  var CHANNELS = {
    whatsapp: { label: 'WhatsApp', cls: 'ch-wa' },
    instagram: { label: 'Instagram', cls: 'ch-ig' },
    facebook: { label: 'Messenger', cls: 'ch-ms' },
    messenger: { label: 'Messenger', cls: 'ch-ms' },
    email: { label: 'Email', cls: 'ch-em' },
    sms: { label: 'SMS', cls: 'ch-sms' },
    call: { label: 'Call', cls: 'ch-call' },
    website: { label: 'Website form', cls: 'ch-web' },
    note: { label: 'Note', cls: 'ch-note' }
  };

  function channelInfo(channel) {
    return CHANNELS[channel] || { label: channel || 'Message', cls: 'ch-other' };
  }

  function channelBadge(channel) {
    var info = channelInfo(channel);
    return '<span class="ch-badge ' + info.cls + '"><span class="ch-ico" aria-hidden="true">●</span><span class="ch-lab">' + esc(info.label) + '</span></span>';
  }

  function klParts(value) {
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return null;
    var parts = {};
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kuala_Lumpur',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: 'numeric', minute: '2-digit', hourCycle: 'h12'
    }).formatToParts(d).forEach(function (p) { parts[p.type] = p.value; });
    return parts;
  }

  function klKey(value) {
    var p = klParts(value);
    return p ? p.year + '-' + p.month + '-' + p.day : '';
  }

  function shiftKey(ymd, days) {
    var bits = ymd.split('-').map(Number);
    var dt = new Date(Date.UTC(bits[0], bits[1] - 1, bits[2]));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  function daySpan(fromKey, toKey) {
    var a = fromKey.split('-').map(Number);
    var b = toKey.split('-').map(Number);
    return Math.round((Date.UTC(b[0], b[1] - 1, b[2]) - Date.UTC(a[0], a[1] - 1, a[2])) / 86400000);
  }

  function dayHeading(iso, now) {
    var key = klKey(iso);
    var today = klKey(now || new Date());
    if (!key || !today) return '';
    if (key === today) return 'Today';
    if (key === shiftKey(today, -1)) return 'Yesterday';
    var diff = daySpan(key, today);
    var parts = klParts(iso);
    if (diff > 1 && diff < 7) return parts.weekday;
    return Number(parts.day) + ' ' + new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kuala_Lumpur', month: 'short', year: 'numeric' }).format(new Date(iso));
  }

  function klClock(iso) {
    var p = klParts(iso);
    if (!p) return '';
    var hour = String(Number(p.hour));
    var ap = (p.dayPeriod || '').toLowerCase();
    return hour + ':' + p.minute + (ap ? ' ' + ap : '');
  }

  function listStamp(iso, now) {
    var heading = dayHeading(iso, now || new Date());
    if (heading === 'Today') return klClock(iso);
    if (heading === 'Yesterday') return 'Yesterday';
    var key = klKey(iso);
    var today = klKey(now || new Date());
    var diff = key && today ? daySpan(key, today) : 99;
    if (heading && diff > 1 && diff < 7) return heading;
    var p = klParts(iso);
    if (!p) return '';
    return p.day + '/' + p.month + '/' + String(p.year).slice(2);
  }

  function ticks(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'read') return '<span class="ticks read" title="Read">✓✓</span>';
    if (s === 'delivered') return '<span class="ticks" title="Delivered">✓✓</span>';
    if (s === 'sent' || s === 'queued') return '<span class="ticks" title="Sent">✓</span>';
    if (s === 'failed') return '<span class="ticks fail" title="Failed">!</span>';
    return '';
  }

  function timelineHtml(items, now) {
    now = now || new Date();
    if (!items || !items.length) {
      return '<div class="empty" style="margin:0">Nothing here yet. Notes, WhatsApp messages, and booking events show on this timeline in time order.</div>';
    }
    var names = {};
    items.forEach(function (item) {
      if (item.direction !== 'out' && item.senderName) names[item.senderName] = true;
    });
    var multi = Object.keys(names).length > 1;
    var html = '<div class="tl">';
    var lastDay = '';
    var lastChannel = '';
    items.forEach(function (item) {
      var day = dayHeading(item.occurredAt, now);
      if (day && day !== lastDay) {
        html += '<div class="tl-day"><span>' + esc(day) + '</span></div>';
        lastDay = day;
      }
      if (item.kind === 'system') {
        html += '<p class="tl-switch">' + esc(item.body || '') + '</p>';
        return;
      }
      var channel = item.channel || '';
      if (item.kind !== 'booking' && channel && channel !== 'note' && lastChannel && channel !== lastChannel) {
        html += '<p class="tl-switch">Continued on ' + esc(channelInfo(channel).label) + '</p>';
      }
      if (item.kind !== 'booking' && channel && channel !== 'note') lastChannel = channel;
      var body = item.body || '';
      if (item.kind === 'booking') {
        var label = BOOKING_LABEL[item.bookingEvent] || 'Booking update';
        body = body ? label + ' — ' + body : label;
        html += '<p class="tl-switch">' + esc(body) + '</p>';
        return;
      }
      var cls = item.direction === 'out' ? 'out' : 'in';
      if (item.senderType === 'bot') cls += ' bot';
      if (item.channel === 'note') cls += ' note';
      var who = '';
      if (item.senderType === 'bot') who = whoLabel(item);
      else if (item.direction === 'out' && item.senderType === 'staff') who = item.senderName || 'Staff';
      else if (item.direction !== 'out' && multi && item.senderName) who = item.senderName;
      var media = mediaLabel(item.media);
      html += '<article class="tl-item ' + cls + '">'
        + (item.senderType === 'bot' ? '<div class="tl-note">Bot</div>' : '')
        + (item.channel === 'note' ? '<div class="tl-note">Note</div>' : '')
        + (who ? '<div class="tl-who">' + esc(who) + '</div>' : '')
        + (body ? '<div class="tl-body">' + esc(body).replace(/\n/g, '<br>') + '</div>' : '')
        + (media ? '<div class="tl-media">' + esc(media) + '</div>' : '')
        + '<div class="tl-foot">' + channelBadge(item.channel) + (item.direction === 'out' ? ticks(item.status) : '') + '<time class="tl-time">' + esc(klClock(item.occurredAt)) + '</time></div>'
        + '</article>';
    });
    return html + '</div>';
  }

  return {
    normaliseMyPhone: normaliseMyPhone,
    isStudioSender: isStudioSender,
    parseWhatsAppExport: parseWhatsAppExport,
    rowsToTimeline: rowsToTimeline,
    filterTimeline: filterTimeline,
    timelineHtml: timelineHtml,
    channelBadge: channelBadge,
    dayHeading: dayHeading,
    klClock: klClock,
    listStamp: listStamp,
    ticks: ticks
  };
});
