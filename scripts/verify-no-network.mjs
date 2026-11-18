import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';

const isLoopback = (host) => {
  const normalized = String(host ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.');
};

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
  if (typeof options.host !== 'string' || !isLoopback(options.host)) {
    throw new Error('MCP verification blocked a non-loopback network connection.');
  }
  return originalConnect.apply(this, args);
};

for (const method of ['connect', 'send']) {
  const original = dgram.Socket.prototype[method];
  dgram.Socket.prototype[method] = function guardedDatagram(...args) {
    const options = args.find((value) => value && typeof value === 'object' && 'address' in value);
    const address = options?.address ?? args.find((value) => typeof value === 'string');
    if (typeof address !== 'string' || !isLoopback(address)) {
      throw new Error('MCP verification blocked a non-loopback network connection.');
    }
    return original.apply(this, args);
  };
}

for (const method of ['lookup', 'resolve', 'resolve4', 'resolve6']) {
  const original = dns[method];
  dns[method] = function guardedDns(host, ...args) {
    if (!isLoopback(host)) throw new Error('MCP verification blocked external DNS resolution.');
    return original.call(this, host, ...args);
  };
}

