import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base must match the GitHub Pages project path: asecuesu.github.io/recruit-coach-finder/
export default defineConfig({
  plugins: [react()],
  base: '/recruit-coach-finder/',
})
