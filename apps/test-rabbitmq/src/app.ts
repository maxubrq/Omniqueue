import "@omniqueue/rabbitmq";
import { create, Broker } from '@omniqueue/core';
import { RabbitConfig } from "@omniqueue/rabbitmq";

async function produce(broker: Broker) {
    const queueToSend = process.env.QUEUE_TO_SEND || 'test-queue';
    let index = 0;
    while (true) {
        console.log(`Producing message to queue: ${queueToSend}`);
        // Ensure the queue exists before sending a message
        await broker.send(queueToSend, {
            id: 'test-message',
            body: JSON.stringify({
                index: index,
                timestamp: new Date().toISOString(),
                content: 'Hello, RabbitMQ!'
            }),
            headers: {}
        }, { ensure: true });
        await sleep(1000); // Wait for 1 second before sending the next message
        index++;
    }
}

async function consume(broker: Broker) {
    const queueToConsume = process.env.QUEUE_TO_CONSUME || 'test-queue';
    await broker.receive(queueToConsume, async (message) => {
        console.log(`Received message: ${JSON.stringify(message.body)}`);
        // Process the message here
        await message.ack();
    }, { group: 'test-group', ensure: true });
}

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('Starting RabbitMQ test application...');
    await sleep(10000); // Wait for RabbitMQ to be ready
    console.log('Connecting to RabbitMQ...');
    const rabbitmqUrl = process.env.RABBITMQ_URL || 'amqp://localhost:5672';
    const rabbitmq = await create<RabbitConfig>("rabbitmq", {
        url: rabbitmqUrl
    });

    const type = process.argv[2] || 'consume';
    console.log(`Running in ${type} mode...`);
    if (type === 'produce') {
        await produce(rabbitmq);
    } else {
        await consume(rabbitmq);
    }
}

main();