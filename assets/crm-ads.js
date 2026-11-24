/* Ad source card, the workshop ads tab, and the ad-link editor. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaAds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var PLATFORM = { meta: 'Meta', google: 'Google', tiktok: 'TikTok', other: 'Other' };

  function money(n) {
    if (n == null || n === '') return '—';
    return 'RM' + Number(n).toLocaleString('en-MY', { maximumFractionDigits: 0 });
  }

  function sourceCard(link, extra) {
    var row = link || {};
    var note = extra || {};
    var thumb = row.creative_url ? '<img alt="" src="' + esc(row.creative_url) + '" style="width:72px;height:72px;object-fit:cover;border-radius:12px">' : '';
    return '<article class="card"><div class="card-h"><span class="grip">Ad source</span><span class="pipe-kind kind-' + (row.platform === 'google' ? 'team_building' : 'school') + '">' + esc(PLATFORM[row.platform] || row.platform || '') + '</span></div><div class="card-b" style="display:flex;gap:12px">'
      + thumb
      + '<div><b>' + esc(row.ad_name || 'Unlinked') + '</b><p class="help">' + esc(row.campaign_name || '') + '</p>'
      + '<p class="help">' + esc(note.target_title || row.target_id || 'No workshop yet') + '</p>'
      + '<p class="help">Matched by ' + esc(String(note.method || '—').replace(/_/g, ' ')) + (row.ref_code ? ' · ' + esc(row.ref_code) : '') + '</p></div></div></article>';
  }

  function adsTab(rows) {
    var list = rows || [];
    if (!list.length) return '<p class="help">No ads linked to this workshop yet.</p>';
    return '<div class="bk-wrap"><table class="bk"><tr><th>Platform</th><th>Campaign</th><th>Ad</th><th>Chats</th><th>Enquired</th><th>Booked</th><th>Paid</th><th>Attended</th><th>Spend</th><th>Cost / chat</th><th>ROAS</th></tr>'
      + list.map(function (r) {
        var spend = r.spend_rm;
        var chats = Number(r.chats || 0);
        var cost = spend == null || !chats ? null : Number(spend) / chats;
        var roas = spend == null || Number(spend) === 0 || r.revenue_rm == null ? null : Number(r.revenue_rm) / Number(spend);
        return '<tr><td>' + esc(PLATFORM[r.platform] || r.platform) + '</td><td>' + esc(r.campaign_name || '') + '</td><td>' + esc(r.ad_name || '') + '</td><td>' + chats + '</td><td>' + (r.enquired || 0) + '</td><td>' + (r.booked || 0) + '</td><td>' + (r.paid || 0) + '</td><td>' + (r.attended || 0) + '</td><td>' + money(spend) + '</td><td>' + money(cost) + '</td><td>' + (roas == null ? '—' : String(Math.round(roas * 10) / 10)) + '</td></tr>';
      }).join('') + '</table></div>';
  }

  function linksPage(links) {
    var rows = links || [];
    return '<p class="help">Each ad points at one workshop, event or group booking. Several ads can share the same target. The ref code is what the website adds to the WhatsApp message.</p>'
      + '<div class="bk-wrap"><table class="bk"><tr><th>Platform</th><th>Campaign</th><th>Ad</th><th>Ref</th><th>Target</th><th>Tracking URL</th></tr>'
      + rows.map(function (r) {
        return '<tr><td>' + esc(PLATFORM[r.platform] || '') + '</td><td>' + esc(r.campaign_name || '') + '</td><td>' + esc(r.ad_name || '') + '</td><td>' + esc(r.ref_code || '') + '</td><td>' + esc((r.target_type || '') + ' ' + (r.target_title || r.target_id || '')) + '</td><td><small>' + esc(r.tracking_url || '') + '</small></td></tr>';
      }).join('') + '</table></div>'
      + '<div class="card"><div class="card-h"><span class="grip">Add an ad link</span></div><div class="card-b"><div class="row">'
      + '<div class="f"><label>Platform</label><select id="adPlatform"><option value="meta">Meta</option><option value="google">Google</option><option value="tiktok">TikTok</option><option value="other">Other</option></select></div>'
      + '<div class="f"><label>Campaign</label><input id="adCampaign"></div>'
      + '<div class="f"><label>Ad name</label><input id="adName"></div></div>'
      + '<div class="row"><div class="f"><label>Ad id</label><input id="adId"></div><div class="f"><label>Ref code</label><input id="adRef" placeholder="MA-GB1129-M1"></div>'
      + '<div class="f"><label>Target</label><select id="adTarget"><option value="session">Workshop session</option><option value="event">Event</option><option value="group_booking">Group booking</option><option value="format">Format</option><option value="general">General</option></select></div></div>'
      + '<p><button type="button" class="ix-btn primary" onclick="adLinkSave()">Save link</button></p></div></div>';
  }

  return { esc: esc, PLATFORM: PLATFORM, sourceCard: sourceCard, adsTab: adsTab, linksPage: linksPage, money: money };
});
