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
const groupQueue = (base: string, group: string) => `oq.queue.${base}.${group}`;

function exchangeName(base: string): string {
   return `oq.exchange.${base}`;
}

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

   /* ---------------- fan‑out ------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      const _exchangeName = exchangeName(topic);
      await this.channel.assertExchange(_exchangeName, 'fanout', { durable: true });

      const ok = this.channel.publish(
         _exchangeName,
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
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      const _groupQueueName = groupQueue(topic, groupId);
      if (opts.ensure) {
         const _exchangeName = exchangeName(topic);
         await this.channel.assertExchange(_exchangeName, 'fanout', { durable: true });
         await this.channel.assertQueue(_groupQueueName, {
            durable: true,
            ...opts.createOptions,
         });
         await this.channel.bindQueue(_groupQueueName, _exchangeName, '');
      }

      await this.channel.consume(
         _groupQueueName,
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
