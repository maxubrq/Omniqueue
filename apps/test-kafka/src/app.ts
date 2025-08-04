import "@omniqueue/kafka";
import { Broker, BrokerMessage, create } from "@omniqueue/core";
import { KafkaConfig } from "@omniqueue/kafka";

function genMessage(id: number = 0): Omit<BrokerMessage, 'ack' | 'nack'> {
    return {
        body: {
            id: id,
            text: `Message ${id}`,
        },
        headers: {},
        id: id.toString(),
    };
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function publishMessage(broker: Broker) {
    let id = 0;
    const topic = process.env.TOPIC || "test-topic";
    while (true) {
        try {
            const msg = genMessage(id++);
            await broker.publish(topic, msg);
            console.log(`Published message: ${JSON.stringify(msg.body)} -- ID: ${msg.id}`);
            // Sleep for a second before publishing the next message
            await sleep(1000); // Publish every second
        } catch (err) {
            console.error('Error in publishing message:', err);
            process.exit(1);
        }
    }
}

async function consumeMessages(broker: Broker) {
    const topic = process.env.TOPIC || "test-topic";
    const groupId = process.env.GROUP_ID || "test-group";
    const consumerId = process.env.CONSUMER_ID || "consumer1";
    console.log(`Subscribing to topic: ${topic} with group ID: ${groupId}`);
    await broker.subscribe(topic, async (msg: BrokerMessage) => {
        console.log(`Received message: ${JSON.stringify(msg.body)} -- ID: ${msg.id} -- Consumer: ${consumerId}`);
        // Acknowledge the message
        await msg.ack();
    }, groupId, {});
    console.log(`Subscribed to topic: ${topic} with group ID: ${groupId}`);
}

async function main() {
    await sleep(10_000); // Ensure broker is ready
    const type = process.env.APP_TYPE || 'produce';
    const brokers = (process.env.BROKERS || 'localhost:9092').split(',').map(b => b.trim());
    const broker = await create<KafkaConfig>('kafka', {
        brokers: brokers,
        clientId: process.env.CLIENT_ID || 'test-client',
        defaultTopic: {
            numPartitions: 10,
            replicationFactor: 1,
        },
        consumerConfig: {
            "allow.auto.create.topics": true,
        },
        producerConfig: {
            "allow.auto.create.topics": true,
        }
    });

    console.log(`Starting Kafka app in ${type} mode with brokers: ${brokers.join(', ')}`);
    if (type === 'produce') {
        publishMessage(broker);
    } else {
        consumeMessages(broker);
    }
}

main();