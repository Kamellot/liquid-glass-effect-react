import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/** Preserves the stylesheet side-effect import in the emitted `index.js` entry so consumers do not need a manual CSS import. */
function injectCssImport(): Plugin {
  return {
    name: 'inject-css-import',
    generateBundle(_options, bundle) {
      const entry = bundle['index.js']
      if (entry && entry.type === 'chunk') {
        entry.code = `import "./styles.css";\n${entry.code}`
        if (entry.map) {
          entry.map.mappings = `;${entry.map.mappings}`
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), injectCssImport()],
  publicDir: false,
  build: {
    outDir: 'dist/lib',
    emptyOutDir: true,
    sourcemap: true,
    lib: {
      entry: {
        index: resolve(__dirname, 'src/index.ts'),
      },
      formats: ['es'],
      cssFileName: 'styles',
    },
    cssCodeSplit: false,
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },
    },
  },
})
