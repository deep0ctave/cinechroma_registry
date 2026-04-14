import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: "https://cinechroma.avinashaldhapati.com",
  base: "/",
  vite: {
    plugins: [tailwindcss()]
  },
});
