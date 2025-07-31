import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
    build: {
        lib: {
            entry: "src/index.ts",
            name: "OmniQueueCore",
            formats: ["es", "cjs"]
        },
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
        rollupOptions: {
            external: [
                "amqplib",
                "@types/amqplib",
                "@omniqueue/core",
            ],
        }
    },
    plugins: [dts({ insertTypesEntry: true })],
});
