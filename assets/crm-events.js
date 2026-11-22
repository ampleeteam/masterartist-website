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

  return { esc: esc, money: money, CATEGORIES: CATEGORIES, pnlCard: pnlCard, addCostForm: addCostForm };
});
