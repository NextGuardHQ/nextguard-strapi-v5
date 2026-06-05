# NextGuard — Strapi 5 Plugin

Monitors your installed Strapi packages for CVEs and security advisories.
Syncs daily to [nextguardhq.com](https://nextguardhq.com) automatically.

## Requirements

- Strapi **5.x**
- Node.js 18+
- NextGuard Starter plan (or higher)

## Installation

### Option A — npm package

```bash
npm install nextguard-strapi-plugin
```

Enable in `config/plugins.ts`:

```ts
export default {
  nextguard: { enabled: true },
};
```

### Option B — local plugin

Copy this folder to `src/plugins/nextguard/` in your Strapi 5 project and build:

```bash
cd src/plugins/nextguard
npm install
npm run build
```

Enable in `config/plugins.ts`:

```ts
export default {
  nextguard: {
    enabled: true,
    resolve: './src/plugins/nextguard',
  },
};
```

## Configuration

1. Go to **Settings → NextGuard** in the Strapi admin panel.
2. Enter your API key from [nextguardhq.com → Account → API Keys](https://nextguardhq.com/account).
3. Click **Get activation code**.
4. Open [nextguardhq.com → Account → Connected Devices](https://nextguardhq.com/account) and enter the code.
5. Done — first sync runs automatically.

## What gets synced

| Package type | Example |
|---|---|
| Strapi core | `@strapi/strapi` |
| Official plugins | `@strapi/plugin-users-permissions`, `@strapi/plugin-i18n` |
| Community plugins | `strapi-plugin-io` |
| Providers | `@strapi/provider-upload-aws-s3` |

## Build (for local plugin or publishing)

```bash
npm run build   # compiles TypeScript → dist/
npm run watch   # watch mode
```

The `dist/` folder contains the compiled JS and type declarations.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NEXTGUARD_HOST` | `https://nextguardhq.com` | Override API host |

## License

MIT
