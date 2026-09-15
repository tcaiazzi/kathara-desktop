import { describe, expect, it } from "vitest";
import { parseIfaceIps } from "./topology";
import type { MachineDetail } from "./types";

function machine(execCommands: string[] = []): MachineDetail {
  return {
    name: "pc1",
    interfaces: [],
    running: false,
    status: null,
    image: null,
    mem: null,
    cpus: null,
    ports: [],
    envs: {},
    sysctls: {},
    exec_commands: execCommands,
    volumes: [],
    ulimits: [],
    privileged: false,
    bridged: false,
    ipv6: null,
    shell: null,
    num_terms: null,
    entrypoint: null,
    args: null,
    metas: {},
  };
}

describe("parseIfaceIps", () => {
  it("picks up a plain IPv4 assignment", () => {
    expect(parseIfaceIps(machine(), "ip address add 10.0.0.1/24 dev eth0")).toEqual({
      0: ["10.0.0.1/24"],
    });
  });

  it("picks up an IPv6 assignment with no family flag", () => {
    expect(parseIfaceIps(machine(), "ip address add 2001:db8::1/64 dev eth0")).toEqual({
      0: ["2001:db8::1/64"],
    });
  });

  it("picks up an IPv6 assignment written with the -6 family flag", () => {
    expect(parseIfaceIps(machine(), "ip -6 addr add 2001:db8::1/64 dev eth0")).toEqual({
      0: ["2001:db8::1/64"],
    });
    expect(parseIfaceIps(machine(), "ip -6 address add 2001:db8::1/64 dev eth1")).toEqual({
      1: ["2001:db8::1/64"],
    });
  });

  it("collects both an IPv4 and an IPv6 address on the same interface", () => {
    const startup = ["ip address add 10.0.0.1/24 dev eth0", "ip -6 addr add 2001:db8::1/64 dev eth0"].join("\n");
    expect(parseIfaceIps(machine(), startup)).toEqual({
      0: ["10.0.0.1/24", "2001:db8::1/64"],
    });
  });
});
