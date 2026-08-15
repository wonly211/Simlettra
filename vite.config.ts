import { cloudflare } from '@cloudflare/vite-plugin'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

const wranglerConfigPath = process.env.SIMLETTRA_WRANGLER_CONFIG

export default defineConfig({
  plugins: [vue(), cloudflare(wranglerConfigPath ? { configPath: wranglerConfigPath } : {})],
})
