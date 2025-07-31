# @omniqueue/kafka

> Kafka adapter for **OmniQueue – “One API • Every Queue”**  
> Built on top of [node-rdkafka][], backed by **librdkafka ≥ 2.5**.

---

## ✨ What this adapter gives you

| OmniQueue concept              | Kafka realisation        | Notes                                                  |
| ------------------------------ | ------------------------ | ------------------------------------------------------ |
| **Provider key**               | `kafka`                  | Use in `create("kafka", cfg)`                          |
| **send / publish**             | `Producer.produce()`     | Same code path – fan-out happens via *consumer groups* |
| **receive / subscribe**        | `KafkaConsumer`          | `group` is **mandatory** (maps to `group.id`)          |
| **priority** (`prio`)          | Partition index          | `0 → partition 0`, `1 → partition 1`, …                |
| **ensure / createOptions**     | Admin API topic creation | Run **once** per topic when `ensure=true`              |
| **ack / nack**                 | Manual commits           | `ack()` → `commit()`, `nack()` → no commit (redeliver) |
| **delay**                      | _(not native)_           | Use OmniQueue “magic-later” decorator (future)         |
| **idempotency / exactly-once** | Optional                 | Enable `enable.idempotence=true` or TX-mode            |

---

## 1 • Installation

```bash
# workspace root
pnpm add @omniqueue/kafka          # runtime
pnpm add -D node-gyp librdkafka    # if your env lacks a pre-built binary
````

> **librdkafka** must be available.
> On macOS: `brew install librdkafka`.
> On Debian/Ubuntu: `apt-get install librdkafka-dev`.

---

## 2 • Quick-start

```ts
// bootstrap (side-effect registration)
import "@omniqueue/kafka";
import { create } from "@omniqueue/core";

// 1. Build broker instance
const mq = await create("kafka", {
  brokers: ["localhost:9092"],
  clientId: "my-app",                 // optional
  defaultTopic: { numPartitions: 3 }, // used when ensure=true
});

// 2. Producer – everyone uses the same call
await mq.publish(
  "events.order.placed",
  { id: "o-123", body: { total: 99 }, headers: { saga: "checkout" } },
  { prio: 2, ensure: true },          // -> partition 2, auto-create topic
);

// 3. Consumer – MUST join a group
await mq.subscribe(
  "events.order.placed",
  async m => {
    console.log("billing service got", m.body);
    await m.ack();                    // commit offset only on success
  },
  { group: "billing" },               // unit-of-work sharing
);
```

---

## 3 • Configuration reference

```ts
export interface KafkaConfig {
  brokers: string | string[];     // "host1:9092,host2:9092" or ["host1:9092",…]
  clientId?: string;              // default: omniqueue-<uuid>
  producerConfig?: ProducerGlobalConfig; // passes through to node-rdkafka
  consumerConfig?: ConsumerGlobalConfig; // passes through
  defaultTopic?: {
    numPartitions?: number;       // default: 1
    replicationFactor?: number;   // default: 1
    configEntries?: Record<string,string>; // topic-level configs
  };
}
```

### SendOptions (for `send` & `publish`)

| Key             | Default | Meaning                                 |
| --------------- | ------- | --------------------------------------- |
| `prio`          | `0`     | Maps to partition index (0-based).      |
| `ensure`        | `false` | Auto-create topic/queue if absent.      |
| `createOptions` | *undef* | Topic params overriding `defaultTopic`. |

### ConsumeOptions (for `receive` & `subscribe`)

| Key        | Required | Meaning                                            |
| ---------- | -------- | -------------------------------------------------- |
| `group`    | ✔        | Logical **consumer-group** / `group.id`.           |
| Other keys | –        | Same as **SendOptions** so you can share one type. |

---

## 4 • How grouping works

* **Grouping is mandatory** in OmniQueue vNext: it is the *unit of work sharing*.
* For point-to-point (`receive`) only **one** member in the group handles each message.
* For fan-out (`subscribe`) *every group* receives a copy, still one member per group.
* In Kafka the mapping is direct (`group.id`). No extra topics are created.

---

## 5 • Topic creation & schema

When you call any producer-side method with `ensure: true`, the adapter:

1. Calls `AdminClient.createTopic()`.
2. Ignores `ERR_TOPIC_ALREADY_EXISTS`.
3. Respects `createOptions.*` or falls back to `defaultTopic`.

This keeps your app **self-provisioning**: no manual `kafka-topics.sh` needed.

---

## 6 • Priority ⇒ Partitions

| `prio` value      | Partition picked | Why                       |
| ----------------- | ---------------- | ------------------------- |
| `undefined` / `0` | `0`              | Default                   |
| `1`               | `1`              | Simple one-to-one mapping |
| `> (N-1)`         | `N-1`            | Clamped to last partition |

Want smarter routing (e.g. hashes or weighted priorities)? Supply a custom **partitioner** via `producerConfig["partitioner_cb"]`.

---

## 7 • Exactly-once & transactions (advanced)

Kafka 0.11+ supports idempotent producers and transactional commits:

```ts
const cfg = {
  brokers: "localhost:9092",
  producerConfig: {
    "enable.idempotence": true,
    "transactional.id": "order-saga-tx",
  },
};

const mq = await create("kafka", cfg);

// inside a saga coordinator
await mq.withTransaction(async tx => {
  await tx.publish(/* … */);     // sends as part of TX
  await tx.send(/* … */);
  // commit() or abort() handled by OmniQueue when fn resolves / throws
});
```

*(Transaction helper is on the roadmap – not in this first release.)*

---

## 8 • Observability

* **OpenTelemetry** tracing integration will be delivered via
  `@omniqueue/magic-tracing` decorator package (coming soon).
* For now you can wrap the returned `broker` with your own interceptor.

---

## 9 • Troubleshooting

| Symptom                        | Possible cause / fix                                                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `ERR__ALL_BROKERS_DOWN`        | Wrong `brokers` list, firewall, SASL/TLS mismatch.                                              |
| Messages redeliver forever     | Your handler threw but you never `ack()`; fix code or add DLQ decorator.                        |
| High p99 latency               | Too few partitions for `prio`, or synchronously awaiting `produce` inside hot path.             |
| `Module did not self-register` | Missing native bindings – reinstall after installing build tools (`make`, `python`, `gcc/g++`). |

---

## 10 • Developing & testing

```bash
cd packages/kafka
pnpm test              # Vitest suite (uses Kafkajs local-stack)
pnpm turbo run build   # Runs lint → typecheck → build
```

Local single-node Kafka via Docker:

```bash
docker run -d --name kafka -p 9092:9092 \
  -e KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://localhost:9092 \
  -e KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1 \
  quay.io/strimzi/kafka:latest
```

---

## 11 • Roadmap

* **Decorator-powered delay queues** (time-travel replay).
* **Transactional helper** (`withTransaction`).
* **Idempotency layer** backed by Redis / JDBC.
* **Dynamic partition scaler** reacting to message priority histograms.

Stay tuned – follow [@omnistack](https://github.com/omnistack) for updates.

---

## 12 • License

[MIT](./LICENSE)

---

### Links

* **OmniQueue spec** → `PROMPT "OMNIQUEUE-SPEC"`
* node-rdkafka → [https://github.com/Blizzard/node-rdkafka](https://github.com/Blizzard/node-rdkafka)
* librdkafka → [https://github.com/edenhill/librdkafka](https://github.com/edenhill/librdkafka)

---

> Made with ☕ + ❤️ by the OmniQueue team.