import type { Core } from '@strapi/strapi';
import controllers from './controllers';
import services    from './services';
import adminRoutes from './routes/admin';

export default {
  controllers,
  services,
  routes: { admin: adminRoutes },

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    // Daily cron at 02:00 UTC
    strapi.cron.add({
      '0 2 * * *': async () => {
        await (strapi.plugin('nextguard').service<any>('nextguard')).syncIfConfigured();
      },
    });

    // First sync 10 s after boot
    setTimeout(() => {
      (strapi.plugin('nextguard').service<any>('nextguard')).syncIfConfigured();
    }, 10_000);
  },
};
