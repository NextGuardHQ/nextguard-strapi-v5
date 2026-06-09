export default {
  type  : 'admin',
  routes: [
    { method: 'GET',  path: '/settings',    handler: 'settings.getSettings', config: { policies: ['admin::isAuthenticatedAdmin'] } },
    { method: 'GET',  path: '/plans',       handler: 'settings.getPlans',    config: { policies: ['admin::isAuthenticatedAdmin'] } },
    { method: 'POST', path: '/request-code',handler: 'settings.requestCode', config: { policies: ['admin::isAuthenticatedAdmin'] } },
    { method: 'GET',  path: '/poll-status', handler: 'settings.pollStatus',  config: { policies: ['admin::isAuthenticatedAdmin'] } },
    { method: 'POST', path: '/sync',        handler: 'settings.manualSync',  config: { policies: ['admin::isAuthenticatedAdmin'] } },
    { method: 'POST', path: '/disconnect',  handler: 'settings.disconnect',  config: { policies: ['admin::isAuthenticatedAdmin'] } },
  ],
};
