import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

const isCloudflare = process.env.CF_PAGES === '1';

let adapter;
if (isCloudflare) {
  const mod = await import('@astrojs/cloudflare');
  adapter = mod.default();
} else {
  const mod = await import('@astrojs/node');
  adapter = mod.default({ mode: 'standalone' });
}

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: adapter,
  vite: {
    plugins: [tailwindcss()]
  }
});