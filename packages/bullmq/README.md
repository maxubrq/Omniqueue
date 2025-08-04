# @omniqueue/rabbitmq

> RabbitMQ adapter for **OmniQueue – “One API • Every Queue”**  
> Powered by [amqplib][] and fully compatible with RabbitMQ 3.8+.

---

## ✨ What this adapter maps

| OmniQueue concept          | RabbitMQ implementation                               | Notes                                    |
| -------------------------- | ----------------------------------------------------- | ---------------------------------------- |
| **Provider key**           | `rabbitmq`                                            | `create("rabbitmq", cfg)`                |
| **send / receive**         | Direct queue (`<queue>.<group>`)                      | Work-sharing inside *group*              |
| **publish / subscribe**    | Fan-out exchange ⟶ queue `<topic>.<group>`            | Groups each get their own queue          |
| **priority** (`prio`)      | `x-max-priority` queue *or* per-prio queue            | Auto-created when `ensure=true`          |
| **ensure / createOptions** | `assertExchange` / `assertQueue`                      | One-time provisioning                    |
| **delay** (`later()`)      | `x-delayed-message` plug-in **or** TTL + DLX fallback | No special code if you use the decorator |
| **ack / nack**             | `channel.ack` / `channel.nack`                        | `requeue=false` ⟶ DLQ (if bound)         |
| **group** (mandatory)      | Suffix in queue name                                  | `<base>.<group>`                         |

---

## 1 • Installation

```bash
pnpm add @omniqueue/rabbitmq          # runtime
pnpm add amqplib                      # peer dep if your monorepo hasn't it
````

---

## 2 • Quick-start

```ts
// side-effect registration
import "@omniqueue/rabbitmq";
import { create } from "@omniqueue/core";

const mq = await create("rabbitmq", {
  url: "amqp://guest:guest@localhost:5672",
  prefetch: 20,                            // optional QoS
  defaultQueue: { durable: true },         // used by ensure=true
});

// ── Producer ───────────────────────────────────────────────────────
await mq.send(
  "tasks.image.resize",
  { id: "job-42", body: { src: "in.jpg", dst: "out.jpg" }, headers: {} },
  { prio: 5, ensure: true, createOptions: { arguments: { "x-max-priority": 10 } } },
);

// ── Consumer group “workers” ───────────────────────────────────────
await mq.receive(
  "tasks.image.resize",
  async m => {
    console.log("worker got", m.body);
    await m.ack();
  },
  { group: "workers" },                    // REQUIRED
);
```

---

## 3 • Configuration reference

```ts
export interface RabbitConfig {
  /** Connection string, e.g. "amqp://user:pass@host:5672/vhost" */
  url: string;
  /** Channel prefetch (QoS) */
  prefetch?: number;
  /** Assert options used when `ensure=true` but no createOptions provided */
  defaultQueue?: amqplib.Options.AssertQueue;
  defaultExchange?: amqplib.Options.AssertExchange;
}
```

### SendOptions / ConsumeOptions

| Key             | Default                     | Meaning                                                   |
| --------------- | --------------------------- | --------------------------------------------------------- |
| `prio`          | `0`                         | RabbitMQ priority (requires queue with `x-max-priority`). |
| `ensure`        | `false`                     | Assert queue/exchange before use.                         |
| `createOptions` | –                           | Passed directly to `assertQueue` / `assertExchange`.      |
| `group`         | **REQUIRED (on consumers)** | Logical consumer-group id → queue suffix.                 |

---

## 4 • How grouping works internally

| API                   | Queue name        | Exchange                                       | Routing                                  |
| --------------------- | ----------------- | ---------------------------------------------- | ---------------------------------------- |
| `send / receive`      | `<queue>.<group>` | *none*                                         | Direct `basic.publish` to queue          |
| `publish / subscribe` | `<topic>.<group>` | Fan-out exchange `omni.fanout` (type=`fanout`) | Each group queue bound w/ no routing-key |

Result:

* **Within a group** – exactly one consumer receives each msg.
* **Across groups** – every group sees a copy (classic pub/sub).

---

## 5 • Priority handling

OmniQueue chooses the **simplest native path**:

1. If you set `prio` **and** the queue already has `x-max-priority`,
   value 0-255 is passed via Rabbit’s priority field.
2. If the queue lacks priority support and `prio > 0`,
   we *auto-create* sub-queues like `<queue>.p5` and publish there.

You can override by supplying `createOptions.arguments["x-max-priority"]`.

---

## 6 • Ensure-mode resource creation

When `ensure: true`, the adapter:

| Pattern                 | Assert sequence                                                                                            |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| **send / receive**      | `assertQueue(queueName, opts)`                                                                             |
| **publish / subscribe** | `assertExchange("omni.fanout","fanout", optsExchange)` → `assertQueue(queueName, optsQueue)` → `bindQueue` |

No exceptions are thrown if the resource already exists.

---

## 7 • Delay & scheduling (decorator-ready)

RabbitMQ core lacks per-msg delay, but two common plugins exist:

| Plugin                | How OmniQueue “magic-later” will use it                                        |
| --------------------- | ------------------------------------------------------------------------------ |
| **x-delayed-message** | Publishes to a `x-delayed-message` exchange with header `"x-delay": millis`.   |
| **TTL + DLX**         | Publishes to queue w/ `x-message-ttl` and dead-letters back to original queue. |

The current adapter exposes `channel` publicly so decorators can piggy-back.

---

## 8 • Observability

* **OpenTelemetry** decorator will wrap `channel.publish`/`consume` soon.
* Meanwhile you can enable \[Prometheus rabbitmq-exporter]\[] to track queue depth & throughput.

---

## 9 • Troubleshooting

| Symptom                        | Cause / Fix                                                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `CHANNEL_CLOSED - NOT_FOUND`   | You forgot `ensure: true` and queue doesn’t exist.                                                                      |
| Messages stuck in `.pN` queues | You published with `prio=N` but consumers are listening on base queue; subscribe to priorities or set `x-max-priority`. |
| Redelivery loop                | Handler threw without `ack`; add DLQ (`x-dead-letter-exchange`).                                                        |
| High latency spikes            | No QoS → prefetch unlimited; set `prefetch`.                                                                            |

---

## 10 • Developing & testing

```bash
docker run -d --name rabbit -p 5672:5672 -p 15672:15672 rabbitmq:3.13-management
# optional delay plugin
docker exec rabbit rabbitmq-plugins enable rabbitmq_delayed_message_exchange

# in repo root
pnpm turbo run build       # lint → types → build
pnpm test --filter rabbitmq
```

---

## 11 • Roadmap

* **Graceful shutdown** helper (`cancel` + drain).
* **Confirm-channel** mode for stronger producer guarantees.
* **Automatic DLQ topology** decorator.
* **Flow control** feedback → back-pressure upstream producers.

---

## 12 • License

[MIT](../LICENSE)

---

### Links

* OmniQueue spec → `PROMPT "OMNIQUEUE-SPEC"`
* amqplib → [https://github.com/amqp-node/amqplib](https://github.com/amqp-node/amqplib)
* Prometheus RabbitMQ exporter → [https://github.com/kbudde/rabbitmq\_exporter](https://github.com/kbudde/rabbitmq_exporter)

---

> Crafted with ☕ & 🥕 by the OmniQueue team.
