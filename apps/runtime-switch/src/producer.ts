import { BrokerMessage } from "@omniqueue/core";
import { ulid } from 'ulid';
import { getProvider, providerFactory } from "./shared";

async function messageFactory(provider: string, count: number): Promise<Omit<BrokerMessage, "ack" | "nack"> | null> {
    const id = ulid();
    return {
        id,
        body: {
            provider,
            timestamp: Date.now(),
            message: `Message ${count} from provider ${provider}`,
        },
        headers: {
            'index': id,
            'provider': provider,
            'timestamp': Date.now().toString(),
        }
    };
}

export async function main() {
    try {
        const provider = getProvider();
        const broker = await providerFactory(provider);
        if (!broker) {
            throw new Error(`Failed to create broker for provider: ${provider}`);
        }

        let count = 0;
        while (true) {
            const message = await messageFactory(provider, count++);
            const queueToSend = process.env.OMNIQUEUE_QUEUE ?? "default";
            if (message) {
                await broker.send(queueToSend, message);
                console.log(`Sent message: ${JSON.stringify(message)}`);
            }
            await new Promise(resolve => setTimeout(resolve, 100)); // Wait for 100 milliseconds before sending the next message
        }
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}