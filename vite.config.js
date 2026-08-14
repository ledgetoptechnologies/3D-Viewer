import { defineConfig } from 'vite'
export default defineConfig({
  server: {
    host: '0.0.0.0',
    port: 8080,
    fs: {
      allow: ['/mnt/Share/Ai_Storage', '/home/bkoltz']
    }
  },
  build: {
    target: 'esnext'
  }
})