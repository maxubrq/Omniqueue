# ADR – Drop `send/receive`; make **publish + subscribe + group** the single delivery model

*ADR-ID:* 0001  *Status:* **Accepted**  *Date:* 2025-08-01

---

## 1 · Context / Problem

OmniQueue v1 exposed two parallel abstractions:

| Pattern                           | Semantics                                                                                                           | Mapping notes                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **send / receive**                | Point-to-point queue. Exactly one consumer instance gets each message.                                              | Natural fit for RabbitMQ queues, BullMQ jobs, etc. |
| **publish / subscribe (+ group)** | Fan-out with work-sharing. Every **group** receives a copy; within the group only one consumer instance handles it. | Mirrors Kafka consumer-groups.                     |

While intuitive, this duality introduced **API ambiguity** and extra effort in adapter maintenance:

* Developers had to choose between *queue* vs *topic* semantics up-front, even when most brokers (Kafka, NATS, SQS + SNS) have **only** publish/subscribe primitives.
* Adapters duplicated code (ack/nack, ensure/create, priority handling) for both call-paths.
* Runtime switching between brokers was harder, because some providers could not offer strict queue semantics without overlays.

A design spike and field feedback showed that **using *groups* as the sole unit of work-sharing** can cover both fan-out and classic queue use-cases with *less surface area*.

---

## 2 · Decision

> **Remove `send()` and `receive()` from OmniQueue’s core API.**
> The framework now exposes **only**:
>
> * `publish(topic, msg, opts?)`
> * `subscribe(topic, handler, { group, … })`
>
> where **`SubscribeOptions.group` is required**.

### Behaviour

* **Every group receives the full stream** of messages published to the topic.
* **Inside a group** exactly **one consumer instance** processes each message (Ack-based).
* If an application needs strict point-to-point delivery, it simply uses **one fixed group name** (e.g. `"default"`); scaling horizontally adds more consumers in that group.

### Versioning

* Core will release as `@omniqueue/core **v1.0.0**` (semver-major, breaking).
* All adapters will bump to `v1.0.0` and delete `send/receive` code paths.

---

## 3 · Consequences

### Positive

* **Simpler public API** – one mental model; fewer methods to document and test.
* **Adapter code shrinkage** – no dual mapping logic; easier to maintain.
* **Perfect brokerage parity** – every supported backend already supports fan-out + group semantics (or can emulate them via queues).
* **Easier runtime switching** – apps write one style and deploy to any broker.

### Negative / Trade-offs

* Applications needing “strict queue” semantics must now **choose a group string** explicitly; this is a small migration effort.
* Brokers without server-side pub/sub (e.g. pure Redis lists) now emulate fan-out by creating per-group queues – slight resource overhead.
* Removing methods is a breaking change; downstream projects must refactor.

### Migration Impact

| Code impact                                                                         | Effort            |
| ----------------------------------------------------------------------------------- | ----------------- |
| Search-replace `send`→`publish`, `receive`→`subscribe`. Add `{ group: "default" }`. | 5-10 min per repo |
| Update package.json: `@omniqueue/*` to `^2`.                                        | trivial           |

### Risks & Mitigations

| Risk                                               | Mitigation                                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Developers forget to pass `group` ⇒ runtime error. | Core validates and throws explicit “group is required” message.                           |

---

## 4 · Alternatives considered

1. **Keep both APIs** and mark one “preferred”.
   *Rejected* – confusion persists; adapters stay bloated.

2. **Auto-generate an internal group for `receive()`** rather than removing it.
   *Rejected* – still doubles surface; hides important scaling concept.

3. **Adopt queue-only model (drop publish/subscribe).**
   *Rejected* – breaks fan-out use-cases and maps poorly to Kafka/NATS.
