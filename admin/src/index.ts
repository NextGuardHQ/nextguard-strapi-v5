import type { StrapiApp } from '@strapi/admin/strapi-admin';
import Settings from './pages/Settings';

export default {
  register(app: StrapiApp) {
    app.addSettingsLink('global', {
      intlLabel: {
        id            : 'nextguard.plugin.name',
        defaultMessage: 'NextGuard',
      },
      id        : 'nextguard',
      to        : '/settings/nextguard',
      Component : Settings,
      permissions: [],
    });
  },
};
