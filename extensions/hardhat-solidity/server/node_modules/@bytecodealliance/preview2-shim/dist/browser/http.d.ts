import type { incomingHandler as IncomingHandlerNamespace, outgoingHandler as OutgoingHandlerNamespace, types as TypesNamespace } from "../../types/http.js";
export { InMemoryHttpClient } from "./in-memory-http.js";
/** Enable or disable Fetch `ReadableStream` request bodies. Disabled by default. */
export declare function _setRequestStreaming(enabled: boolean): void;
export declare const outgoingHandler: typeof OutgoingHandlerNamespace;
export declare const incomingHandler: typeof IncomingHandlerNamespace;
export type WasiIncomingHandler = (request: TypesNamespace.IncomingRequest, responseOut: TypesNamespace.ResponseOutparam) => void | Promise<void>;
export type WebIncomingHandler = (request: Request) => Response | Promise<Response>;
/** Create a `wasi:http/incoming-handler` namespace backed by a Web Request handler. */
export declare function createIncomingHandler(handler: WebIncomingHandler): typeof IncomingHandlerNamespace;
/** Translate a browser Request through a WASI handler with a synchronously readable body. */
export declare function handleIncomingRequest(request: Request, handler: WasiIncomingHandler): Promise<Response>;
export declare const types: typeof TypesNamespace;
