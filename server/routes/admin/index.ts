export default {
  type  : 'admin',
  routes: [
    { method: 'GET',  path: '/settings',    handler: 'settings.getSettings', config: { policies: [] } },
    { method: 'POST', path: '/request-code',handler: 'settings.requestCode', config: { policies: [] } },
    { method: 'GET',  path: '/poll-status', handler: 'settings.pollStatus',  config: { policies: [] } },
    { method: 'POST', path: '/sync',        handler: 'settings.manualSync',  config: { policies: [] } },
    { method: 'POST', path: '/disconnect',  handler: 'settings.disconnect',  config: { policies: [] } },
  ],
};
