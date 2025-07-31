import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
    build: {
        lib: {
            entry: "src/index.ts",
            name: "OmniQueueKafka",
            formats: ["es", "cjs"]
        },
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
        rollupOptions: {
            external: [
                "node-rdkafka",
                "@omniqueue/core",
            ],
        }
    },
    plugins: [dts({ insertTypesEntry: true })]
});
