import { getProvider, providerFactory } from "./shared";

export async function main() {
    try {
        const provider = getProvider();
        const broker = await providerFactory(provider);
        if (!broker) {
            throw new Error(`Failed to create broker for provider: ${provider}`);
        }

        const queueToReceive = process.env.OMNIQUEUE_QUEUE ?? "default";
        const group = process.env.OMNIQUEUE_GROUP ?? "default";
        console.log(`Listening for messages on queue: ${queueToReceive}; group: ${group}`);
        broker.receive(queueToReceive, async (message) => {
            console.log(`Received message: ${JSON.stringify(message)}`);
        }, { group });
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
}