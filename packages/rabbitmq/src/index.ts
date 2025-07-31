/* ====================================================================
 * OmniQueue – RabbitMQ adapter
 * ==================================================================== */
import {
    Broker,
    BrokerFactory,
    BrokerMessage,
    register,
    SendOptions,
} from "@omniqueue/core";
import {
    Channel,
    ChannelModel,
    connect,
    ConsumeMessage,
    Options
} from "amqplib";


/**
 * Configuration for RabbitMQ broker.
 * This includes the AMQP URL, channel prefetch settings,
 * and optional exchange declarations for publish/subscribe patterns.
 */
export interface RabbitConfig {
    /** AMQP URL, e.g. "amqp://user:pass@localhost:5672" */
    url: string;
    /** Channel prefetch (QoS). Default 10 */
    prefetch?: number;
    /** Assert exchanges for publish/subscribe beforehand (optional) */
    exchanges?: Record<
        string,
        { type: "fanout" | "direct" | "topic"; options?: Options.AssertExchange }
    >;
}

// Default assert options for newly created queues
const defaultQueueOpts: Options.AssertQueue = {
    durable: true,
    arguments: {},
};

// ──────────────────────────────────────────────────────────────────────
// Adapter implementation
// ──────────────────────────────────────────────────────────────────────
export class RabbitBroker implements Broker {
    readonly provider = "rabbitmq" as const;

    private conn!: ChannelModel;
    private channel!: Channel;

    constructor(private cfg: RabbitConfig) { }

    /* Init is executed by the factory wrapper */
    async init() {
        this.conn = await connect(this.cfg.url);
        this.channel = await this.conn.createChannel();
        await this.channel.prefetch(this.cfg.prefetch ?? 10);

        // Pre‑declare exchanges if requested
        for (const [name, meta] of Object.entries(this.cfg.exchanges ?? {})) {
            await this.channel.assertExchange(name, meta.type, meta.options ?? {});
        }
    }

    /* -------------- point‑to‑point -------------- */
    async send(
        queue: string,
        msg: Omit<BrokerMessage, "ack" | "nack">,
        opts: SendOptions = {},
    ): Promise<void> {
        if (opts.ensureQueue) {
            await this.channel.assertQueue(queue, {
                ...defaultQueueOpts,
                ...opts.createQueueOptions,
            });
        }
        const ok = this.channel.sendToQueue(
            queue,
            Buffer.from(JSON.stringify(msg.body)),
            {
                messageId: msg.id,
                priority: opts.prio,
                headers: msg.headers,
            },
        );
        if (!ok) await new Promise(r => this.channel.once("drain", r));
    }

    async receive(
        queue: string,
        handler: (m: BrokerMessage) => Promise<void>,
        opts: SendOptions = {},
    ): Promise<void> {
        if (opts.ensureQueue) {
            await this.channel.assertQueue(queue, {
                ...defaultQueueOpts,
                ...opts.createQueueOptions,
            });
        }

        await this.channel.consume(queue, async (raw: ConsumeMessage | null) => {
            if (!raw) return; // Consumer cancelled

            const brokerMsg: BrokerMessage = {
                id: raw.properties.messageId || raw.fields.deliveryTag.toString(),
                body: JSON.parse(raw.content.toString()),
                headers: raw.properties.headers ?? {},
                ack: async () => this.channel.ack(raw),
                nack: async (requeue = true) => this.channel.nack(raw, false, requeue),
            };

            try {
                await handler(brokerMsg);
            } catch (err) {
                await brokerMsg.nack(true);
            }
        });
    }

    /* ---------------- fan‑out ------------------- */
    async publish(
        topic: string,
        msg: Omit<BrokerMessage, "ack" | "nack">,
        opts: SendOptions = {},
    ): Promise<void> {
        // fanout exchange; one exchange per topic
        await this.channel.assertExchange(topic, "fanout", { durable: true });

        const ok = this.channel.publish(
            topic,
            "",
            Buffer.from(JSON.stringify(msg.body)),
            {
                messageId: msg.id,
                priority: opts.prio,
                headers: msg.headers,
            },
        );
        if (!ok) await new Promise(r => this.channel.once("drain", r));
    }

    async subscribe(
        topic: string,
        handler: (m: BrokerMessage) => Promise<void>,
        opts: SendOptions = {},
    ): Promise<void> {
        // Ensure exchange exists
        await this.channel.assertExchange(topic, "fanout", { durable: true });

        // Auto‑generated, exclusive queue per subscriber by default
        const q = await this.channel.assertQueue("", {
            exclusive: true,
            durable: false,
        });
        await this.channel.bindQueue(q.queue, topic, "");

        await this.channel.consume(q.queue, async (raw: ConsumeMessage | null) => {
            if (!raw) return;
            
            const brokerMsg: BrokerMessage = {
                id: raw.properties.messageId || raw.fields.deliveryTag.toString(),
                body: JSON.parse(raw.content.toString()),
                headers: raw.properties.headers ?? {},
                ack: async () => this.channel.ack(raw),
                nack: async (requeue = true) => this.channel.nack(raw, false, requeue),
            };

            try {
                await handler(brokerMsg);
            } catch (err) {
                await brokerMsg.nack(true);
            }
        });
    }

    /* -------- lifecycle / teardown ------ */
    async close(): Promise<void> {
        await this.channel.close();
        await this.conn.close();
    }
}

const rabbitMQFactory: BrokerFactory = async (cfg: RabbitConfig) => {
    const broker = new RabbitBroker(cfg);
    await broker.init();
    return broker;
}

// ──────────────────────────────────────────────────────────────────────
// Self‑registration
// ──────────────────────────────────────────────────────────────────────
register("rabbitmq", rabbitMQFactory);