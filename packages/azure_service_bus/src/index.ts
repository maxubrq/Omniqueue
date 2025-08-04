/* ====================================================================
 * OmniQueue – Azure Service Bus adapter  (Core v1.0.0)
 *   – group = Subscription
 *   – Topic fan-out handled natively by Service Bus
 * ==================================================================== */
import {
   Broker,
   BrokerMessage,
   ConsumeOptions,
   SendOptions,
   register,
} from '@omniqueue/core';
import {
   ServiceBusClient,
   ServiceBusSender,
   ServiceBusReceiver,
   ServiceBusMessage,
   ServiceBusAdministrationClient,
   CreateTopicOptions,
   CreateSubscriptionOptions,
} from '@azure/service-bus';
import { ulid } from 'ulid';

/* ──────────────────────────────────────────────────────────────────
 * Config
 * ─────────────────────────────────────────────────────────────────*/
export interface ServiceBusConfig {
   /** Connection string like `Endpoint=sb://…;SharedAccessKeyName=…` */
   connectionString: string;
   /** Max concurrent message handlers per subscription. Default 10 */
   concurrency?: number;
   /** Default topic / subscription options when ensure=true */
   defaultTopicOptions?: Partial<CreateTopicOptions>;
   defaultSubscriptionOptions?: Partial<CreateSubscriptionOptions>;
}

/* sanitize topic ↔ entity names if needed (SB allows `.`, `/`) */
const topicName = (t: string) => t; // keep as-is

/* ──────────────────────────────────────────────────────────────────
 * Adapter implementation
 * ─────────────────────────────────────────────────────────────────*/
export class ServiceBusBroker
   implements Broker<SendOptions, ConsumeOptions> {
   readonly provider = 'azuresb' as const;
   readonly config: any;

   private sb!: ServiceBusClient;
   private admin!: ServiceBusAdministrationClient;
   private senders: Map<string, ServiceBusSender> = new Map();
   private receivers: ServiceBusReceiver[] = [];

   constructor(private cfg: ServiceBusConfig) {
      this.config = cfg;
   }

   /* ---------------- init ---------------------------------------- */
   async init(): Promise<void> {
      this.sb = new ServiceBusClient(this.cfg.connectionString);
      this.admin = new ServiceBusAdministrationClient(this.cfg.connectionString);
   }

   /* ---------------- publish ------------------------------------- */
   async publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts: SendOptions = {},
   ): Promise<void> {
      const tName = topicName(topic);

      if (opts.ensure) {
         if (!(await this.admin.topicExists(tName))) {
            await this.admin.createTopic(tName, {
               ...this.cfg.defaultTopicOptions,
               ...(opts.createOptions as Partial<CreateTopicOptions> | undefined),
            });
         }
      }

      let sender = this.senders.get(tName);
      if (!sender) {
         sender = this.sb.createSender(tName);
         this.senders.set(tName, sender);
      }

      await sender.sendMessages({
         messageId: msg.id,
         body: msg.body,
         applicationProperties: msg.headers,
         // Service Bus lacks native priority – could route via rules later
      } as ServiceBusMessage);
   }

   /* ---------------- subscribe ----------------------------------- */
   async subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      groupId: string,
      opts: ConsumeOptions,
   ): Promise<void> {
      if (!groupId) throw new Error('`groupId` is mandatory');

      const tName = topicName(topic);

      /* ensure topic / subscription -------------------------------- */
      if (opts.ensure) {
         if (!(await this.admin.topicExists(tName))) {
            await this.admin.createTopic(tName, {

               ...this.cfg.defaultTopicOptions,
               ...(opts.createOptions as Partial<CreateTopicOptions> | undefined),
            });
         }
         if (!(await this.admin.subscriptionExists(tName, groupId))) {
            await this.admin.createSubscription(tName, groupId, {
               ...this.cfg.defaultSubscriptionOptions,
               ...(opts.createOptions as Partial<CreateSubscriptionOptions> | undefined),
            });
         }
      }

      const receiver = this.sb.createReceiver(tName, groupId, {
         receiveMode: 'peekLock', // default mode
      });

      this.receivers.push(receiver);

      receiver.subscribe(
         {
            processMessage: async (raw) => {
               const brokerMsg: BrokerMessage = {
                  id: raw.messageId?.toString() ?? ulid(),
                  body: raw.body,
                  headers: raw.applicationProperties ?? {},
                  ack: async () => receiver.completeMessage(raw),
                  nack: async (requeue = true) =>
                     requeue
                        ? receiver.abandonMessage(raw)
                        : receiver.deadLetterMessage(raw),
               };
               try {
                  await handler(brokerMsg);
                  await brokerMsg.ack();
               } catch {
                  await brokerMsg.nack(true);
               }
            },
            processError: async (err) => {
               console.error('[OmniQueue|ServiceBus] receiver error', err);
            },
         },
         {
            maxConcurrentCalls: this.cfg.concurrency ?? 10,
         },
      );
   }

   /* ---------------- lifecycle ----------------------------------- */
   async close(): Promise<void> {
      await Promise.all(
         this.receivers.map((r) => r.close()),
      );
      await Promise.all(
         [...this.senders.values()].map((s) => s.close()),
      );
      await this.sb.close();
   }
}

/* ──────────────────────────────────────────────────────────────────
 * Self-registration
 * ─────────────────────────────────────────────────────────────────*/
register('azuresb', async (cfg: ServiceBusConfig) => {
   const broker = new ServiceBusBroker(cfg);
   await broker.init();
   return broker;
});
