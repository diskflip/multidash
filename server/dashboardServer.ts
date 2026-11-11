import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const digest = (value: string) => createHash("sha256").update(value).digest();
const matches = (value: string, token: string) => timingSafeEqual(digest(value), digest(token));
export const canControlDashboard = (req: IncomingMessage, token: string) => token.length >= 32 &&
  (req.headers.cookie ?? "").split(";").some((cookie) => {
    const [name, ...value] = cookie.trim().split("=");
    return name === "dashboard_session" && matches(value.join("="), token);
  });

// Serve only the built frontend; credentials and source files stay private.
export function createDashboardServer(port: number, token: string) {
  if (token.length < 32) throw new Error("DASHBOARD_ACCESS_TOKEN must contain at least 32 characters");
  const root = resolve("dist");
  const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".webp": "image/webp", ".mp3": "audio/mpeg",
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/login" && matches(url.searchParams.get("access") ?? "", token)) {
      res.writeHead(303, {
        Location: "/",
        "Set-Cookie": `dashboard_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800`,
      }).end();
      return;
    }
    if (url.pathname === "/login") {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" })
        .end("Invalid control access link.");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    try {
      const pathname = decodeURIComponent(url.pathname);
      const file = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
      if (!file.startsWith(root + sep) || pathname.split("/").some((part) => part.startsWith("."))) {
        res.writeHead(404).end();
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404).end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    let validOrigin = !origin;
    try { if (origin) validOrigin = new URL(origin).host === req.headers.host; } catch { /* reject */ }
    if (req.url !== "/ws" || !validOrigin) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  server.listen(port, "127.0.0.1");
  return wss;
}
