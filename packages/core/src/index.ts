/* ================================================================
 * OmniQueue - Core contracts & runtime (vNext: grouping + generic ensure)
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
    * Logical consumer‑group id.
    * • **P2P (send/receive)** – only one member of the same `group` processes each msg.
    * • **Fan‑out (publish/subscribe)** – every group gets a copy; inside each group only
    *   one member processes it.
    * Omit for a private, auto‑named queue.
    */
   group?: string;
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

   /* ---------- point‑to‑point ---------- */
   send(
      queue: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts?: TSend,
   ): Promise<void>;

   receive(
      queue: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts?: TConsume,
   ): Promise<void>;

   /* -------------- fan‑out ------------- */
   publish(
      topic: string,
      msg: Omit<BrokerMessage, 'ack' | 'nack'>,
      opts?: TSend,
   ): Promise<void>;

   subscribe(
      topic: string,
      handler: (m: BrokerMessage) => Promise<void>,
      opts?: TConsume,
   ): Promise<void>;

   /* -------- lifecycle / teardown ------ */
   close(): Promise<void>;
}

/* ================================================================
 * Plugin registry – adapters call register("rabbitmq", factory)
 * ============================================================== */
export type BrokerFactory = (cfg: any) => Promise<Broker>;

const REGISTRY: Map<string, BrokerFactory> = new Map();

export function register(provider: string, factory: BrokerFactory): void {
   if (REGISTRY.has(provider)) {
      throw new Error(`Broker "${provider}" already registered`);
   }
   REGISTRY.set(provider, factory);
}

export async function create<T = any>(
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
