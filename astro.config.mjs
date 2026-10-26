// @ts-check
import { defineConfig } from 'astro/config';

import svelte from '@astrojs/svelte';

import node from '@astrojs/node';
import basicSsl from '@vitejs/plugin-basic-ssl';

// https://astro.build/config
export default defineConfig({
  integrations: [svelte()],

  adapter: node({
    mode: 'standalone'
  }),

  // LAN_HTTPS=1: self-signed https so phones on the LAN get camera access (getUserMedia needs a secure context)
  vite: { plugins: process.env.LAN_HTTPS ? [basicSsl()] : [] },

  devToolbar: {
    enabled: false
  }
});