/* ====================================================================
 * OmniQueue – ZeroMQ adapter (Core vNext: mandatory group param)
 * Pattern used:
 *   • Publisher (PUSH)  → tcp://<host>:<basePort>.<topic>
 *   • Per-group worker (PULL) binds to tcp://.../<topic>.<group>
 *     allowing multiple worker sockets in same group (fair-queue).
 * ==================================================================== */
import {
   Broker,
   BrokerMessage,
   SendOptions,
   ConsumeOptions,
   register,
} from '@omniqueue/core';
import { Push, Pull } from 'zeromq';
import { ulid } from 'ulid';

/* ──────────────────────────────────────────────────────────────────
 * Config
 * ─────────────────────────────────────────────────────────────────*/
export interface ZmqConfig {
   /** Bind address template, default `tcp://127.0.0.1` (no port – added per topic) */
   bindBase?: string;
   /** Base TCP port (topic index is added), default 5000 */
   basePort?: number;
}

/* Helpers */
const endpointOf = (
   base: string,
   port: number,
   topic: string,
   group?: string,
) => `${base}:${port + hashTopic(topic)}${group ? `.${group}` : ''}`;

/* simple hash to spread topics across ports deterministically */
function hashTopic(t: string): number {
   let h = 0;
   for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) & 0xffff;
   return h % 200; // keep within +0…+199 port spread
}

/* ──────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ─────────────────────────────────────────────────────────────────*/
export class ZmqBroker implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'zeromq' as const;
   readonly config: any;

   private pushSockets: Map<string, Push> = new Map();

   constructor(private cfg: ZmqConfig) {
      this.config = cfg;
   }

   async init(): Promise<void> {
      /* nothing to do up-front (lazy sockets) */
   }

   /* ---------------- publish (PUSH) ------------------------------ */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      _opts: SendOptions = {},
   ): Promise<void> {
      let sock = this.pushSockets.get(topic);
      if (!sock) {
         const ep = endpointOf(
            this.cfg.bindBase ?? 'tcp://127.0.0.1',
            this.cfg.basePort ?? 5000,
            topic,
         );
         sock = new Push();
         sock.bind(ep).catch((e) => {
            console.error('[OmniQueue|ZMQ] bind failed', ep, e);
         });
         this.pushSockets.set(topic, sock);
      }

      await sock.send(
         JSON.stringify({ id: msg.id, body: msg.body, headers: msg.headers }),
      );
   }

   /* ---------------- subscribe (PULL) --------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      _opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId) throw new Error('`groupId` is mandatory');

      const pull = new Pull();
      const ep = endpointOf(
         this.cfg.bindBase ?? 'tcp://127.0.0.1',
         this.cfg.basePort ?? 5000,
         topic,
         groupId,
      );
      await pull.connect(ep);

      (async () => {
         for await (const [raw] of pull) {
            const parsed = JSON.parse(raw.toString());
            const brokerMsg: BrokerMessage = {
               id: parsed.id ?? ulid(),
               body: parsed.body,
               headers: parsed.headers ?? {},
               ack: async () => {
                  /* no-op */
               },
               nack: async () => {
                  /* no-op – no redelivery mechanism */
               },
            };
            try {
               await handler(brokerMsg);
            } catch (e) {
               console.error('[OmniQueue|ZMQ] handler error', e);
            }
         }
      })().catch((e) => console.error('[OmniQueue|ZMQ] loop error', e));
   }

   /* ---------------- teardown ----------------------------------- */
   async close(): Promise<void> {
      for (const s of this.pushSockets.values()) await s.close();
   }
}

/* ──────────────────────────────────────────────────────────────────
 * Self-registration
 * ─────────────────────────────────────────────────────────────────*/
register('zeromq', async (cfg: ZmqConfig) => {
   const broker = new ZmqBroker(cfg);
   await broker.init();
   return broker;
});
