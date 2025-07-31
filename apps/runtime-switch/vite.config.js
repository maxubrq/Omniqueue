import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
    build: {
        lib: {
            entry: "./src/index.ts",
            name: "OmniQueueKafka-RuntimeSwitch",
            formats: ["es", "cjs"],
            fileName: (format) => `index.${format}.js`
        },
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
        rollupOptions: {
            external: [
                "@omniqueue/core",
                "@omniqueue/kafka",
                "@omniqueue/rabbitmq",
                "amqplib",
                "kafkajs",
                "@types/amqplib",
                "./vite.config.js",
                './vitest.config.ts',
            ],
        },
    },
    plugins: [dts({ insertTypesEntry: true })]
});
