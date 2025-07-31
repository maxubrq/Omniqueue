/* ================================================================
 * OmniQueue - Core contracts & runtime (vNext: **group is mandatory**)
 * ============================================================== */

/**
 * BrokerMessage represents a single unit of data moving through OmniQueue.
 */
export interface BrokerMessage<T = any> {
   /** Unique id – ideally ULID / UUID v7 */
   id: string;
   /** JSON‑serialisable payload */
   body: T;
   /** Arbitrary headers / attributes */
   headers: Record<string, any>;

   /** Positive acknowledgement */
   ack(): Promise<void>;
   /** Negative acknowledgement; if `requeue` is true → redeliver */
   nack(requeue?: boolean): Promise<void>;
}

/* ------------------------------------------------------------------
 * Producer‑side options (send / publish)
 * ---------------------------------------------------------------- */
export type SendOptions = {
   /** Optional priority (higher first). Default 0 */
   prio?: number;
   /**
    * Ensure the *destination* (queue / topic / stream …) exists before sending.
    * When `true`, the adapter should lazily create it with `createOptions`.
    * @default false
    */
   ensure?: boolean;
   /**
    * Broker‑specific parameters for destination creation.
    * • RabbitMQ → { durable, exclusive, autoDelete, arguments }
    * • Kafka    → { numPartitions, replicationFactor, configEntries }
    * • …others  → any shape they need
    */
   createOptions?: Record<string, any>;
};

/* ------------------------------------------------------------------
 * Consumer‑side options (receive / subscribe)
 * ---------------------------------------------------------------- */
export interface ConsumeOptions extends SendOptions {
   /**
    * **Required** logical consumer‑group id.
    * Acts as the *unit of work‑sharing*:
    * • **P2P (send/receive)** – only one member of the same `group` processes each message.
    * • **Fan‑out (publish/subscribe)** – every group receives a copy; within each group exactly
    *   one consumer handles the message.
    */
   group: string;
}

/* ------------------------------------------------------------------
 * Broker contract
 * ---------------------------------------------------------------- */
export interface Broker<
   TSend extends SendOptions = SendOptions,
   TConsume extends ConsumeOptions = ConsumeOptions,
> {
   /** Provider key (e.g. "rabbitmq", "kafka") */
   readonly provider: string;

   /** Configuration object used to create the broker instance */
   readonly config: any;
   /**
    * Initialize the broker connection.
    * This method establishes the connection to the message broker and prepares it for sending and receiving messages.
    * It should be called before any send or receive operations.
    * @returns A promise that resolves when the broker is successfully initialized.
    * @throws Error if the broker cannot be connected or initialized.
    * @example
    * ```ts
    * const broker = await create('rabbitmq', { host: 'localhost', port: 5672 });
    * await broker.init();
    * // Now the broker is ready to send and receive messages.
    * ```
    */
   init(): Promise<void>;

   /* ---------- point‑to‑point ---------- */
   /**
    * Send a message to a queue.
    * @param queue - The target queue name.
    * @param msg - The message to send, excluding `ack` and `nack` methods.
    * @param opts - Optional send options, such as priority and destination creation.
    * @returns A promise that resolves when the message is sent.
    * @throws Error if the queue does not exist and `ensure` is false.
    * @throws Error if the broker is not connected or the message cannot be sent.
    * @example
    * ```ts
    * await broker.send('my-queue', {
    *   id: 'unique-id',
    *   body: { key: 'value' },
    *   headers: { 'x-custom-header': 'value' }
    * });
    * ```
    */
   send(
      queue: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts?: TSend,
   ): Promise<void>;

   /**
    * Receive messages from a queue.
    * This method sets up a consumer that listens for messages on the specified queue.
    * It processes each message using the provided handler function.
    * 
    * Consumer will join the specified group, allowing for work‑sharing
    * among multiple consumers in the same group.
    * 
    * @param queue - The name of the queue to consume messages from.
    * @param handler - A function that processes each received message.
    * It receives a `BrokerMessage` object and should return a promise that resolves when the
    * message has been processed.
    * The handler should call `ack()` or `nack()` on the message to indicate
    * whether it was processed successfully or not.
    * @param opts - Options for consuming messages, including the consumer group.
    * The `group` option is mandatory and specifies the consumer group to join.
    * @returns A promise that resolves when the consumer is successfully set up.
    * @throws Error if the queue does not exist and `ensure` is false.
    * @throws Error if the broker is not connected or the consumer cannot be set up.
    * @example
    * ```ts
    * await broker.receive('my-queue', async (msg) => {
    *   console.log('Received message:', msg.body);
    *   // Process the message...
    *   await msg.ack(); // Acknowledge the message
    * }, {group: 'my-consumer-group', ensure: true});
    * ```
    */
   receive(
      queue: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts: TConsume,
   ): Promise<void>;

   /* -------------- fan‑out ------------- */
   /**
    * Publish a message to a topic.
    * This method sends a message to a topic, which can be consumed by multiple subscribers/groups.
    * The message is sent with the specified options, such as priority and destination creation.
    * 
    * @param topic - The target topic name.
    * @param msg - The message to publish, excluding `ack` and `nack` methods.
    * @param opts - Optional send options, such as priority and destination creation.
    * @returns A promise that resolves when the message is published.
    * @throws Error if the topic does not exist and `ensure` is false.
    * @throws Error if the broker is not connected or the message cannot be published.
    * @example
    * ```ts
    * await broker.publish('my-topic', {
    *   id: 'unique-id',
    *   body: { key: 'value' },
    *   headers: { 'x-custom-header': 'value' }
    * });
    * ```
    */
   publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts?: TSend,
   ): Promise<void>;

   /**
    * Subcribe to a topic.
    * This method sets up a consumer that listens for messages on the specified topic.
    * It processes each message using the provided handler function.
    * 
    * Consumer will join the specified group, allowing for work‑sharing
    * among multiple consumers in the same group.
    * 
    * When a message is sent to the topic, all the groups subscribed to that topic
    * will receive a copy of the message, and within each group, only one consumer
    * will handle the message.
    * 
    * @param topic - The name of the topic to subscribe to.
    * @param handler - A function that processes each received message. 
    * It receives a `BrokerMessage` object and should return a promise that resolves when the
    * message has been processed.
    * The handler should call `ack()` or `nack()` on the message to indicate
    * whether it was processed successfully or not.
    * @param opts - Options for consuming messages, including the consumer group.
    * The `group` option is mandatory and specifies the consumer group to join.
    * @returns A promise that resolves when the consumer is successfully set up.
    * @throws Error if the topic does not exist and `ensure` is false.
    * @throws Error if the broker is not connected or the consumer cannot be set up.
    * @example
    * ```ts
    * await broker.subscribe('my-topic', async (msg) => {
    *   console.log('Received message:', msg.body);
    *   // Process the message...
    *   await msg.ack(); // Acknowledge the message
    * }, {group: 'my-consumer-group', ensure: true});
    * ```
    */
   subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts: TConsume,
   ): Promise<void>;

   /* -------- lifecycle / teardown ------ */
   /**
    * Close the broker connection.
    * This method gracefully shuts down the broker connection,
    * ensuring that all pending messages are processed and resources are released.
    */
   close(): Promise<void>;
}

/* ================================================================
 * Plugin registry – adapters call register("rabbitmq", factory)
 * ============================================================== */
export type BrokerFactory = (cfg: any) => Promise<Broker>;

const REGISTRY: Map<string, BrokerFactory> = new Map();

/**
 * register a broker factory.
 * 
 * This function allows you to register a broker factory
 * with a specific provider key. The factory is a function that
 * creates a broker instance when called with a configuration object.
 * @param provider - unique provider key (e.g. "rabbitmq", "kafka")
 * @param factory - a function that creates a broker instance.
 * It should return a promise that resolves to a `Broker` instance.
 * @throws Error if the provider is already registered.
 * @example
 * ```ts
 * import { register } from 'omni-queue-core';
 * import { createRabbitMQBroker } from './rabbitmq-factory';
 * register('rabbitmq', createRabbitMQBroker);
 * ```
 * @see BrokerFactory
 * @see Broker
 * @see create
 */
export function register(provider: string, factory: BrokerFactory): void {
   if (REGISTRY.has(provider)) {
      throw new Error(`Broker \"${provider}\" already registered`);
   }
   REGISTRY.set(provider, factory);
}

/**
 * Create a broker instance.
 * This function creates a broker instance for the specified provider.
 * It uses the registered factory for the provider to create the broker.
 * @param provider - unique provider key (e.g. "rabbitmq", "kafka")
 * @param cfg - configuration object for the broker.
 * The shape of the configuration depends on the provider and should match
 * the expected parameters of the registered factory function.
 * @returns A promise that resolves to a `Broker` instance.
 * @throws Error if the provider is not registered.
 * @example
 * ```ts
 * import { create } from 'omni-queue-core';
 * const broker = await create('rabbitmq', {
 *   host: 'localhost',
 *   port: 5672,
 *   username: 'guest',
 *   password: 'guest',
 * });
 * ```
 * @see register
 * @see BrokerFactory
 * @see Broker
 */
export async function create<T = any>(
   provider: string,
   cfg: T,
): Promise<Broker> {
   const factory = REGISTRY.get(provider);
   if (!factory) {
      const known = [...REGISTRY.keys()].join(', ');
      throw new Error(
         `Broker \"${provider}\" not registered. Known: [${known || '–'}]`,
      );
   }
   return factory(cfg);
}
