import { Broker, BrokerMessage, SendOptions } from "@omniqueue/core";

export class KafkaBroker implements Broker {
    init(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    send(queue: string, msg: Omit<BrokerMessage, "ack" | "nack">, opts?: SendOptions | undefined): Promise<void> {
        throw new Error("Method not implemented.");
    }
    receive(queue: string, handler: (m: BrokerMessage) => Promise<void>, opts?: SendOptions | undefined): Promise<void> {
        throw new Error("Method not implemented.");
    }
    publish(topic: string, msg: Omit<BrokerMessage, "ack" | "nack">, opts?: SendOptions | undefined): Promise<void> {
        throw new Error("Method not implemented.");
    }
    subscribe(topic: string, handler: (m: BrokerMessage) => Promise<void>, opts?: SendOptions | undefined): Promise<void> {
        throw new Error("Method not implemented.");
    }
    close(): Promise<void> {
        throw new Error("Method not implemented.");
    }
    readonly provider = "kafka" as const;
}