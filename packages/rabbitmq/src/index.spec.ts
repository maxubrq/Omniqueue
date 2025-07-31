import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RabbitBroker, RabbitConfig } from './index'
import { Channel, Connection, ConsumeMessage } from 'amqplib'
import * as amqplib from 'amqplib'

// Mock amqplib
vi.mock('amqplib', () => ({
    connect: vi.fn(),
}))

describe('RabbitBroker', () => {
    let broker: RabbitBroker
    let mockChannel: Partial<Channel>
    let mockConnection: Partial<amqplib.ChannelModel>

    const defaultConfig: RabbitConfig = {
        url: 'amqp://localhost',
        prefetch: 10,
        exchanges: {
            'test-exchange': { type: 'fanout' }
        }
    }

    beforeEach(async () => {
        // Reset mocks
        vi.clearAllMocks()

        // Setup mock channel
        mockChannel = {
            prefetch: vi.fn().mockResolvedValue(undefined),
            assertExchange: vi.fn().mockResolvedValue(undefined),
            assertQueue: vi.fn().mockResolvedValue({ queue: 'test-queue' }),
            sendToQueue: vi.fn().mockReturnValue(true),
            publish: vi.fn().mockReturnValue(true),
            consume: vi.fn().mockResolvedValue(undefined),
            ack: vi.fn().mockResolvedValue(undefined),
            nack: vi.fn().mockResolvedValue(undefined),
            bindQueue: vi.fn().mockResolvedValue(undefined),
            close: vi.fn().mockResolvedValue(undefined),
        }

        // Setup mock connection
        mockConnection = {
            createChannel: vi.fn().mockResolvedValue(mockChannel),
            close: vi.fn().mockResolvedValue(undefined),
        }

        // Setup connect mock
        vi.mocked(amqplib.connect).mockResolvedValue(mockConnection as amqplib.ChannelModel)

        // Create broker instance
        broker = new RabbitBroker(defaultConfig)
        await broker.init()
    })

    afterEach(() => {
        vi.resetAllMocks()
    })

    describe('initialization', () => {
        it('should connect and create channel with correct config', async () => {
            expect(amqplib.connect).toHaveBeenCalledWith(defaultConfig.url)
            expect(mockConnection.createChannel).toHaveBeenCalled()
            expect(mockChannel.prefetch).toHaveBeenCalledWith(defaultConfig.prefetch)
        })

        it('should assert configured exchanges', async () => {
            expect(mockChannel.assertExchange).toHaveBeenCalledWith(
                'test-exchange',
                'fanout',
                {}
            )
        })
    })

    describe('send', () => {
        it('should send message to queue', async () => {
            const message = {
                id: 'test-id',
                body: { test: 'data' },
                headers: { header: 'value' }
            }

            await broker.send('test-queue', message)

            expect(mockChannel.sendToQueue).toHaveBeenCalledWith(
                'test-queue',
                expect.any(Buffer),
                {
                    messageId: message.id,
                    priority: undefined,
                    headers: message.headers
                }
            )
        })

        it('should assert queue if ensureQueue is true', async () => {
            await broker.send('test-queue', {
                id: 'test',
                body: {},
                headers: {}
            }, { ensureQueue: true })

            expect(mockChannel.assertQueue).toHaveBeenCalled()
        })
    })

    describe('receive', () => {
        it('should setup consumer with message handling', async () => {
            const handler = vi.fn()
            await broker.receive('test-queue', handler)

            expect(mockChannel.consume).toHaveBeenCalledWith(
                'test-queue',
                expect.any(Function)
            )
        })

        it('should process messages and call handler', async () => {
            const handler = vi.fn().mockResolvedValue(undefined)
            const mockMessage: Partial<ConsumeMessage> = {
                content: Buffer.from(JSON.stringify({ test: 'data' })),
                properties: {
                    messageId: 'test-id',
                    headers: { test: 'header' }
                },
                fields: { deliveryTag: 1 }
            } as any;

            await broker.receive('test-queue', handler)

            // Get the consume callback and execute it
            const consumeCallback = vi.mocked(mockChannel.consume as any).mock.calls[0][1]
            await consumeCallback!(mockMessage as ConsumeMessage)

            expect(handler).toHaveBeenCalledWith(expect.objectContaining({
                id: 'test-id',
                body: { test: 'data' },
                headers: { test: 'header' }
            }))
        })
    })

    describe('publish/subscribe', () => {
        it('should publish message to exchange', async () => {
            const message = {
                id: 'test-id',
                body: { test: 'data' },
                headers: { header: 'value' }
            }

            await broker.publish('test-topic', message)

            expect(mockChannel.assertExchange).toHaveBeenCalledWith(
                'test-topic',
                'fanout',
                { durable: true }
            )
            expect(mockChannel.publish).toHaveBeenCalledWith(
                'test-topic',
                '',
                expect.any(Buffer),
                expect.objectContaining({
                    messageId: message.id,
                    headers: message.headers
                })
            )
        })

        it('should setup subscription with correct bindings', async () => {
            const handler = vi.fn()
            await broker.subscribe('test-topic', handler)

            expect(mockChannel.assertExchange).toHaveBeenCalledWith(
                'test-topic',
                'fanout',
                { durable: true }
            )
            expect(mockChannel.assertQueue).toHaveBeenCalledWith(
                '',
                { exclusive: true, durable: false }
            )
            expect(mockChannel.bindQueue).toHaveBeenCalled()
        })
    })

    describe('close', () => {
        it('should close channel and connection', async () => {
            await broker.close()

            expect(mockChannel.close).toHaveBeenCalled()
            expect(mockConnection.close).toHaveBeenCalled()
        })
    })
})