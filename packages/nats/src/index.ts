/* ===================================================================
 * OmniQueue – NATS JetStream adapter (Core vNext: mandatory group,
 * generic ensure / createOptions)
 * =================================================================== */
import {
   Broker,
   BrokerMessage,
   ConsumeOptions,
   register,
   SendOptions,
} from '@omniqueue/core';
import {
   AckPolicy,
   connect,
   DeliverPolicy,
   DiscardPolicy,
   headers,
   JsMsg,
   NatsConnection,
   RetentionPolicy,
   StringCodec
} from 'nats';

/* ──────────────────────────────────────────────────────────────────
 * Config
 * ─────────────────────────────────────────────────────────────────*/
export interface NatsConfig {
   /** NATS server list, e.g. "nats://localhost:4222" or ["nats://…"] */
   servers: string | string[];
   /** Optional connection name (shows up in monitoring) */
   name?: string;
   /** JetStream domain (if using scoped JS) */
   jsDomain?: string;
   /** Stream defaults used when `ensure=true` */
   defaultStream?: {
      retention?: RetentionPolicy;
      maxMsgs?: number;
      maxBytes?: number;
      discard?: DiscardPolicy;
      numReplicas?: number;
   };
}

/* Helpers */
const sc = StringCodec();
const toStreamName = (topic: string) =>
   topic.replace(/[\.\*-]/g, '_').toUpperCase(); // "orders.created" → "ORDERS_CREATED"
const fullSubject = (topic: string) => topic;    // keep as-is

/* ──────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ─────────────────────────────────────────────────────────────────*/
export class NatsBroker
   implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'nats' as const;
   readonly config: any;

   private nc!: NatsConnection;          // raw connection

   constructor(private cfg: NatsConfig) {
      this.config = cfg;
   }

   /* ----- init (connect + JetStream mgr) ------------------------- */
   async init(): Promise<void> {
      this.nc = await connect({
         servers: this.cfg.servers,
         name: this.cfg.name ?? 'omniqueue-client',
      });
   }



   /* ----- publish ------------------------------------------------ */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      const js = this.nc.jetstream({ domain: this.cfg.jsDomain });

      /* ensure stream ------------------------------------------------*/
      if (opts.ensure) {
         const jsm = await this.nc.jetstreamManager({ domain: this.cfg.jsDomain });
         const stream = toStreamName(topic);
         try {
            await jsm.streams.info(stream);
         } catch {
            await jsm.streams.add({
               name: stream,
               subjects: [fullSubject(topic)],
               ...(opts.createOptions ?? this.cfg.defaultStream),
            });
         }
      }

      const messageHeaders = headers();
      if (opts.prio !== undefined) {
         messageHeaders.set('prio', String(opts.prio));
      }


      await js.publish(fullSubject(topic), sc.encode(JSON.stringify(msg.body)), {
         msgID: msg.id,                         // for de-dup
         headers: opts.prio !== undefined ? messageHeaders : undefined,
      });
   }

   /* ----- subscribe --------------------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId) throw new Error('`groupId` is required');

      /* ensure stream ------------------------------------------------*/
      const stream = toStreamName(topic);
      if (opts.ensure) {
         const jsm = await this.nc.jetstreamManager({ domain: this.cfg.jsDomain });
         try {
            await jsm.streams.info(stream);
         } catch {
            await jsm.streams.add({
               name: stream,
               subjects: [fullSubject(topic)],
               ...(opts.createOptions ?? this.cfg.defaultStream),
            });
         }
      }

      const js = this.nc.jetstream({ domain: this.cfg.jsDomain });

      /* consumer config: durable = group, queue = group ------------- */
      const durable = groupId;
      const sub = await js.subscribe(fullSubject(topic), {
         queue: groupId,
         config: {
            durable_name: durable,
            deliver_policy: DeliverPolicy.All,
            ack_policy: AckPolicy.Explicit,
         },
      });

      (async () => {
         for await (const jm of sub) {
            await this.handleJsMsg(jm, handler);
         }
      })().catch((e) => {
         console.error('[OmniQueue|NATS] subscription loop error', e);
      });
   }

   /* ----- helper: translate JsMsg → BrokerMessage ---------------- */
   private async handleJsMsg(
      jm: JsMsg,
      handler: (m: BrokerMessage) => Promise<void>,
   ) {
      const payload = jm.data.length ? JSON.parse(sc.decode(jm.data)) : null;
      const brokerMsg: BrokerMessage = {
         id: jm.info.streamSequence.toString(),
         body: payload,
         headers: jm.headers ? Object.fromEntries(jm.headers) : {},
         ack: async () => jm.ack(),
         nack: async (requeue = true) =>
            requeue ? jm.nak() : jm.term(),
      };

      try {
         await handler(brokerMsg);
         await brokerMsg.ack();
      } catch {
         await brokerMsg.nack(true);
      }
   }

   /* ----- lifecycle / teardown ---------------------------------- */
   async close(): Promise<void> {
      await this.nc.drain();
      await this.nc.close();
   }
}

/* ──────────────────────────────────────────────────────────────────
 * Self-registration
 * ─────────────────────────────────────────────────────────────────*/
register('nats', async (cfg: NatsConfig) => {
   const broker = new NatsBroker(cfg);
   await broker.init();
   return broker;
});
