/* ====================================================================
 * OmniQueue – ActiveMQ adapter (Core vNext: mandatory group,
 * generic ensure / createOptions)
 * ==================================================================== */
import {
   Broker,
   BrokerMessage,
   SendOptions,
   ConsumeOptions,
   register,
} from '@omniqueue/core';
import stompit, {
   Client,
} from 'stompit';
import { ulid } from 'ulid';

/* ──────────────────────────────────────────────────────────────────
 * Config
 * ─────────────────────────────────────────────────────────────────*/
export interface ActiveMQConfig {
   /** Broker host (default “localhost”) */
   host: string;
   /** STOMP port (default 61613) */
   port?: number;
   /** Login credentials etc. */
   connectHeaders?: any;
   /** Prefetch / in-flight limit (default 10) */
   prefetch?: number;
}

/* Build a STOMP connect object */
const mkConnectOpts = (c: ActiveMQConfig) => ({
   host: c.host,
   port: c.port ?? 61613,
   connectHeaders: {
      host: '/',
      login: 'guest',
      passcode: 'guest',
      'accept-version': '1.2',
      ...c.connectHeaders,
   },
});

/* Virtual-Topic helpers */
const vtTopic = (t: string) => `/topic/VirtualTopic.${t}`;
const vtQueue = (t: string, g: string) =>
   `/queue/Consumer.${g}.VirtualTopic.${t}`;

/* map prio 0-9 → STOMP priority header */
const prioHdr = (p?: number) =>
   p !== undefined ? { priority: String(Math.max(0, Math.min(p, 9))) } : {};

/* ──────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ─────────────────────────────────────────────────────────────────*/
export class ActiveMQBroker
   implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'activemq' as const;
   readonly config: any;

   private prodConn!: Client;          // producer connection

   constructor(private cfg: ActiveMQConfig) {
      this.config = cfg;
   }

   /* ----- init (single producer connection) ---------------------- */
   async init(): Promise<void> {
      this.prodConn = await new Promise<Client>((res, rej) =>
         stompit.connect(mkConnectOpts(this.cfg), (err, client) =>
            err ? rej(err) : res(client),
         ),
      );
   }

   /* ----- publish (fan-out via VirtualTopic) ---------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      // ActiveMQ auto-creates VirtualTopic destinations → ensure/createOptions no-op
      const frame = this.prodConn.send({
         destination: vtTopic(topic),
         'content-type': 'application/json',
         messageId: msg.id,
         ...prioHdr(opts.prio),
         headers: msg.headers,
      });

      frame.write(JSON.stringify(msg.body));
      frame.end();
   }

   /* ----- subscribe (group queue) -------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId)
         throw new Error('`groupId` is mandatory (unit of work-sharing)');

      const conn: Client = await new Promise((res, rej) =>
         stompit.connect(mkConnectOpts(this.cfg), (err, client) =>
            err ? rej(err) : res(client),
         ),
      );

      const headers = {
         destination: vtQueue(topic, groupId),
         ack: 'client-individual',
         'prefetch-count': String(this.config?.prefetch ?? this.cfg.prefetch ?? 10),
      };

      conn.subscribe(headers, (err, raw: any) => {
         if (err) {
            console.error('[OmniQueue|ActiveMQ] subscribe error', err);
            return;
         }

         raw.readString('utf-8', async (readErr: any, body: any) => {
            if (readErr) {
               console.error('[OmniQueue|ActiveMQ] read error', readErr);
               conn.nack(raw);
               return;
            }

            const brokerMsg: BrokerMessage = {
               id: raw.headers['message-id'] ?? ulid(),
               body: JSON.parse(body),
               headers: raw.headers as Record<string, any>,
               ack: async () => conn.ack(raw),
               nack: async (requeue = true) =>
                  requeue ? conn.nack(raw) : conn.ack(raw),
            };

            try {
               await handler(brokerMsg);
               await brokerMsg.ack();
            } catch {
               await brokerMsg.nack(true);
            }
         });
      });
   }

   /* ----- lifecycle / teardown ----------------------------------- */
   async close(): Promise<void> {
      try {
         this.prodConn?.disconnect();
      } catch {/* ignore */ }
   }
}

/* ──────────────────────────────────────────────────────────────────
 * Self-registration
 * ─────────────────────────────────────────────────────────────────*/
register('activemq', async (cfg: ActiveMQConfig) => {
   const broker = new ActiveMQBroker(cfg);
   await broker.init();
   return broker;
});
