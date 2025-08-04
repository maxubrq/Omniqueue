/* ====================================================================
 * OmniQueue – Apache Pulsar adapter  (Core v1.0.0)
 *   • topic  → Pulsar topic
 *   • group  → Pulsar Subscription (type = SHARED)
 * ==================================================================== */
import {
   Broker,
   BrokerMessage,
   ConsumeOptions,
   register,
   SendOptions,
} from '@omniqueue/core';
import Pulsar, {
   Client,
   ClientConfig,
   Consumer,
   ConsumerConfig,
   Message,
   Producer,
   ProducerConfig
} from 'pulsar-client';

/* ────────────────────────────────────────────────────────────────
 * Config
 * ────────────────────────────────────────────────────────────────*/
export interface PulsarConfig {
   /** Pulsar service URL, e.g. 'pulsar://localhost:6650' */
   serviceUrl: string;
   /** Optional … auth, TLS, etc.—passed straight through */
   client?: Partial<ClientConfig>;
   /** Producer defaults */
   producer?: Partial<ProducerConfig>;
   /** Max concurrent messages per consumer (default 100) */
   receiverQueueSize?: number;
}

/* ────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ────────────────────────────────────────────────────────────────*/
export class PulsarBroker
   implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'pulsar' as const;
   readonly config: any;

   private client!: Client;
   private producers = new Map<string, Producer>();
   private consumers: Consumer[] = [];

   constructor(private cfg: PulsarConfig) { this.config = cfg; }

   /* ---------------- init -------------------------------------- */
   async init() {
      this.client = new Pulsar.Client({
         serviceUrl: this.cfg.serviceUrl,
         ...this.cfg.client,
      });
   }

   /* ---------------- publish ----------------------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      let prod = this.producers.get(topic);
      if (!prod) {
         prod = await this.client.createProducer({
            topic,
            sendTimeoutMs: 30_000,
            ...this.cfg.producer,
         });
         this.producers.set(topic, prod);
      }

      await prod.send({
         data: Buffer.from(JSON.stringify(msg.body)),
         properties: { ...msg.headers, id: msg.id },
         ...(opts.prio !== undefined ? { sequenceId: opts.prio } : {}),
      });
   }

   /* ---------------- subscribe --------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId) throw new Error('`groupId` is mandatory');

      const consumer = await this.client.subscribe({
         topic,
         subscription: groupId,
         subscriptionType: "Shared",   // work-sharing inside group
         receiverQueueSize: this.cfg.receiverQueueSize ?? 100,
      } as ConsumerConfig);

      this.consumers.push(consumer);

      (async () => {
         while (true) {
            const raw: Message = await consumer.receive();
            const payload = JSON.parse(raw.getData().toString());
            const brokerMsg: BrokerMessage = {
               id: raw.getProperties()['id'] ?? raw.getMessageId().toString(),
               body: payload,
               headers: raw.getProperties(),
               ack: async () => { consumer.acknowledge(raw) },
               nack: async () => consumer.negativeAcknowledge(raw),
            };

            try {
               await handler(brokerMsg);
               await brokerMsg.ack();
            } catch {
               await brokerMsg.nack();
            }
         }
      })().catch((e) =>
         console.error('[OmniQueue|Pulsar] consumer loop error', e),
      );
   }

   /* ---------------- teardown ---------------------------------- */
   async close(): Promise<void> {
      await Promise.all(this.consumers.map((c) => c.close()));
      await Promise.all([...this.producers.values()].map((p) => p.close()));
      await this.client.close();
   }
}

/* ────────────────────────────────────────────────────────────────
 * Self-registration
 * ────────────────────────────────────────────────────────────────*/
register('pulsar', async (cfg: PulsarConfig) => {
   const broker = new PulsarBroker(cfg);
   await broker.init();
   return broker;
});
