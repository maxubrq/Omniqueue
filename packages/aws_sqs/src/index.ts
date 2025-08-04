/* =====================================================================
 * OmniQueue – Amazon SQS adapter (pre-declared groups variant)
 * Core v1.0.0  –  group list supplied at publish-time
 * ===================================================================== */
import {
   Broker,
   BrokerMessage,
   SendOptions,
   ConsumeOptions,
   register,
} from '@omniqueue/core';
import {
   SQSClient,
   CreateQueueCommand,
   GetQueueUrlCommand,
   SendMessageCommand,
   ReceiveMessageCommand,
   DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { ulid } from 'ulid';

/* ──────────────────────────────────────────────────────────────────
 * Config
 * ─────────────────────────────────────────────────────────────────*/
export interface SqsConfig {
   region: string;
   credentials?: { accessKeyId: string; secretAccessKey: string };
   endpoint?: string; // for LocalStack
   waitTimeSeconds?: number; // default 20
   maxMessages?: number; // default 10
}

/* Helpers -------------------------------------------------------- */
const qName = (topic: string, grp: string) =>
   `oq-${topic.replace(/[^A-Za-z0-9_-]/g, '-')}-${grp}`;
const json = (o: any) => JSON.stringify(o);

/* Simple in-memory URL cache */
const urlCache = new Map<string, string>();

async function ensureQueue(
   sqs: SQSClient,
   name: string,
   ensure: boolean,
   attrs?: Record<string, string>,
): Promise<string> {
   const cached = urlCache.get(name);
   if (cached) return cached;

   const lookup = async () => {
      try {
         const { QueueUrl } = await sqs.send(
            new GetQueueUrlCommand({ QueueName: name }),
         );
         return QueueUrl;
      } catch {
         return undefined;
      }
   };

   let url = await lookup();
   if (url) {
      urlCache.set(name, url);
      return url;
   }
   if (!ensure) throw new Error(`Queue "${name}" missing and ensure=false`);

   const { QueueUrl } = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: attrs }),
   );
   if (!QueueUrl) throw new Error('queue create failed');
   urlCache.set(name, QueueUrl);
   return QueueUrl;
}

/* ──────────────────────────────────────────────────────────────────
 * Adapter
 * ─────────────────────────────────────────────────────────────────*/
export class SqsBroker implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'sqs' as const;
   readonly config: any;

   private sqs!: SQSClient;
   private stop = false;
   private pollers = new Set<() => void>();

   constructor(private cfg: SqsConfig) {
      this.config = cfg;
   }

   async init() {
      this.sqs = new SQSClient({
         region: this.cfg.region,
         credentials: this.cfg.credentials,
         endpoint: this.cfg.endpoint,
      });
   }

   /* ------------- producer -------------------------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      const groups: string[] | undefined = (opts.createOptions as any)
         ?.groupNames;
      if (!opts.ensure || !groups?.length)
         throw new Error(
            'SQS publish needs ensure=true & createOptions.groupNames',
         );

      await Promise.all(
         groups.map(async (g) => {
            const url = await ensureQueue(
               this.sqs,
               qName(topic, g),
               true,
               opts.createOptions?.attributes,
            );
            await this.sqs.send(
               new SendMessageCommand({
                  QueueUrl: url,
                  MessageBody: json({
                     id: msg.id,
                     body: msg.body,
                     headers: msg.headers,
                  }),
                  DelaySeconds: opts.prio ?? 0, // optional priority as delay hack
               }),
            );
         }),
      );
   }

   /* ------------- consumer -------------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      group: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!group) throw new Error('groupId is mandatory');

      const url = await ensureQueue(
         this.sqs,
         qName(topic, group),
         opts.ensure ?? false,
         opts.createOptions?.attributes,
      );

      /* long-poll loop */
      const poll = async () => {
         if (this.stop) return;
         try {
            const res = await this.sqs.send(
               new ReceiveMessageCommand({
                  QueueUrl: url,
                  MaxNumberOfMessages: this.cfg.maxMessages ?? 10,
                  WaitTimeSeconds: this.cfg.waitTimeSeconds ?? 20,
               }),
            );
            for (const m of res.Messages ?? []) {
               const payload = JSON.parse(m.Body ?? '{}');
               const brokerMsg: BrokerMessage = {
                  id: payload.id ?? m.MessageId ?? ulid(),
                  body: payload.body,
                  headers: payload.headers ?? {},
                  ack: async () => {
                     m.ReceiptHandle &&
                        this.sqs.send(
                           new DeleteMessageCommand({
                              QueueUrl: url,
                              ReceiptHandle: m.ReceiptHandle,
                           }),
                        );
                  },
                  nack: async () => {
                     /* let visibility-timeout handle redelivery */
                  },
               };
               try {
                  await handler(brokerMsg);
                  await brokerMsg.ack();
               } catch {
                  await brokerMsg.nack();
               }
            }
         } catch (e) {
            console.error('[SQS] poll error', e);
         } finally {
            if (!this.stop) setTimeout(poll, 0);
         }
      };
      this.pollers.add(poll);
      poll();
   }

   /* ------------- teardown -------------------------------------- */
   async close() {
      this.stop = true;
      this.pollers.clear();
   }
}

/* self-registration */
register('sqs', async (cfg: SqsConfig) => {
   const b = new SqsBroker(cfg);
   await b.init();
   return b;
});
