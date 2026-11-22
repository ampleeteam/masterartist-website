/* Case controls for the same screen as the chat. No separate cases page. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MaCase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  var STAGES = ['enquired', 'interested', 'enrolled', 'paid', 'attended', 'cancelled'];

  function renderCase(o) {
    var c = o || {};
    var staff = (c.staff || []).map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === c.assigned_to ? ' selected' : '') + '>' + esc(s.full_name) + '</option>';
    }).join('');
    var stages = STAGES.map(function (stage) {
      return '<option value="' + stage + '"' + (c.stage === stage ? ' selected' : '') + '>' + esc(stage) + '</option>';
    }).join('');
    var tasks = (c.tasks || []).map(function (t) {
      return '<li>' + esc(t.title) + (t.due_on ? ' · ' + esc(t.due_on) : '') + '</li>';
    }).join('');
    return '<section class="case-panel">'
      + '<p class="ix-kicker">This chat</p>'
      + '<div class="f"><label>Status</label><select id="caseStatus">'
      + ['open', 'pending', 'closed'].map(function (s) {
        return '<option value="' + s + '"' + (c.status === s ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select></div>'
      + '<div class="f"><label>Priority</label><select id="casePriority">'
      + ['low', 'normal', 'high'].map(function (s) {
        return '<option value="' + s + '"' + (c.priority === s ? ' selected' : '') + '>' + s + '</option>';
      }).join('') + '</select></div>'
      + '<div class="f"><label>Assigned to</label><select id="caseAssignee"><option value="">Unassigned</option>' + staff + '</select></div>'
      + '<div class="f"><label>Tags</label><input id="caseTags" value="' + esc((c.tags || []).join(', ')) + '"></div>'
      + '<div class="f"><label>Event</label><p class="help">' + esc(c.sessionTitle || 'No session linked yet') + '</p>'
      + '<select id="caseStage"><option value="">Stage</option>' + stages + '</select></div>'
      + '<p><b>Follow-ups</b></p>' + (tasks ? '<ul>' + tasks + '</ul>' : '<p class="help">No open tasks on this chat.</p>')
      + '<div class="f"><label>Add a follow-up</label><input id="caseTask" placeholder="Call tomorrow"></div>'
      + '<div class="f"><label>Internal note</label><textarea id="caseNote" rows="3" placeholder="Only the team sees this."></textarea></div>'
      + '<p><button type="button" class="ix-btn primary" onclick="caseSave()">Save case</button></p>'
      + '</section>';
  }

  return { esc: esc, STAGES: STAGES, renderCase: renderCase };
});
