import type { instanceNetwork as InstanceNetworkNamespace, ipNameLookup as IpNameLookupNamespace, network as NetworkNamespace, tcpCreateSocket as TcpCreateSocketNamespace, tcp as TcpNamespace, udpCreateSocket as UdpCreateSocketNamespace, udp as UdpNamespace } from "../../types/sockets.js";
export { InMemoryTcpClient, InMemoryTcpSockets, InMemoryUdpClient, InMemoryUdpSockets, } from "./in-memory-sockets.js";
export declare const instanceNetwork: typeof InstanceNetworkNamespace;
export declare const network: typeof NetworkNamespace;
export declare const ipNameLookup: typeof IpNameLookupNamespace;
export declare const tcpCreateSocket: typeof TcpCreateSocketNamespace;
export declare const tcp: typeof TcpNamespace;
export declare const udpCreateSocket: typeof UdpCreateSocketNamespace;
export declare const udp: typeof UdpNamespace;
