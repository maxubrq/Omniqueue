import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
    build: {
        lib: {
            entry: "./src/index.ts",
            name: "OmniQueueRabbitMQ",
            formats: ["es", "cjs", "umd"],
            fileName: (format) => `index.${format}.js`
        },
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
        rollupOptions: {
            external: [
                "stompit",
                "@types/stompit",
                "@omniqueue/core",
            ],
        }
    },
    plugins: [dts({ insertTypesEntry: true , outDir: "dist/types" })],
});
