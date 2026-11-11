import { createSign, constants as cryptoConstants } from "node:crypto";
import { config } from "./config.ts";

// Kalshi signs requests with RSA-PSS over `${timestamp}${METHOD}${path}`.
// The same three headers authenticate both REST calls and the WebSocket
// upgrade request. Credentials never leave this process.
export function signRequest(method: string, path: string) {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}`;

  const signature = createSign("RSA-SHA256")
    .update(message)
    .sign({
      key: config.privateKeyPem,
      padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
      saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");

  return {
    "KALSHI-ACCESS-KEY": config.apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature,
    "KALSHI-ACCESS-TIMESTAMP": timestamp,
  };
}
