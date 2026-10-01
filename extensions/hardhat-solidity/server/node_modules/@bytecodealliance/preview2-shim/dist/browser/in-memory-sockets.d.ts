import type { TcpSocketsShim, UdpSocketsShim } from "../../types/instantiation.js";
import type { IpSocketAddress } from "../../types/interfaces/wasi-sockets-network.js";
import type { InputStream, OutputStream } from "../../types/interfaces/wasi-io-streams.js";
/** The browser-side endpoint of an in-memory TCP connection. */
export declare class InMemoryTcpClient {
    #private;
    write(bytes: Uint8Array): void;
    read(length?: bigint): Uint8Array;
    _serverStreams(): readonly [InputStream, OutputStream];
}
/** Deterministic, process-local TCP namespaces with a browser-side client API. */
export declare class InMemoryTcpSockets implements TcpSocketsShim {
    #private;
    readonly tcp: TcpSocketsShim["tcp"];
    readonly tcpCreateSocket: TcpSocketsShim["tcpCreateSocket"];
    constructor();
    connect(serverAddress: IpSocketAddress): InMemoryTcpClient;
}
/** The browser-side endpoint of an in-memory UDP socket. */
export declare class InMemoryUdpClient {
    #private;
    constructor(send: (bytes: Uint8Array, serverAddress: IpSocketAddress) => void);
    send(bytes: Uint8Array, serverAddress: IpSocketAddress): void;
    read(): Uint8Array;
    _receive(bytes: Uint8Array): void;
}
/** Deterministic, process-local UDP namespaces with a browser-side client API. */
export declare class InMemoryUdpSockets implements UdpSocketsShim {
    #private;
    readonly udp: UdpSocketsShim["udp"];
    readonly udpCreateSocket: UdpSocketsShim["udpCreateSocket"];
    constructor();
    createClient(localAddress: IpSocketAddress): InMemoryUdpClient;
}
