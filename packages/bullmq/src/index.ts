/* ====================================================================
 * OmniQueue – BullMQ adapter  (Core vNext: mandatory group,
 * generic ensure / createOptions)
 *
 * Mapping strategy
 * ────────────────
 * publish(topic)  →   push a Job to queue  "<topic>:<group>"
 * subscribe(group) →  Worker consumes that queue; concurrency = opts.prefetch
 *
 * Every *group* receives its own copy (separate queue).  Within the group
 * BullMQ’s fair scheduler makes sure only one worker handles a job at a time.
 * ==================================================================== */

import {
   Broker,
   BrokerMessage,
   SendOptions,
   ConsumeOptions,
   register,
} from '@omniqueue/core';
import {
   Queue,
   Worker,
   Job,
   QueueOptions,
   WorkerOptions,
   JobsOptions,
   ConnectionOptions,
} from 'bullmq';
import { ulid } from 'ulid';

/* ──────────────────────────────────────────────────────────────────
 * Config
 * ─────────────────────────────────────────────────────────────────*/
export interface BullConfig {
   /** ioredis-compatible connection options or redis:// url */
   connection: ConnectionOptions;
   /** Default queue options used when `ensure=true` & no createOptions */
   defaultQueue?: Partial<QueueOptions>;
   /** Default worker concurrency (prefetch). Default 10 */
   defaultConcurrency?: number;
}

/* Helpers */
const queueName = (topic: string, group: string) => `oq:${topic}:${group}`;

/* ──────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ─────────────────────────────────────────────────────────────────*/
export class BullBroker implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'bullmq' as const;
   readonly config: any;

   private queues: Map<string, Queue> = new Map();
   private workers: Set<Worker> = new Set();

   constructor(private cfg: BullConfig) {
      this.config = cfg;
   }

   async init(): Promise<void> {
      /* Lazy resource creation; nothing up-front */
   }

   /* ---------------- publish ------------------------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      // Fan-out: push into every known/ensured group queue
      // If `ensure` = true with createOptions.groupNames[], publish to all listed
      // else we assume caller passes groupName via opts.createOptions.groupName
      // For simplicity, if ensure=false we can't know groups, so we require ensure
      const groups: string[] | undefined = (opts.createOptions as any)
         ?.groupNames;
      if (!opts.ensure || !groups?.length) {
         throw new Error(
            'BullMQ adapter requires ensure=true and createOptions.groupNames = string[]',
         );
      }

      for (const group of groups) {
         const q = await this.getOrCreateQueue(
            topic,
            group,
            opts.createOptions,
         );
         const jobOpts: JobsOptions = {
            priority: opts.prio,
            jobId: msg.id, // dedupe if you enabled jobId enforcement
         };
         await q.add(topic, msg, jobOpts);
      }
   }

   /* ---------------- subscribe ----------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId) throw new Error('`groupId` is mandatory');

      const q = await this.getOrCreateQueue(topic, groupId, opts.createOptions);

      const worker = new Worker(
         q.name,
         async (job: Job) => {
            const id = (job.id as string) ?? ulid();
            // Create a BrokerMessage from the job data
            const brokerMsg: BrokerMessage = {
               id: id,
               body: job.data.body ?? job.data,
               headers: job.data.headers ?? {},
               ack: async () => {
                  // BullMQ auto-acks on successful handler return
                  // explicit remove to free storage
                  await job.remove();
               },
               nack: async (requeue = true) => {
                  // Move to failed; if requeue true, retry later
                  if (requeue) await job.retry();
                  else await job.moveToFailed(new Error('nack'), id, true);
               },
            };
            try {
               await handler(brokerMsg);
            } catch (e) {
               await brokerMsg.nack(true);
            }
         },
         {
            connection: this.cfg.connection,
            concurrency:
               (opts as any)?.concurrency ?? this.cfg.defaultConcurrency ?? 10,
         } as WorkerOptions,
      );

      worker.on('failed', (job, err) =>
         console.error(`[OmniQueue|BullMQ] job ${job?.id} failed:`, err),
      );

      this.workers.add(worker);
   }

   /* ---------------- lifecycle / teardown ----------------------- */
   async close(): Promise<void> {
      for (const w of this.workers) await w.close();
      for (const q of this.queues.values()) await q.close();
   }

   /* ---------------- helper: queue factory ---------------------- */
   private async getOrCreateQueue(
      topic: string,
      group: string,
      createOpts?: Record<string, any>,
   ): Promise<Queue> {
      const name = queueName(topic, group);
      let q = this.queues.get(name);
      if (!q) {
         q = new Queue(name, {
            connection: this.cfg.connection,
            ...(this.cfg.defaultQueue ?? {}),
            ...(createOpts ?? {}),
         });
         this.queues.set(name, q);
      }
      return q;
   }
}

/* ──────────────────────────────────────────────────────────────────
 * Self-registration
 * ─────────────────────────────────────────────────────────────────*/
register('bullmq', async (cfg: BullConfig) => {
   const broker = new BullBroker(cfg);
   await broker.init();
   return broker;
});
