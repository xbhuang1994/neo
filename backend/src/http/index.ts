/**
 * Neo's HTTP interface: the JSON API the app calls, access control, and the web build's static files.
 *
 * Ported directly from Rust `neo-http/src/lib.rs`.
 */

import { Buffer } from "node:buffer";
import type { AppContext } from "../app/context.ts";
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  PAGE_POLICY,
  contentType,
  decodeStrictBase64,
  handle,
  hostName,
  loopbackName,
  parseAttachment,
  refused,
  sameSecret,
  webFile,
} from "./api.ts";
import type { Access, AttachmentResult } from "./api.ts";
import {
  BODY_TIMEOUT_MS,
  HEAD_TIMEOUT_MS,
  HttpRequest,
  HttpResponse,
  MAX_BODY_BYTES,
  MAX_CONNECTIONS,
  MAX_HEAD_BYTES,
  Request,
  Response,
  SHUTDOWN_DRAIN_MS,
  Server,
  WRITE_TIMEOUT_MS,
  formatSocketAddr,
  isLoopback,
  isLoopbackIp,
  parseHead,
  percentDecode,
  reason,
} from "./server.ts";
import type {
  Handler,
  HttpServerHandle,
  ParsedHead,
  RequestInitData,
  ResponseInitData,
  ServerOptions,
  SocketAddr,
} from "./server.ts";

/**
 * Offer the application's API, and the web build when `access` names its folder, on `host:port`.
 *
 * Anywhere but on loopback a token is required: an API without one is refused here rather than exposed.
 */
export async function serve(
  app: AppContext,
  host: string,
  port: number,
  access: Access = {},
  options?: ServerOptions,
): Promise<Server> {
  if (access.token !== undefined && Buffer.byteLength(access.token, "utf8") < 16) {
    throw new Error("The access token must have at least 16 characters");
  }
  if (access.token === undefined && !isLoopback(host)) {
    throw new Error(`Listening on ${host} needs an access token: set one, or listen on 127.0.0.1`);
  }
  const snapshot: Access = {
    token: access.token,
    webDir: access.webDir,
  };
  return await Server.bind(host, port, (request, peer) => handle(app, snapshot, request, peer), options);
}

export {
  BODY_TIMEOUT_MS,
  HEAD_TIMEOUT_MS,
  HttpRequest,
  HttpResponse,
  MAX_BODY_BYTES,
  MAX_CONNECTIONS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_HEAD_BYTES,
  MAX_TEXT_CHARS,
  PAGE_POLICY,
  Request,
  Response,
  SHUTDOWN_DRAIN_MS,
  Server,
  WRITE_TIMEOUT_MS,
  contentType,
  decodeStrictBase64,
  formatSocketAddr,
  handle,
  hostName,
  isLoopback,
  isLoopbackIp,
  loopbackName,
  parseAttachment,
  parseHead,
  percentDecode,
  reason,
  refused,
  sameSecret,
  webFile,
};

export type {
  Access,
  AttachmentResult,
  Handler,
  HttpServerHandle,
  ParsedHead,
  RequestInitData,
  ResponseInitData,
  ServerOptions,
  SocketAddr,
};
