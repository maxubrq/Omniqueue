import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
    build: {
        lib: {
            entry: "src/index.ts",
            name: "OmniQueueCore",
            formats: ["es", "cjs", "umd"],
            fileName: (format) => `index.${format}.js`
        },
        outDir: "dist",
        emptyOutDir: true,
        target: "node18"
    },
    plugins: [dts({ insertTypesEntry: true })]
});
