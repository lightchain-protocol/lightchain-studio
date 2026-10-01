import type { incomingHandler as IncomingHandlerNamespace } from "../../types/http.js";
import type { WasiIncomingHandler } from "./http.js";
/** A fetch-like browser client for invoking an in-memory WASI HTTP handler. */
export declare class InMemoryHttpClient {
    #private;
    constructor(handler: WasiIncomingHandler | typeof IncomingHandlerNamespace);
    fetch(request: Request): Promise<Response>;
}
