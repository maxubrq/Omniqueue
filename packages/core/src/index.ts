/* ================================================================
 * OmniQueue - Core contracts & runtime
 * ============================================================== */

  /**
 * BrokerMessage interface defines the structure of messages
 * that are sent and received through the message broker.
 *
 * It includes                : 
 * - `id`                     : A unique identifier for the message,            ideally a ULID.
 * - `body`                   : The payload of the message,                     which should be JSON-serializable.
 * - `headers`                : An object containing arbitrary headers or attributes associated with the message.
 * - `ack()`                  : A method to acknowledge the message positively, indicating successful processing.
 * - `nack(requeue?: boolean)`: A method to negatively acknowledge the message,
 *   which can optionally requeue the message for retrying later.
 */
export interface BrokerMessage<T = any> {
   /** Unique id – ideally ULID   */
   id: string;
   /** Payload body (JSON-serialisable)   */
   body: T;
   /** Arbitrary headers/attributes       */
   headers: Record<string, any>;

   /** Positive acknowledgement           */
   ack(): Promise<void>;
   /** Negative ack; requeue =true → retry */
   nack(requeue?: boolean): Promise<void>;
}

/**
 * SendOptions interface defines options for sending messages
 * through the message broker.
 *
 * It includes    :
 * - `prio`       : An optional priority for the message, which can influence its delivery order. (default: 0)
 * - `ensureQueue`: An optional flag to ensure that the queue exists before sending the message
 *                   (default: false). If true, the broker should create the queue if it does not exist.
 * - `createQueueOptions`: Optional options for creating the queue if it does not exist.
 *                        This is useful for ensuring that the queue is ready to receive messages.
 *                        (default: undefined).
 *                        It can include properties like `durable`, `exclusive`, `autoDelete`, and `arguments`.
 */
export type SendOptions = {
   /**
    * Optional priority for the message.
    * Higher values indicate higher priority.
    * @default 0
    */
   prio?: number;
   /**
    * Optional flag to ensure that the queue exists before sending the message.
    * If true, the broker should create the queue if it does not exist.
    * @default false
    */
   ensureQueue?: boolean;
   /**
    * In case the queue does not exist, the broker should create it
    * with the specified options.
    * This is useful for ensuring that the queue is ready to receive messages.
    * @default undefined
    */
   createQueueOptions?: {
      durable?: boolean; // Whether the queue should survive broker restarts
      exclusive?: boolean; // Whether the queue is exclusive to the connection
      autoDelete?: boolean; // Whether the queue should be deleted when no longer in use
      arguments?: Record<string, any>; // Additional arguments for queue creation
   }
};

/**
 * Broker interface defines the contract for a message broker
 * that supports point-to-point and fan-out messaging patterns.
 *
 * It includes methods for sending and receiving messages,
 * as well as publishing and subscribing to topics.
 * 
 * It also includes a method for closing the broker connection.
 */
export interface Broker<T extends SendOptions = SendOptions> {
   /** Provider key (e.g. "rabbitmq") */
   readonly provider: string;

   /** Initialize the broker connection */
   init(): Promise<void>;

   /* ---------- point-to-point ---------- */
   send(
      queue: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts?: T,
   ): Promise<void>;

   receive(
      queue: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts?: T,
   ): Promise<void>;

   /* -------------- fan-out ------------- */
   publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts?: T,
   ): Promise<void>;

   subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts?: T,
   ): Promise<void>;

   /* -------- lifecycle / teardown ------ */
   close(): Promise<void>;
}

/* ================================================================
 * Plugin registry – adapters call register("rabbitmq", factory)
 * ============================================================== */

/**
 * BrokerFactory is a type that represents a factory function
 */
type BrokerFactory = (cfg: any) => Promise<Broker>;

/**
 * Registry of broker factories.
 * Maps provider names (e.g. "rabbitmq") to their respective factory functions.
 */
const REGISTRY: Map<string, BrokerFactory> = new Map();

/**
 * Called by adapter packages at import-time.
 * @example register("rabbitmq", async cfg => new RabbitBroker(cfg))
 */
export function register(provider: string, factory: BrokerFactory): void {
   if (REGISTRY.has(provider)) {
      throw new Error(`Broker "${provider}" already registered`);
   }
   REGISTRY.set(provider, factory);
}

/**
 * Runtime factory. Side-effect import of adapters is expected
 * before calling this (see EXAMPLE in spec §8).
 */
export async function create<T = unknown>(
   provider: string,
   cfg: T,
): Promise<Broker> {
   const factory = REGISTRY.get(provider);
   if (!factory) {
      const known = [...REGISTRY.keys()].join(', ');
      throw new Error(
         `Broker "${provider}" not registered. Known: [${known || '–'}]`,
      );
   }
   return factory(cfg);
}

/* convenient re-exports */
export type {
   BrokerFactory, // optional for adapter authors
};
