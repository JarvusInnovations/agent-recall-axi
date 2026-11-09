// Fails loudly on any attempt to resolve a name or open a socket; records attempts to stderr.
import dns from "node:dns";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";

const attempts = [];
const block = (what) =>
  function blocked() {
    attempts.push(what);
    throw new Error(`network blocked: ${what}`);
  };
dns.lookup = block("dns.lookup");
dns.resolve = block("dns.resolve");
dns.promises.lookup = block("dns.promises.lookup");
net.connect = block("net.connect");
net.createConnection = block("net.createConnection");
net.Socket.prototype.connect = block("net.Socket.connect");
tls.connect = block("tls.connect");
http.request = block("http.request");
http.get = block("http.get");
https.request = block("https.request");
https.get = block("https.get");
globalThis.fetch = block("fetch");
process.on("exit", () => {
  process.stderr.write(`NETWORK_ATTEMPTS ${JSON.stringify(attempts)}\n`);
});
