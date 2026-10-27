import { createServer } from "node:net";

/** A loopback listener is released by the OS even after an abnormal exit. */
export async function acquireInstance(port = 47877): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "EADDRINUSE" ? new Error("An agent is already running, or the instance port is unavailable.") : error);
    });
    server.listen({ port, host: "127.0.0.1", exclusive: true }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to acquire the agent instance port.");
  return { port: address.port, close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}
