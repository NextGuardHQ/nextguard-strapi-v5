import type { Core } from '@strapi/strapi';

const settings = ({ strapi }: { strapi: Core.Strapi }) => ({

  async getSettings(ctx: any) {
    const svc = strapi.plugin('nextguard').service<any>('nextguard');
    const cfg = await svc.getConfig();
    ctx.body = {
      connected  : !!(cfg.token && cfg.projectId),
      projectId  : cfg.projectId,
      projectName: cfg.projectName,
      lastSync   : cfg.lastSync,
    };
  },

  async requestCode(ctx: any) {
    const { apiKey } = ctx.request.body as { apiKey?: string };
    if (!apiKey?.trim()) return ctx.badRequest('API key is required');
    try {
      const svc  = strapi.plugin('nextguard').service<any>('nextguard');
      ctx.body   = await svc.requestActivationCode(apiKey.trim());
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async pollStatus(ctx: any) {
    const { code, apiKey } = ctx.query as { code?: string; apiKey?: string };
    if (!code || !apiKey) return ctx.badRequest('code and apiKey are required');
    try {
      const svc    = strapi.plugin('nextguard').service<any>('nextguard');
      const result = await svc.pollActivationStatus(code, apiKey);
      if (result.status === 'authorized') {
        await svc.saveConfig({ token: result.token, projectId: result.projectId, projectName: result.projectName });
        svc.sync().catch(() => {});
      }
      ctx.body = { status: result.status };
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async manualSync(ctx: any) {
    try {
      const svc = strapi.plugin('nextguard').service<any>('nextguard');
      ctx.body  = await svc.sync();
    } catch (err: any) {
      return ctx.badRequest(err.message);
    }
  },

  async disconnect(ctx: any) {
    const svc = strapi.plugin('nextguard').service<any>('nextguard');
    await svc.disconnect();
    ctx.body = { success: true };
  },
});

export default settings;
