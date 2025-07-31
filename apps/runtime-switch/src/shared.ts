import { Broker, create } from "@omniqueue/core";
import "@omniqueue/kafka";
import { KafkaConfig } from "@omniqueue/kafka";
import "@omniqueue/rabbitmq";
import { RabbitConfig } from "@omniqueue/rabbitmq";

export function getProvider():string{
    return process.env.OMNIQUEUE_PROVIDER ?? "rabbitmq";
}

export async function providerFactory(provider: string): Promise<Broker | null> {
    switch (provider) {
        case "rabbitmq": {
            const broker = await create<RabbitConfig>("rabbitmq", {
                url: process.env.OMNIQUEUE_RABBITMQ_URL ?? "amqp://localhost",
            });
            return broker;
        }
        case "kafka":
            {
                const broker = await create<KafkaConfig>("kafka", {
                    brokers: process.env.OMNIQUEUE_KAFKA_BROKERS?.split(",") ?? ["localhost:9092"],
                });
                return broker;
            }
        default:
            return null;
    }
}