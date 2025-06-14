import { defineConfig } from "vite";
import { readFileSync } from "node:fs";

const options = {
  key: readFileSync("./server/ssl/key.pem", "utf-8"),
  cert: readFileSync("./server/ssl/cert.pem", "utf-8"),
};

export default defineConfig({
  server: {
    https: {
      key: options.key,
      cert: options.cert,
    },
    port: 4173,
  },
});
