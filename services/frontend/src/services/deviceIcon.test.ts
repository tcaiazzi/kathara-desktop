import { describe, expect, it } from "vitest";
import { machine } from "../test/fixtures";
import { deviceType } from "./deviceIcon";

const typeOf = (image: string | null) => deviceType(machine({ image }));

describe("deviceType", () => {
  it.each([
    ["kathara/base", "host", "Host"],
    ["kathara/frr", "router", "FRR Router"],
    ["kathara/openvswitch", "switch", "Open vSwitch"],
    ["kathara/pox", "controller", "POX SDN Controller"],
    ["kathara/bind", "dns", "BIND DNS"],
    ["kathara/krill", "security", "Krill RPKI CA"],
  ])("recognizes the Kathara image %s exactly", (image, category, label) => {
    expect(typeOf(image)).toEqual({ category, label });
  });

  it("ignores the registry, the tag and a digest when matching the image name", () => {
    expect(typeOf("docker.io/kathara/frr:9.1")).toEqual({ category: "router", label: "FRR Router" });
    expect(typeOf("kathara/base@sha256:0123abcd")).toEqual({ category: "host", label: "Host" });
    expect(typeOf("KATHARA/BASE")).toEqual({ category: "host", label: "Host" });
  });

  it.each([
    ["lscr.io/linuxserver/wireshark:latest", "analyzer", "Packet Analyzer"],
    ["myorg/ospf-lab", "router", "Router"],
    ["someone/ovs", "switch", "Switch"],
    ["osrg/ryu", "controller", "SDN Controller"],
    ["mvance/unbound", "dns", "DNS"],
    ["nginx:1.27", "server", "Web Server"],
    ["nlnetlabs/routinator-extra", "router", "Router"],
  ])("falls back to a keyword rule for the third-party image %s", (image, category, label) => {
    expect(typeOf(image)).toEqual({ category, label });
  });

  it("labels an unknown image with the image itself", () => {
    expect(typeOf("ubuntu:24.04")).toEqual({ category: "device", label: "ubuntu:24.04" });
  });

  it.each([null, ""])("treats a device without an image (%s) as a generic device", (image) => {
    expect(typeOf(image)).toEqual({ category: "device", label: "Device" });
  });
});
