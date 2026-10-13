import { execSync } from 'node:child_process'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Stamped into the footer so users can find the exact source they are using.
const commit = process.env.GITHUB_SHA || execSync('git rev-parse HEAD').toString().trim()
const source = process.env.SOURCE_URL || 'https://github.com/inanimate-tech/token-monitor-multitenant-sync'

export default defineConfig({
  define: { __COMMIT__: JSON.stringify(commit), __SOURCE__: JSON.stringify(source) },
  plugins: [cloudflare({ viteEnvironment: { name: 'ssr' } }), tanstackStart(), viteReact()],
})
