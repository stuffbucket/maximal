import { createServer } from "node:net";

export interface StorybookPortOption {
  explicit: boolean;
  port: number | null;
}

function validPort(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** The port requested on Storybook's command line, or the launcher's default. */
export function storybookPortOption(args: ReadonlyArray<string>, fallback = 6006): StorybookPortOption {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port" || arg === "-p") {
      return { explicit: true, port: validPort(args[index + 1]) };
    }
    if (arg?.startsWith("--port=")) {
      return { explicit: true, port: validPort(arg.slice("--port=".length)) };
    }
    if (arg?.startsWith("-p=")) {
      return { explicit: true, port: validPort(arg.slice("-p=".length)) };
    }
  }
  return { explicit: false, port: fallback };
}

/** Whether a loopback TCP port can be bound right now. */
export function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", (error) => {
      if ("code" in error && error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }
      reject(error);
    });
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => {
        if (error) reject(error);
        else resolve(true);
      });
    });
  });
}

/** The first available port in an inclusive range. */
export async function firstAvailablePort(start: number, end: number): Promise<number | null> {
  for (let port = start; port <= end; port += 1) {
    if (await portIsAvailable(port)) return port;
  }
  return null;
}
