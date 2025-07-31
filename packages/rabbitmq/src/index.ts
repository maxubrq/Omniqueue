/* ====================================================================
 * OmniQueue – RabbitMQ adapter (aligned with Core vNext: mandatory group,
 * generic ensure / createOptions)
 * ==================================================================== */
import {
   Broker,
   BrokerMessage,
   ConsumeOptions,
   register,
   SendOptions,
} from '@omniqueue/core';
import {
   Channel,
   ChannelModel,
   connect,
   ConsumeMessage,
   Options,
} from 'amqplib';

// ──────────────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────────────
export interface RabbitConfig {
   /** AMQP URL, e.g. "amqp://user:pass@localhost:5672" */
   url: string;
   /** Channel prefetch (QoS). Default 10 */
   prefetch?: number;
   /** Pre‑declare exchanges (optional) */
   exchanges?: Record<
      string,
      { type: 'fanout' | 'direct' | 'topic'; options?: Options.AssertExchange }
   >;
}

// Default queue properties (can be overridden via createOptions)
const defaultQueueOpts: Options.AssertQueue = {
   durable: true,
   arguments: {},
};

// Resolve queue name based on logical group
const groupQueue = (base: string, group: string) => `${base}.${group}`;

// ──────────────────────────────────────────────────────────────────────
// Adapter implementation
// ──────────────────────────────────────────────────────────────────────
export class RabbitBroker implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'rabbitmq' as const;
   readonly config: any;
   
   private conn!: ChannelModel;
   private channel!: Channel;

   constructor(private cfg: RabbitConfig) {
        this.config = cfg;
   }

   async init() {
      this.conn = await connect(this.cfg.url);
      this.channel = await this.conn.createChannel();
      await this.channel.prefetch(this.cfg.prefetch ?? 10);

      // Pre‑declare configured exchanges
      for (const [name, meta] of Object.entries(this.cfg.exchanges ?? {})) {
         await this.channel.assertExchange(name, meta.type, meta.options ?? {});
      }
   }

   /* -------------- point‑to‑point -------------- */
   async send(
      queue: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      if (opts.ensure) {
         await this.channel.assertQueue(queue, {
            ...defaultQueueOpts,
            ...opts.createOptions,
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
      if (!ok) await new Promise((r) => this.channel.once('drain', r));
   }

   async receive(
      queue: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts: ConsumeOptions,
   ): Promise<void> {
      const queueName = groupQueue(queue, opts.group);

      if (opts.ensure) {
         await this.channel.assertQueue(queueName, {
            ...defaultQueueOpts,
            ...opts.createOptions,
         });
      }

      await this.channel.consume(
         queueName,
         async (raw: ConsumeMessage | null) => {
            if (!raw) return; // consumer cancelled
            const brokerMsg: BrokerMessage = {
               id:
                  raw.properties.messageId || raw.fields.deliveryTag.toString(),
               body: JSON.parse(raw.content.toString()),
               headers: raw.properties.headers ?? {},
               ack: async () => this.channel.ack(raw),
               nack: async (requeue = true) =>
                  this.channel.nack(raw, false, requeue),
            };
            try {
               await handler(brokerMsg);
            } catch {
               await brokerMsg.nack(true);
            }
         },
      );
   }

   /* ---------------- fan‑out ------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      // Fan‑out exchange (durable)
      await this.channel.assertExchange(topic, 'fanout', { durable: true });

      const ok = this.channel.publish(
         topic,
         '',
         Buffer.from(JSON.stringify(msg.body)),
         {
            messageId: msg.id,
            priority: opts.prio,
            headers: msg.headers,
         },
      );
      if (!ok) await new Promise((r) => this.channel.once('drain', r));
   }

   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts: ConsumeOptions,
   ): Promise<void> {
      await this.channel.assertExchange(topic, 'fanout', { durable: true });

      const queueName = groupQueue(topic, opts.group);
      await this.channel.assertQueue(queueName, {
         durable: true,
         ...opts.createOptions,
      });
      await this.channel.bindQueue(queueName, topic, '');

      await this.channel.consume(
         queueName,
         async (raw: ConsumeMessage | null) => {
            if (!raw) return;
            const brokerMsg: BrokerMessage = {
               id:
                  raw.properties.messageId || raw.fields.deliveryTag.toString(),
               body: JSON.parse(raw.content.toString()),
               headers: raw.properties.headers ?? {},
               ack: async () => this.channel.ack(raw),
               nack: async (requeue = true) =>
                  this.channel.nack(raw, false, requeue),
            };
            try {
               await handler(brokerMsg);
            } catch {
               await brokerMsg.nack(true);
            }
         },
      );
   }

   /* -------- lifecycle / teardown ------ */
   async close(): Promise<void> {
      await this.channel.close();
      await this.conn.close();
   }
}

// ──────────────────────────────────────────────────────────────────────
// Self‑registration
// ──────────────────────────────────────────────────────────────────────
register('rabbitmq', async (cfg: RabbitConfig) => {
   const broker = new RabbitBroker(cfg);
   await (broker as any).init();
   return broker;
});
