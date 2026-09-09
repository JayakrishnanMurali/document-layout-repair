/**
 * Minimal typed view of a dedicated worker's global scope.
 *
 * Pulling in the full `WebWorker` lib alongside `DOM` collides on dozens of shared
 * declarations, and the workers here only ever need these two members — declaring them
 * explicitly also makes every `postMessage` payload type-checked against the protocol.
 */
export type TypedWorkerScope<IncomingMessage, OutgoingMessage> = {
  onmessage: ((event: MessageEvent<IncomingMessage>) => void) | null
  postMessage(message: OutgoingMessage, transfer?: Transferable[]): void
}

export function getTypedWorkerScope<IncomingMessage, OutgoingMessage>(): TypedWorkerScope<
  IncomingMessage,
  OutgoingMessage
> {
  return self as unknown as TypedWorkerScope<IncomingMessage, OutgoingMessage>
}
