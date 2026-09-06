import type { AddressInfo, Server } from "node:net";

const isTcpAddress = (
  address: ReturnType<Server["address"]>
): address is AddressInfo =>
  address !== null &&
  typeof address !== "string" &&
  Number.isInteger(address.port) &&
  address.port > 0;

export const boundPort = (server: Server): number => {
  const address = server.address();
  if (!isTcpAddress(address)) {
    throw new Error("the loopback TCP listener did not bind");
  }
  return address.port;
};
