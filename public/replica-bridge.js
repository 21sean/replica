/* Replica preview bridge: injected into preview HTML so runtime errors in
   generated apps surface in the workspace, where the agent can fix them.
   Reports to the parent frame only; does nothing when opened directly. */
(function () {
  'use strict';
  if (window === window.parent) return;

  function report(message, source, line) {
    try {
      window.parent.postMessage({
        replica: 'preview-error',
        message: String(message || 'Script error').slice(0, 500),
        source: String(source || '').split('/').pop().slice(0, 120),
        line: line || 0,
      }, '*');
    } catch (e) { /* parent gone */ }
  }

  window.addEventListener('error', function (e) {
    report(e.message || (e.error && e.error.message), e.filename, e.lineno);
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    report('Unhandled promise rejection: ' + (r && r.message ? r.message : String(r)), '', 0);
  });
})();
