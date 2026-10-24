import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // hap-nodejs + SRP pairing are CPU-heavy; keep files serial.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
