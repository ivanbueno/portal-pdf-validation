import { defineConfig } from "vite";
const page = (name) => new URL(name, import.meta.url).pathname;
export default defineConfig({
  build: {
    target: "es2022",
    rollupOptions: {
      input: { main: page("index.html") },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/health": "http://127.0.0.1:8000",
    },
  },
});
