/* ====================================================================
 * OmniQueue – SNS + SQS adapter (producer-agnostic fan-out)
 * Provider key: "sns-sqs"
 * Core v1.0.0 – subscribe(topic, groupId, …), publish(topic, …)
 * ==================================================================== */
import {
   Broker,
   BrokerMessage,
   SendOptions,
   ConsumeOptions,
   register,
} from '@omniqueue/core';
import {
   SNSClient,
   CreateTopicCommand,
   PublishCommand,
   SubscribeCommand,
   SetSubscriptionAttributesCommand,
   GetTopicAttributesCommand,
} from '@aws-sdk/client-sns';
import {
   SQSClient,
   CreateQueueCommand,
   GetQueueUrlCommand,
   ReceiveMessageCommand,
   DeleteMessageCommand,
   SetQueueAttributesCommand,
   GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { ulid } from 'ulid';

/* ────────────────────────────────────────────────────────────────
 * Config
 * ────────────────────────────────────────────────────────────────*/
export interface SnsSqsConfig {
   region: string;
   credentials?: { accessKeyId: string; secretAccessKey: string };
   endpoint?: string;                         // LocalStack etc.
   waitTimeSeconds?: number;                  // long-poll (default 20)
   maxMessages?: number;                      // per poll (default 10)
}

/* Helpers ------------------------------------------------------- */
const snsTopicName = (t: string) => `oq.${t}`;
const sqsQueueName = (t: string, g: string) =>
   `oq-${t.replace(/[^A-Za-z0-9_-]/g, '-')}-${g}`;
const JSONify = (o: unknown) => JSON.stringify(o);

/* Cache to avoid Lookups */
const urlCache = new Map<string, string>();
const arnCache = new Map<string, string>();

/* ────────────────────────────────────────────────────────────────
 * Implementation
 * ────────────────────────────────────────────────────────────────*/
export class SnsSqsBroker
   implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'sns-sqs' as const;
   readonly config: any;

   private sns!: SNSClient;
   private sqs!: SQSClient;
   private stop = false;
   private pollers = new Set<() => void>();

   constructor(private cfg: SnsSqsConfig) {
      this.config = cfg;
   }

   async init() {
      const common = {
         region: this.cfg.region,
         credentials: this.cfg.credentials,
         endpoint: this.cfg.endpoint,
      };
      this.sns = new SNSClient(common);
      this.sqs = new SQSClient(common);
   }

   /* ---------------- producer ---------------------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      const topicArn = await this.ensureTopic(topic, opts.ensure, opts.createOptions);

      await this.sns.send(
         new PublishCommand({
            TopicArn: topicArn,
            Message: JSONify({ id: msg.id, body: msg.body, headers: msg.headers }),
            MessageAttributes:
               opts.prio !== undefined
                  ? { prio: { DataType: 'Number', StringValue: String(opts.prio) } }
                  : undefined,
         }),
      );
   }

   /* ---------------- consumer ---------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId) throw new Error('`groupId` is mandatory');

      /* 1. Ensure SNS topic & SQS queue */
      const topicArn = await this.ensureTopic(topic, opts.ensure, opts.createOptions);
      const queueUrl = await this.ensureQueue(topic, groupId, opts.ensure, opts.createOptions);
      const queueArn = await this.getQueueArn(queueUrl);

      /* 2. Allow SNS to send → SQS queue */
      await this.setQueuePolicy(queueUrl, queueArn, topicArn);

      /* 3. Subscribe queue to topic (idempotent) */
      await this.ensureSubscription(topicArn, queueArn);

      /* 4. Long-poll loop */
      const poll = async () => {
         if (this.stop) return;
         try {
            const res = await this.sqs.send(
               new ReceiveMessageCommand({
                  QueueUrl: queueUrl,
                  MaxNumberOfMessages: this.cfg.maxMessages ?? 10,
                  WaitTimeSeconds: this.cfg.waitTimeSeconds ?? 20,
               }),
            );
            for (const m of res.Messages ?? []) {
               const payload = JSON.parse(JSON.parse(m.Body!).Message);
               const bm: BrokerMessage = {
                  id: payload.id ?? m.MessageId ?? ulid(),
                  body: payload.body,
                  headers: payload.headers ?? {},
                  ack: async () => {
                     m.ReceiptHandle &&
                        this.sqs.send(
                           new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
                        )
                  },
                  nack: async () => {/* let visibility timeout expire */ },
               };
               try { await handler(bm); await bm.ack(); } catch { await bm.nack(); }
            }
         } catch (e) { console.error('[sns-sqs] poll error', e); }
         finally { if (!this.stop) setTimeout(poll, 0); }
      };
      this.pollers.add(poll);
      poll();
   }

   /* ---------------- teardown ---------------------------------- */
   async close() { this.stop = true; this.pollers.clear(); }

   /* ---------------- helpers ----------------------------------- */
   private async ensureTopic(
      t: string,
      ensure = false,
      opts?: Record<string, any>,
   ): Promise<string> {
      const name = snsTopicName(t);
      const cached = arnCache.get(name); if (cached) return cached;

      if (!ensure) {
         const arn = await this.getTopicArn(name);
         if (!arn) throw new Error(`SNS topic "${name}" not found and ensure=false`);
         arnCache.set(name, arn); return arn;
      }

      const { TopicArn } = await this.sns.send(
         new CreateTopicCommand({ Name: name, ...(opts?.topic ?? {}) }),
      );
      if (!TopicArn) throw new Error('Topic create failed');
      arnCache.set(name, TopicArn); return TopicArn;
   }

   private async ensureQueue(
      t: string,
      g: string,
      ensure = false,
      opts?: Record<string, any>,
   ): Promise<string> {
      const name = sqsQueueName(t, g);
      const cached = urlCache.get(name); if (cached) return cached;

      const lookup = async () => {
         try {
            const { QueueUrl } = await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }));
            return QueueUrl;
         } catch { return undefined; }
      };
      let url = await lookup();
      if (url) { urlCache.set(name, url); return url; }

      if (!ensure)
         throw new Error(`Queue "${name}" missing and ensure=false`);

      const { QueueUrl } = await this.sqs.send(
         new CreateQueueCommand({ QueueName: name, Attributes: opts?.queue?.attributes }),
      );
      if (!QueueUrl) throw new Error('queue create failed');
      urlCache.set(name, QueueUrl); return QueueUrl;
   }

   private async getTopicArn(name: string) {
      try {
         const { Attributes } = await this.sns.send(
            new GetTopicAttributesCommand({ TopicArn: `arn:aws:sns:::${name}` }),
         );
         return Attributes?.TopicArn;
      } catch { return undefined; }
   }

   private async getQueueArn(url: string): Promise<string> {
      const { Attributes } = await this.sqs.send(
         new GetQueueAttributesCommand({
            QueueUrl: url,
            AttributeNames: ['QueueArn'],
         }),
      );
      const arn = Attributes?.QueueArn;
      if (!arn) throw new Error('QueueArn missing');
      return arn;
   }

   private async setQueuePolicy(queueUrl: string, queueArn: string, topicArn: string) {
      const policy = JSONify({
         Version: '2012-10-17',
         Statement: [{
            Sid: 'AllowSNS',
            Effect: 'Allow',
            Principal: { Service: 'sns.amazonaws.com' },
            Action: 'sqs:SendMessage',
            Resource: queueArn,
            Condition: { ArnEquals: { 'aws:SourceArn': topicArn } },
         }],
      });
      await this.sqs.send(
         new SetQueueAttributesCommand({
            QueueUrl: queueUrl,
            Attributes: { Policy: policy },
         }),
      );
   }

   private async ensureSubscription(topicArn: string, queueArn: string) {
      const { SubscriptionArn } = await this.sns.send(
         new SubscribeCommand({
            TopicArn: topicArn,
            Protocol: 'sqs',
            Endpoint: queueArn,
            Attributes: { RawMessageDelivery: 'true' },
         }),
      );
      if (SubscriptionArn && SubscriptionArn !== 'PendingConfirmation') {
         await this.sns.send(
            new SetSubscriptionAttributesCommand({
               SubscriptionArn,
               AttributeName: 'RawMessageDelivery',
               AttributeValue: 'true',
            }),
         );
      }
   }
}

/* self-registration */
register('sns-sqs', async (cfg: SnsSqsConfig) => {
   const b = new SnsSqsBroker(cfg);
   await b.init();
   return b;
});
